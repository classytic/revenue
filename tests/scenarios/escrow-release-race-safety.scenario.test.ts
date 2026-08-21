/**
 * Scenario: Escrow hold/release money-safety (2026-08-05 audit — CRITICAL).
 *
 * The systemic finding behind both defects: **status is CAS-guarded, money arithmetic
 * is not.** `hold()` and `release()` both decided an amount from a `findOne` and then
 * wrote it, with no predicate on the write. Every test here fails on the pre-fix source.
 *
 *   1. CRITICAL — `release()` read the escrow hold OUTSIDE `withTransaction` and computed
 *      `releasedAmount` from that pre-transaction snapshot. Two concurrent FULL releases of
 *      a 1,000 hold each computed 1,000, each `$set` `releasedAmount = 1000` — so the hold
 *      LOOKED correct afterwards while **two 1,000 outflow transactions had been created**.
 *      The guard is now an `$expr` cap in the FILTER of the same write that applies the
 *      `$inc`, so the loser matches zero documents and its whole transaction aborts.
 *   2. CRITICAL — the same stale snapshot survived a `withTransaction` RETRY: the body
 *      re-ran against a value captured before the first attempt. The authoritative read is
 *      now session-scoped inside the body, so a retry necessarily re-reads.
 *   3. CRITICAL — `hold()` had no guard against an existing hold and `$set` the whole
 *      subdocument, wiping `releases[]` and resetting `releasedAmount` to 0. Money that had
 *      already left escrow became releasable again and nothing threw. The guard
 *      (`hold: null`) is now in the filter.
 *   4. Over-release past `heldAmount` is refused rather than silently recorded.
 */

import { MongoError } from 'mongodb';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bindRevenue } from '../helpers/bind-revenue.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import {
  clearCollections,
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';
import {
  HOLD_STATUS,
  REVENUE_EVENTS,
  TRANSACTION_STATUS,
  ValidationError,
  type DomainEvent,
} from '../../revenue/src/index.js';

const TIMEOUT = 30000;

let engine: Awaited<ReturnType<typeof bindRevenue>>;
let published: DomainEvent[];
let mongoAvailable = false;
let seq = 0;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  published = [];
  engine = await bindRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'BDT',
    providers: { fake: new FakeProvider() },
    modules: { subscription: false, escrow: true, settlement: false },
    scope: false,
    forceRecreate: true,
    commission: { defaultRate: 0, gatewayFeeRate: 0 },
    eventTransport: {
      name: 'capture',
      async publish(event) {
        published.push(event);
      },
      async subscribe() {
        return () => {};
      },
    },
  });
  await warmModels(engine);
}, TIMEOUT);

afterAll(async () => {
  if (engine) await engine.close();
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
  if (published) published.length = 0;
});

/** Create + verify a payment so it is eligible for an escrow hold. */
async function createAndVerify(amount: number) {
  seq += 1;
  const txn = await engine.repositories.transaction.createPaymentIntent({
    amount,
    gateway: 'fake',
    methodKind: 'card',
    idempotencyKey: `escrow-race-${seq}`,
  });
  await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
  return txn;
}

/** Every `escrow_release` outflow child of a parent transaction. */
async function releaseOutflows(parentId: unknown): Promise<Array<{ amount: number }>> {
  const all = await engine.repositories.transaction.getAll({
    filters: { relatedTransactionId: parentId, type: 'escrow_release' },
  });
  return ((all as { data: Array<{ amount: number }> }).data ?? []) as Array<{ amount: number }>;
}

async function reload(id: unknown) {
  return (await engine.repositories.transaction.getById(String(id))) as unknown as {
    hold?: {
      status: string;
      heldAmount: number;
      releasedAmount: number;
      releases: Array<{ amount: number; reason?: string }>;
    };
  };
}

