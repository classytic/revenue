/**
 * `transaction.refund` under org B on org A's transaction is NOT FOUND: no provider call,
 * no reservation, no refund attempt, A's transaction byte-for-byte unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { clearCollections, connectToMongoDB, disconnectFromMongoDB } from '../helpers/mongodb-memory.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { warmModels } from '../helpers/warm-models.js';
import { bindRevenue } from '../helpers/bind-revenue.js';
import { TransactionNotFoundError } from '../../revenue/src/core/errors.js';

class CountingProvider extends FakeProvider {
  readonly refundCalls: string[] = [];
  override async refund(paymentId: string, amount?: number | null) {
    this.refundCalls.push(paymentId);
    return super.refund(paymentId, amount);
  }
}

const provider = new CountingProvider();
let engine: Awaited<ReturnType<typeof bindRevenue>>;
let mongoAvailable = false;
const A = 'branch_a';
const B = 'branch_b';

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  engine = await bindRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { fake: provider },
    scope: { enabled: true, fieldType: 'string', required: true },
    modules: { subscription: false, escrow: false, settlement: false },
    commission: { defaultRate: 0, gatewayFeeRate: 0 },
  });
  await warmModels(engine);
}, 30_000);

afterAll(async () => {
  if (engine) await engine.close();
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (!mongoAvailable) return;
  await clearCollections();
  provider.refundCalls.length = 0;
});

async function verifiedPaymentFor(org: string, key: string, amount = 5000) {
  const txn = await engine.repositories.transaction.createPaymentIntent(
    { amount, gateway: 'fake', methodKind: 'card', idempotencyKey: key },
    { organizationId: org, actorId: 'u1' },
  );
  await engine.repositories.transaction.verify(
    txn.gateway!.paymentIntentId as string,
    {},
    { organizationId: org } as never,
  );
  return txn;
}

const txnCollection = () => engine.models.Transaction.collection;
const attemptCollection = () => engine.models.PaymentAttempt.collection;

describe('refund tenant isolation', () => {
  it('runs against a real database', () => {
    expect(mongoAvailable, 'MongoDB unavailable — every case below would pass vacuously').toBe(true);
  });

  it("org B refunding org A's transaction is not-found, with no provider call and A unchanged", async () => {
    const txn = await verifiedPaymentFor(A, 'order-a');
    const before = await txnCollection().findOne({ _id: txn._id });
    expect(before?.organizationId).toBe(A);
    expect(['verified', 'completed']).toContain(before?.status);
    const attemptsBefore = await attemptCollection().countDocuments({ operation: 'refund' });

    const err = await engine.repositories.transaction
      .refund(String(txn._id), 2000, { idempotencyKey: 'refund-x' }, { organizationId: B } as never)
      .then(() => null, (e: unknown) => e);

    // soft: a regression reports every broken guarantee, not just the first.
    expect.soft(provider.refundCalls, 'provider must not be contacted').toEqual([]);
    const after = await txnCollection().findOne({ _id: txn._id });
    expect.soft(after, "A's transaction must be unchanged").toEqual(before);
    expect.soft(await attemptCollection().countDocuments({ operation: 'refund' })).toBe(attemptsBefore);
    expect.soft(await txnCollection().countDocuments({ type: 'refund' })).toBe(0);
    expect.soft(err).toBeInstanceOf(TransactionNotFoundError);
    expect.soft((err as TransactionNotFoundError | null)?.code).toBe('TRANSACTION_NOT_FOUND');
  });

  it("org A refunding its own transaction reaches the provider (positive control)", async () => {
    const txn = await verifiedPaymentFor(A, 'order-a2');
    await engine.repositories.transaction.refund(
      String(txn._id), 2000, { idempotencyKey: 'refund-own' }, { organizationId: A } as never,
    );
    expect(provider.refundCalls).toHaveLength(1);
  });
});
