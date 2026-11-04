import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { bindRevenue } from '../helpers/bind-revenue.js';
import { clearCollections, connectToMongoDB, disconnectFromMongoDB } from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';
import { FakeProvider } from '../helpers/fake-provider.js';

describe('immutable payment creation identity', () => {
  let engine: ReturnType<typeof bindRevenue>;
  let provider: FakeProvider;
  let creates = 0;
  const input = () => ({ amount: 3000, currency: 'BDT', gateway: 'fake', methodKind: 'mobile_money' as const,
    idempotencyKey: 'collection-command', data: { sourceId: 'order-one', sourceModel: 'Order', customerId: 'buyer-one' },
    metadata: { collection: { obligationId: 'advance' } }, reference: 'REF1',
  });
  const ctx = { organizationId: 'tenant-one' };
  beforeAll(async () => { expect(await connectToMongoDB()).toBe(true); }, 30000);
  beforeEach(async () => {
    await engine?.close(); provider = new FakeProvider();
    creates = 0;
    const create = provider.createIntent.bind(provider);
    provider.createIntent = async params => { creates++; return create(params); };
    engine = bindRevenue({ connection: mongoose.connection, defaultCurrency: 'BDT', providers: { fake: provider },
      scope: { enabled: true, fieldType: 'string' }, forceRecreate: true, modules: { subscription: false, escrow: false, settlement: false } });
    await warmModels(engine); await engine.models.PaymentAttempt.init(); await clearCollections();
  });
  afterAll(async () => { await engine?.close(); await disconnectFromMongoDB(); });

  it('accepts wire-equivalent retries while keeping the creation hash private', async () => {
    const first = await engine.repositories.transaction.createPaymentIntent(input(), ctx);
    const replay = await engine.repositories.transaction.createPaymentIntent({ ...input(), reference: ' REF1 ' }, ctx);
    expect(String(replay._id)).toBe(String(first._id));
    const attempt = await engine.repositories.paymentAttempt.getByQuery({ operation: 'create-intent' }, ctx);
    expect(attempt?.requestFingerprint).toBeUndefined();
    expect(JSON.stringify(attempt)).not.toContain('requestFingerprint');
    const internal = await engine.repositories.paymentAttempt.getByQuery({ operation: 'create-intent' }, { ...ctx, select: '+requestFingerprint' });
    expect(internal?.requestFingerprint).toBeTruthy();
    expect(creates).toBe(1);
  });

  it.each(['amount', 'currency', 'methodKind', 'source', 'customer', 'reference', 'metadata'] as const)('refuses a reused key with changed %s', async field => {
    const original = input(); const first = await engine.repositories.transaction.createPaymentIntent(original, ctx);
    const changed = {
      ...original,
      ...(field === 'amount' ? { amount: 4000 } : {}),
      ...(field === 'currency' ? { currency: 'USD' } : {}),
      ...(field === 'methodKind' ? { methodKind: 'card' as const } : {}),
      ...(field === 'source' ? { data: { ...original.data, sourceId: 'other-order' } } : {}),
      ...(field === 'customer' ? { data: { ...original.data, customerId: 'other-buyer' } } : {}),
      ...(field === 'reference' ? { reference: 'OTHER' } : {}),
      ...(field === 'metadata' ? { metadata: { collection: { obligationId: 'balance' } } } : {}),
    };
    await expect(engine.repositories.transaction.createPaymentIntent(changed, ctx)).rejects.toMatchObject({ code: 'revenue.intent.conflict', status: 409 });
    expect(await engine.repositories.transaction.count({ idempotencyKey: original.idempotencyKey }, ctx)).toBe(1);
    expect((await engine.repositories.transaction.getById(String(first._id), ctx))?.amount).toBe(3000);
    expect(creates).toBe(1);
  });

  it('scopes identical command keys to separate tenants', async () => {
    const first = await engine.repositories.transaction.createPaymentIntent(input(), ctx);
    const second = await engine.repositories.transaction.createPaymentIntent(input(), { organizationId: 'tenant-two' });
    expect(String(first._id)).not.toBe(String(second._id));
    expect(await engine.repositories.paymentAttempt.count({ operation: 'create-intent' }, { bypassTenant: true })).toBe(2);
    expect(creates).toBe(2);
  });

  it('refuses network creation in a caller transaction before claiming an attempt', async () => {
    const session = await mongoose.connection.startSession();
    try {
      await expect(engine.repositories.transaction.createPaymentIntent(input(), { ...ctx, session })).rejects.toThrow(/outside a caller transaction/);
      expect(await engine.repositories.paymentAttempt.count({}, ctx)).toBe(0);
      expect(creates).toBe(0);
    } finally { await session.endSession(); }
  });

  const seed = (over: Record<string, unknown>) => ({ operation: 'create-intent', provider: 'fake', methodKind: 'mobile_money',
    idempotencyKey: 'shared-key', providerKey: 'tenant-one:shared-key', requestFingerprint: 'fp-1', amount: 3000, currency: 'BDT', outcome: 'pending', ...over });

  it('refuses a create-intent attempt that has no request fingerprint or provider key', async () => {
    const { requestFingerprint: _f, providerKey: _p, ...bare } = seed({});
    await expect(engine.repositories.paymentAttempt.create(bare as never, ctx)).rejects.toThrow(/fingerprint/);
    expect(await engine.repositories.paymentAttempt.count({}, ctx)).toBe(0);
  });

  it('does not require a fingerprint or provider key on other operations', async () => {
    const { requestFingerprint: _f, providerKey: _p, ...bare } = seed({ operation: 'refund', idempotencyKey: 'refund-key' });
    await expect(engine.repositories.paymentAttempt.create(bare as never, ctx)).resolves.toBeTruthy();
  });

  it('one create key belongs to one provider: a second provider cannot claim it', async () => {
    await engine.repositories.paymentAttempt.create(seed({}) as never, ctx);
    await expect(engine.repositories.paymentAttempt.create(seed({ provider: 'other', requestFingerprint: 'fp-2' }) as never, ctx)).rejects.toThrow();
    expect(await engine.repositories.paymentAttempt.count({}, ctx)).toBe(1);
  });
});