describe('Escrow release — the guard is in the filter', () => {
  it('two concurrent FULL releases create exactly ONE outflow transaction', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(1000);
    await engine.repositories.transaction.hold(String(txn._id), { reason: 'escrow' });

    // Both callers compute "release the whole remaining 1,000". Pre-fix, both wrote
    // `releasedAmount = 1000` (idempotent-LOOKING) and both created a 1,000 payout.
    const results = await Promise.allSettled([
      engine.repositories.transaction.release(String(txn._id), {
        recipientId: 'vendor_A',
        recipientType: 'seller',
        reason: 'concurrent_1',
      }),
      engine.repositories.transaction.release(String(txn._id), {
        recipientId: 'vendor_A',
        recipientType: 'seller',
        reason: 'concurrent_2',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const outflows = await releaseOutflows(txn._id);
    expect(outflows).toHaveLength(1);
    expect(outflows[0]!.amount).toBe(1000);

    const final = await reload(txn._id);
    expect(final.hold!.releasedAmount).toBe(1000);
    expect(final.hold!.status).toBe(HOLD_STATUS.RELEASED);
    expect(final.hold!.releases).toHaveLength(1);

    // Exactly one escrow.released event — the loser's outbox row aborted with it.
    const releasedEvents = published.filter((e) => e.type === REVENUE_EVENTS.ESCROW_RELEASED);
    expect(releasedEvents).toHaveLength(1);
  }, TIMEOUT);

  it('concurrent PARTIAL releases never sum past the held amount', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(1000);
    await engine.repositories.transaction.hold(String(txn._id), { reason: 'escrow' });

    // 3 × 400 against a 1,000 hold: at most two can fit.
    const results = await Promise.allSettled(
      [1, 2, 3].map((n) =>
        engine.repositories.transaction.release(String(txn._id), {
          amount: 400,
          recipientId: `vendor_${n}`,
          recipientType: 'seller',
          reason: `partial_${n}`,
        }),
      ),
    );
    const landed = results.filter((r) => r.status === 'fulfilled').length;
    expect(landed).toBeLessThanOrEqual(2);

    const outflows = await releaseOutflows(txn._id);
    const paidOut = outflows.reduce((sum, o) => sum + o.amount, 0);
    expect(outflows).toHaveLength(landed);
    expect(paidOut).toBe(landed * 400);
    expect(paidOut).toBeLessThanOrEqual(1000);

    const final = await reload(txn._id);
    expect(final.hold!.releasedAmount).toBe(paidOut);
    expect(final.hold!.releases).toHaveLength(landed);
  }, TIMEOUT);

  it('refuses a release that would exceed the held amount (cap enforced, not recorded)', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(1000);
    await engine.repositories.transaction.hold(String(txn._id), { reason: 'escrow' });
    await engine.repositories.transaction.release(String(txn._id), {
      amount: 300,
      recipientId: 'vendor_A',
      recipientType: 'seller',
    });

    // 300 already out; 800 more would be 1,100 against a 1,000 hold. Pre-fix this
    // wrote `releasedAmount = 1100` and created an 800 payout.
    await expect(
      engine.repositories.transaction.release(String(txn._id), {
        amount: 800,
        recipientId: 'vendor_B',
        recipientType: 'seller',
      }),
    ).rejects.toThrow(ValidationError);

    const final = await reload(txn._id);
    expect(final.hold!.releasedAmount).toBe(300);
    expect(final.hold!.releases).toHaveLength(1);
    const outflows = await releaseOutflows(txn._id);
    expect(outflows.reduce((s, o) => s + o.amount, 0)).toBe(300);
  }, TIMEOUT);

  it('re-derives the amount inside the transaction when the pre-read snapshot goes stale', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(1000);
    await engine.repositories.transaction.hold(String(txn._id), { reason: 'escrow' });

    const repo = engine.repositories.transaction as unknown as {
      getById: (id: string, opts?: unknown) => Promise<unknown>;
    };
    const originalGetById = repo.getById.bind(repo);
    let poisoned = false;

    // Between the caller's pre-CAS read and the transaction opening, ANOTHER release
    // of 400 commits. The pre-read snapshot (`releasedAmount: 0`) is now stale — which
    // is exactly the window the old code computed `releaseAmount` in, and then reused
    // verbatim inside `withTransaction` (and on every retry of it).
    repo.getById = async (id: string, opts?: unknown) => {
      const doc = await originalGetById(id, opts);
      if (!poisoned && String(id) === String(txn._id)) {
        poisoned = true;
        repo.getById = originalGetById;
        await engine.repositories.transaction.release(String(txn._id), {
          amount: 400,
          recipientId: 'vendor_interleaved',
          recipientType: 'seller',
          reason: 'interleaved',
        });
      }
      return doc;
    };

    try {
      await engine.repositories.transaction.release(String(txn._id), {
        recipientId: 'vendor_main',
        recipientType: 'seller',
        reason: 'remainder',
      });
    } finally {
      repo.getById = originalGetById;
    }

    // Correct: 400 + 600. Pre-fix: the stale snapshot released a full 1,000 on top of
    // the 400 already paid (1,400 out of a 1,000 hold) AND `$set` erased the 400 record.
    const final = await reload(txn._id);
    expect(final.hold!.releasedAmount).toBe(1000);
    expect(final.hold!.status).toBe(HOLD_STATUS.RELEASED);
    expect(final.hold!.releases).toHaveLength(2);
    expect(final.hold!.releases.map((r) => r.amount).sort((a, b) => a - b)).toEqual([400, 600]);

    const outflows = await releaseOutflows(txn._id);
    expect(outflows.reduce((s, o) => s + o.amount, 0)).toBe(1000);
  }, TIMEOUT);

  it('a withTransaction retry does not double-release', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(1000);
    await engine.repositories.transaction.hold(String(txn._id), { reason: 'escrow' });

    const repo = engine.repositories.transaction as unknown as {
      create: (data: unknown, opts?: unknown) => Promise<unknown>;
    };
    const originalCreate = repo.create.bind(repo);
    let createCalls = 0;

    // Abort the FIRST attempt with a genuine TransientTransactionError so the driver
    // re-runs the whole body. Everything the second attempt writes must be re-derived.
    repo.create = async (data: unknown, opts?: unknown) => {
      createCalls += 1;
      if (createCalls === 1) {
        const transient = new MongoError('synthetic transient failure');
        transient.addErrorLabel('TransientTransactionError');
        throw transient;
      }
      return originalCreate(data, opts);
    };

    try {
      await engine.repositories.transaction.release(String(txn._id), {
        recipientId: 'vendor_A',
        recipientType: 'seller',
        reason: 'retried',
      });
    } finally {
      repo.create = originalCreate;
    }

    expect(createCalls).toBeGreaterThan(1); // the retry really happened

    const final = await reload(txn._id);
    expect(final.hold!.releasedAmount).toBe(1000);
    expect(final.hold!.releases).toHaveLength(1);

    const outflows = await releaseOutflows(txn._id);
    expect(outflows).toHaveLength(1);
    expect(outflows[0]!.amount).toBe(1000);
  }, TIMEOUT);
});

