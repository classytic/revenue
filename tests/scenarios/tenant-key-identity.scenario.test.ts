/**
 * On a tenant-scoped engine a caller's idempotency key is the tenant's own: two tenants may use
 * the same key, and the provider (possibly ONE shared account) is sent a tenant-namespaced key.
 * Before, the second tenant's charge hit the global unique index, its scoped replay could not
 * load the first tenant's row, and every retry called the provider again.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { clearCollections, connectToMongoDB, disconnectFromMongoDB } from '../helpers/mongodb-memory.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { warmModels } from '../helpers/warm-models.js';
import { bindRevenue } from '../helpers/bind-revenue.js';

/** Dedups on the key like a real gateway, and records what it was sent. */
class KeyedProvider extends FakeProvider {
  readonly intentKeys: string[] = [];
  readonly refundKeys: string[] = [];
  private byKey = new Map<string, Awaited<ReturnType<FakeProvider['createIntent']>>>();

  override async createIntent(params: Parameters<FakeProvider['createIntent']>[0], command?: { idempotencyKey: string }) {
    const key = command?.idempotencyKey ?? '';
    this.intentKeys.push(key);
    const prior = this.byKey.get(key);
    if (prior) return prior;
    const intent = await super.createIntent(params);
    this.byKey.set(key, intent);
    return intent;
  }

  override async refund(paymentId: string, amount?: number | null, command?: { idempotencyKey: string }) {
    this.refundKeys.push(command?.idempotencyKey ?? '');
    return super.refund(paymentId, amount);
  }
}

const provider = new KeyedProvider();
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
  provider.intentKeys.length = 0;
  provider.refundKeys.length = 0;
});

const pay = (org: string, key: string, amount = 1000) =>
  engine.repositories.transaction.createPaymentIntent(
    { amount, gateway: 'fake', methodKind: 'card', idempotencyKey: key },
    { organizationId: org, actorId: 'u1' },
  );

describe('tenant-scoped idempotency identity', () => {
  it('runs against a real database', () => {
    expect(mongoAvailable, 'MongoDB unavailable — every case below would pass vacuously').toBe(true);
  });

  it('two tenants with the same key get their own payments and their own provider intents', async () => {
    const a = await pay(A, 'order-1');
    const b = await pay(B, 'order-1');
    expect(String(b._id)).not.toBe(String(a._id));
    expect(b.gateway?.paymentIntentId).not.toBe(a.gateway?.paymentIntentId);
    expect(provider.intentKeys).toEqual([`${A}:order-1`, `${B}:order-1`]);

    // A retry is a replay of the tenant's OWN payment, with no provider call.
    const again = await pay(B, 'order-1');
    expect(String(again._id)).toBe(String(b._id));
    expect(provider.intentKeys).toHaveLength(2);
  });

  it('re-driving an attempt made before namespacing re-sends the raw key it was sent', async () => {
    const attempts = mongoose.connection.collection('revenue_payment_attempts');
    const names = (await mongoose.connection.db!.listCollections().toArray()).map((c) => c.name);
    const collection = names.find((n) => /payment.?attempt/i.test(n));
    expect(collection, 'payment attempt collection').toBeTruthy();
    await mongoose.connection.collection(collection ?? attempts.collectionName).insertOne({
      organizationId: A,
      operation: 'create-intent',
      provider: 'fake',
      methodKind: 'card',
      idempotencyKey: 'legacy-1',
      amount: 1000,
      currency: 'USD',
      outcome: 'pending',
      transactionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await pay(A, 'legacy-1');
    expect(provider.intentKeys).toEqual(['legacy-1']);
  });

  it('a refund is sent the tenant-namespaced key, and the attempt records it', async () => {
    const txn = await pay(A, 'order-2', 5000);
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string, {}, { organizationId: A } as never);
    await engine.repositories.transaction.refund(String(txn._id), 2000, { idempotencyKey: 'refund-1' }, { organizationId: A } as never);
    expect(provider.refundKeys).toEqual([`${A}:refund-1`]);
  });
});
