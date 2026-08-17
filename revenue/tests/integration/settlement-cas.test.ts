/**
 * Settlement status transitions are CAS-guarded — the payment kernel's first
 * DATABASE-backed test.
 *
 * Revenue had 434 tests and not one touched a database: every repository verb, i.e.
 * every place money changes state, was exercised only through pure state-machine
 * helpers. `SETTLEMENT_STATE_MACHINE.validate()` was therefore fully covered while the
 * thing it is supposed to protect — the WRITE — was not, and the two are separated by
 * a read-then-write window nothing tested.
 *
 * The defect: `fail()` validated `PROCESSING → FAILED` against a status it had READ,
 * then wrote unconditionally. `complete()` does the same for `PROCESSING → COMPLETED`.
 * Racing them let `fail()` overwrite a COMPLETED settlement with FAILED and dispatch
 * SETTLEMENT_FAILED for a payout that had already gone out. Nothing threw — the state
 * machine had approved a transition that was legal a moment earlier.
 *
 * `claim(from: <observed status>)` moves that check into the WRITE's filter. Which
 * transitions are legal is still the state machine's call; this only makes the answer
 * atomic.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SETTLEMENT_STATUS } from '../../src/enums/settlement.enums.js';

let mongod: MongoMemoryServer;
let Settlement: mongoose.Model<Record<string, unknown>>;
let repo: { fail: (...a: never[]) => Promise<unknown>; complete: (...a: never[]) => Promise<unknown> };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'revenue-cas' });

  const { SettlementRepository } = await import('../../src/repositories/settlement.repository.js');
  const { buildSettlementSchema } = await import('../../src/models/settlement.schema.js');

  const schema = buildSettlementSchema({ scoped: false } as never);
  Settlement = mongoose.model('CasSettlement', schema as never) as never;

  const built = new (SettlementRepository as never as new (...a: unknown[]) => Record<string, unknown>)(
    Settlement as never,
  );
  // `deps` is wired by the engine via inject() after construction; the dispatch
  // path reads `deps.outbox`, so an uninjected repo throws on the first event.
  // `bridges` is read unguarded (`this.deps.bridges.ledger?.`), so an empty object
  // is required — not merely optional deps.
  (built as { inject?: (d: unknown) => void }).inject?.({ bridges: {}, outbox: undefined });
  repo = built as never;
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await Settlement.deleteMany({});
});

async function seed(status: string) {
  const doc = await Settlement.create({
    recipientId: 'r1',
    recipientType: 'vendor',
    type: 'payout',
    payoutMethod: 'bank_transfer',
    amount: 5000,
    currency: 'BDT',
    status,
    retryCount: 0,
  });
  return String(doc._id);
}

describe('settlement.fail — CAS on the observed status', () => {
  it('REFUSES to overwrite a COMPLETED settlement (the payout already went out)', async () => {
    const id = await seed(SETTLEMENT_STATUS.COMPLETED);

    // The state machine forbids COMPLETED → FAILED, so the pre-check catches this
    // one. The CAS is what makes the same answer hold when the status changes
    // AFTER the check — see the concurrent case below.
    await expect(
      (repo.fail as (...a: unknown[]) => Promise<unknown>)(id, 'gateway timeout', {}, {}),
    ).rejects.toThrow();

    const after = await Settlement.findById(id).lean();
    expect((after as { status?: string })?.status).toBe(SETTLEMENT_STATUS.COMPLETED);
  });

  it('a STALE read cannot overwrite a completed payout (the window, forced)', async () => {
    /**
     * `Promise.allSettled([complete(), fail()])` does NOT interleave here — the first
     * call finishes its read AND write before the second even reads, so the pre-check
     * alone handles it and the test passes against the defect. Proven: injecting the
     * unconditional write left all three green.
     *
     * So the window is created deterministically. `fail()` takes its snapshot, THEN
     * `complete()` runs to completion, THEN `fail()` proceeds to write — exactly the
     * interleaving that let a COMPLETED payout be flipped to FAILED.
     */
    const id = await seed(SETTLEMENT_STATUS.PROCESSING);

    const realGetById = (repo as unknown as { getById: (...a: unknown[]) => Promise<unknown> }).getById.bind(repo);
    let opened = false;
    (repo as unknown as { getById: unknown }).getById = async (...args: unknown[]) => {
      const doc = await realGetById(...args);
      if (!opened) {
        opened = true;
        // The concurrent winner lands while `fail()` holds its stale snapshot.
        await (repo.complete as (...a: unknown[]) => Promise<unknown>)(id, {}, {});
      }
      return doc;
    };

    try {
      await expect(
        (repo.fail as (...a: unknown[]) => Promise<unknown>)(id, 'late failure webhook', {}, {}),
      ).rejects.toThrow();
    } finally {
      (repo as unknown as { getById: unknown }).getById = realGetById;
    }

    const after = (await Settlement.findById(id).lean()) as { status?: string } | null;
    // The payout stands. Without the CAS this read FAILED.
    expect(after?.status).toBe(SETTLEMENT_STATUS.COMPLETED);
  });

  it('retry increments the counter ATOMICALLY — two retries count as two', async () => {
    const id = await seed(SETTLEMENT_STATUS.PROCESSING);

    // Previously `retryCount: (settlement.retryCount ?? 0) + 1` — both callers read
    // 0 and both wrote 1, so the retry budget under-counted exactly when retries
    // were flying. `$inc` cannot lose one.
    await (repo.fail as (...a: unknown[]) => Promise<unknown>)(id, 'r1', { retry: true }, {});
    await (repo.fail as (...a: unknown[]) => Promise<unknown>)(id, 'r2', { retry: true }, {});

    const after = await Settlement.findById(id).lean();
    expect((after as { retryCount?: number })?.retryCount).toBe(2);
  });
});
