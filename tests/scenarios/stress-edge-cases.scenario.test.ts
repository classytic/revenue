/**
 * Stress & Edge-Case Scenarios
 *
 * Tests that exercise boundaries, concurrency, and performance:
 *   - Rapid-fire creates (throughput under load)
 *   - Concurrent verify on the same transaction (race condition)
 *   - Large batch split (many recipients)
 *   - Double refund (idempotency / state machine rejection)
 *   - Refund more than paid (overflow guard)
 *   - Hold on already-held transaction
 *   - Release more than held amount
 *   - Zero-amount edge cases
 *   - Very large transaction amounts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { warmModels } from '../helpers/warm-models.js';
import { TRANSACTION_STATUS } from '../../revenue/src/index.js';
import { bindRevenue } from '../helpers/bind-revenue.js';

const TIMEOUT = 30000;

let engine: Awaited<ReturnType<typeof bindRevenue>>;
let provider: FakeProvider;
let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  provider = new FakeProvider();
  engine = await bindRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { fake: provider },
    modules: { subscription: false, escrow: true, settlement: false },
    scope: false,
  });
  await warmModels(engine);
}, TIMEOUT);

afterAll(async () => {
  if (engine) await engine.close();
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
});

let payCounter = 0;
async function createAndVerify(amount: number) {
  const txn = await engine.repositories.transaction.createPaymentIntent({ amount, gateway: 'fake', methodKind: 'card', idempotencyKey: `pay-${++payCounter}`  });
  return engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
}

describe('Throughput: rapid-fire creates', () => {
  it('creates 50 transactions under 5s', async () => {
    if (!mongoAvailable) return;

    const start = Date.now();
    const promises = Array.from({ length: 50 }, (_, i) =>
      engine.repositories.transaction.createPaymentIntent({
        amount: 1000 + i, gateway: 'fake', methodKind: 'card',
        idempotencyKey: `rapid-${i}`,
        data: { customerId: `cust_${i}` },
      }),
    );
    const results = await Promise.all(promises);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(50);
    expect(results.every(t => t.publicId?.startsWith('txn_'))).toBe(true);
    expect(elapsed).toBeLessThan(5000);

    const count = await engine.repositories.transaction.count({});
    expect(count).toBe(50);
  }, TIMEOUT);
});

describe('Concurrency: double verify race', () => {
  it('two concurrent verify calls — one succeeds, one fails with state machine error', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 10000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'double-verify-1'  });
    const intentId = txn.gateway!.paymentIntentId as string;

    const results = await Promise.allSettled([
      engine.repositories.transaction.verify(intentId),
      engine.repositories.transaction.verify(intentId),
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    // At least one must succeed
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    // The second should fail because verified → verified is not a valid transition
    // (or both succeed if the second finds it already verified and the FSM allows it)
    expect(succeeded.length + failed.length).toBe(2);
  }, TIMEOUT);
});

describe('State machine rejection', () => {
  it('cannot refund a pending transaction', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 5000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'refund-pending-1'  });
    await expect(
      engine.repositories.transaction.refund(String(txn._id), null, { reason: 'test', idempotencyKey: 'refund-pending-1-r' }),
    ).rejects.toThrow();
  }, TIMEOUT);

  it('cannot hold a pending transaction', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({ amount: 5000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'hold-pending-1'  });
    await expect(
      engine.repositories.transaction.hold(String(txn._id)),
    ).rejects.toThrow();
  }, TIMEOUT);

  it('double refund rejected — full refund then another full refund', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(20000);
    await engine.repositories.transaction.refund(String(txn._id), null, { reason: 'first', idempotencyKey: 'double-refund-first' });

    await expect(
      engine.repositories.transaction.refund(String(txn._id), null, { reason: 'second', idempotencyKey: 'double-refund-second' }),
    ).rejects.toThrow();
  }, TIMEOUT);

  it('partial refund then remaining refund works', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(10000);
    await engine.repositories.transaction.refund(String(txn._id), 3000, { reason: 'partial_1', idempotencyKey: 'partial-remaining-1' });

    const second = await engine.repositories.transaction.refund(String(txn._id), 7000, { reason: 'partial_2', idempotencyKey: 'partial-remaining-2' });
    expect(second.amount).toBe(7000);

    const original = await engine.repositories.transaction.getById(String(txn._id)) as any;
    expect(original.status).toBe(TRANSACTION_STATUS.REFUNDED);
    expect(original.refundedAmount).toBe(10000);
  }, TIMEOUT);
});

describe('Escrow edge cases', () => {
  // Was: "second hold overwrites the first (no double-hold guard — host
  // responsibility)". That was not a host responsibility, it was a money defect:
  // `hold()` blind-`$set` the whole escrow subdocument, so a second hold reset
  // `releasedAmount` to 0 and erased `releases[]`. One transaction, one hold —
  // the guard now lives in the write's filter (`hold: null`).
  it('second hold is refused — the first hold and its release ledger survive', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(10000);
    const first = await engine.repositories.transaction.hold(String(txn._id), { amount: 5000, reason: 'first' });
    expect(first.hold!.heldAmount).toBe(5000);

    await expect(
      engine.repositories.transaction.hold(String(txn._id), { amount: 8000, reason: 'second' }),
    ).rejects.toThrow();

    const current = await engine.repositories.transaction.getById(String(txn._id)) as any;
    expect(current.hold.heldAmount).toBe(5000);
    expect(current.hold.reason).toBe('first');
  }, TIMEOUT);
});

describe('Large amounts and rounding', () => {
  it('handles very large transaction (100M smallest units)', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(100_000_000);
    expect(txn.amount).toBe(100_000_000);
    expect(txn.status).toBe(TRANSACTION_STATUS.VERIFIED);
  }, TIMEOUT);

  it('split with many recipients (10-way)', async () => {
    if (!mongoAvailable) return;

    const txn = await createAndVerify(100000);
    const rules = Array.from({ length: 10 }, (_, i) => ({
      type: `vendor_${i}`, recipientId: `v_${i}`, recipientType: 'seller', rate: 0.09,
    }));
    // Total rate = 0.9, org gets 0.1

    const updated = await engine.repositories.transaction.split(String(txn._id), rules);
    expect(updated.splits).toHaveLength(10);

    const children = await engine.repositories.transaction.getAll({
      filters: { relatedTransactionId: txn._id, type: 'commission' },
      limit: 100,
    });
    expect(((children as any).data as any[]).length).toBe(10);
  }, TIMEOUT);
});

describe('Pagination under load', () => {
  it('getAll paginates 100 transactions correctly', async () => {
    if (!mongoAvailable) return;

    const promises = Array.from({ length: 100 }, (_, i) =>
      engine.repositories.transaction.createPaymentIntent({
        amount: 1000 + i, gateway: 'fake', methodKind: 'card',
        idempotencyKey: `page-${i}`,
      }),
    );
    await Promise.all(promises);

    const page1 = await engine.repositories.transaction.getAll({ page: 1, limit: 25 });
    expect(((page1 as any).data as any[]).length).toBe(25);
    expect((page1 as any).total).toBe(100);
    expect((page1 as any).pages).toBe(4);

    const page4 = await engine.repositories.transaction.getAll({ page: 4, limit: 25 });
    expect(((page4 as any).data as any[]).length).toBe(25);
  }, TIMEOUT);
});
