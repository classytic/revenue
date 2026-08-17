/**
 * `split()` is fenced — a recipient cannot be paid twice.
 *
 * The verb creates one commission transaction per recipient PLUS a platform-revenue
 * row, then stamped `splits` on the parent with an unconditional write. Nothing keyed
 * the operation, so a second call — a concurrent one, or an ordinary retry after a
 * partial failure — created the whole payout set again and overwrote `splits` with an
 * identical value. The parent then reads as split exactly once while every recipient
 * has been paid twice: the duplicate is invisible from the document the operator
 * would inspect.
 *
 * The fix is ORDERING as much as predicate. The parent claim moves ABOVE the creates
 * so it acts as the fence; guarding only the final update would let the duplicate
 * payouts commit first and then merely refuse to record them.
 *
 * Needs a REPLICA SET — `split()` runs inside `withTransaction`, and a standalone
 * mongod rejects transactions outright.
 */

import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let mongod: MongoMemoryReplSet;
let Transaction: mongoose.Model<Record<string, unknown>>;
let repo: Record<string, (...a: never[]) => Promise<unknown>>;

const RULES = [
  { type: 'vendor', recipientId: 'vendor-1', recipientType: 'vendor', rate: 0.6 },
  { type: 'affiliate', recipientId: 'aff-1', recipientType: 'partner', rate: 0.1 },
];

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri(), { dbName: 'revenue-split' });

  const { TransactionRepository } = await import(
    '../../src/repositories/transaction/transaction.repository.js'
  );
  const { buildTransactionSchema } = await import('../../src/models/transaction.schema.js');

  const schema = buildTransactionSchema({ scoped: false, softDelete: false } as never);
  Transaction = mongoose.model('FenceTransaction', schema as never) as never;

  const built = new (TransactionRepository as never as new (...a: unknown[]) => Record<string, never>)(
    Transaction as never,
  );
  (built as { inject?: (d: unknown) => void }).inject?.({ bridges: {}, commission: { gatewayFeeRate: 0 } });
  repo = built as never;
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await Transaction.deleteMany({});
});

async function seedParent() {
  const doc = await Transaction.create({
    organizationId: 'org-1',
    type: 'payment',
    flow: 'inflow',
    amount: 10000,
    currency: 'BDT',
    fee: 0,
    tax: 0,
    net: 10000,
    method: 'card',
    methodKind: 'card',
    status: 'verified',
  });
  return String(doc._id);
}

const payouts = () => Transaction.countDocuments({ tags: 'split' });

describe('transaction.split — fenced against double payout', () => {
  it('a second split REFUSES, and creates no additional payout rows', async () => {
    const id = await seedParent();

    await (repo.split as (...a: unknown[]) => Promise<unknown>)(id, RULES, {});
    const afterFirst = await payouts();
    expect(afterFirst).toBeGreaterThan(0);

    await expect(
      (repo.split as (...a: unknown[]) => Promise<unknown>)(id, RULES, {}),
    ).rejects.toThrow(/already been split/i);

    // The assertion that matters: the REJECTION must not have left rows behind.
    // Guarding only the final update would fail exactly here.
    expect(await payouts()).toBe(afterFirst);
  });

  it('the parent still carries the FIRST split, unmodified', async () => {
    const id = await seedParent();
    await (repo.split as (...a: unknown[]) => Promise<unknown>)(id, RULES, {});
    const first = (await Transaction.findById(id).lean()) as { splits?: unknown[] } | null;

    await expect(
      (repo.split as (...a: unknown[]) => Promise<unknown>)(id, RULES, {}),
    ).rejects.toThrow();

    const after = (await Transaction.findById(id).lean()) as { splits?: unknown[] } | null;
    expect(after?.splits).toEqual(first?.splits);
  });
});