describe('Escrow hold — one hold per transaction', () => {
  it('a second hold does NOT wipe releases[] / releasedAmount', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(10000);
    await engine.repositories.transaction.hold(String(txn._id), { amount: 5000, reason: 'first' });
    await engine.repositories.transaction.release(String(txn._id), {
      amount: 2000,
      recipientId: 'vendor_A',
      recipientType: 'seller',
      reason: 'milestone_1',
    });

    // Pre-fix this `$set` the whole subdocument: heldAmount 8000, releasedAmount 0,
    // releases []. The 2,000 already paid out became releasable a second time.
    await expect(
      engine.repositories.transaction.hold(String(txn._id), { amount: 8000, reason: 'second' }),
    ).rejects.toThrow(ValidationError);

    const final = await reload(txn._id);
    expect(final.hold!.heldAmount).toBe(5000);
    expect(final.hold!.releasedAmount).toBe(2000);
    expect(final.hold!.releases).toHaveLength(1);
    expect(final.hold!.status).toBe(HOLD_STATUS.PARTIALLY_RELEASED);
  }, TIMEOUT);

  it('two concurrent holds: exactly one wins, the other is refused', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(10000);
    const results = await Promise.allSettled([
      engine.repositories.transaction.hold(String(txn._id), { amount: 5000, reason: 'a' }),
      engine.repositories.transaction.hold(String(txn._id), { amount: 8000, reason: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const final = await reload(txn._id);
    expect([5000, 8000]).toContain(final.hold!.heldAmount);
    expect(final.hold!.releasedAmount).toBe(0);

    const heldEvents = published.filter((e) => e.type === REVENUE_EVENTS.ESCROW_HELD);
    expect(heldEvents).toHaveLength(1);
  }, TIMEOUT);

  it('still refuses to hold a non-verified transaction', async () => {
    if (!mongoAvailable) return;
    seq += 1;
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 5000,
      gateway: 'fake',
      methodKind: 'card',
      idempotencyKey: `escrow-race-pending-${seq}`,
    });
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);
    await expect(engine.repositories.transaction.hold(String(txn._id))).rejects.toThrow(
      ValidationError,
    );
  }, TIMEOUT);
});
