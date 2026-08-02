/**
 * Scenario: PaymentAttempt — durable attempt record written BEFORE provider I/O (phase 3).
 *
 * Proves the phase-3 create-side lifecycle that replaces the phase-1-2
 * require-a-caller-key stopgap:
 *
 *   1. A keyless createPaymentIntent (amount > 0) now SUCCEEDS — the provider
 *      idempotency key is derived from the durable attempt id, so distinct sales
 *      never collide and the caller is no longer forced to supply one.
 *   2. On success, exactly one PaymentAttempt exists, `outcome: 'confirmed'`,
 *      linked to the transaction it produced, carrying the gateway ids.
 *   3. When the provider throws (unobserved outcome), createPaymentIntent raises
 *      IntentOutcomeUnknownError, NO transaction is written, and a PaymentAttempt
 *      row survives with `outcome: 'unknown'` — the orphan is VISIBLE, not lost.
 *   4. A caller-supplied key is honoured on the attempt.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';
import {
  createRevenue,
  PaymentProvider,
  IntentOutcomeUnknownError,
} from '../../revenue/src/index.js';
import type {
  CreateIntentParams,
  PaymentResult,
  ProviderIntent,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

const TIMEOUT = 30000;

class FakeProvider extends PaymentProvider {
  public override readonly name = 'fake';
  public failCreate = false;
  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<ProviderIntent> {
    if (this.failCreate) throw new Error('gateway timeout while creating intent');
    const id = `fake_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id, sessionId: id, paymentIntentId: id,
      provider: 'fake', status: 'requires_payment_method',
      amount: params.amount, metadata: {},
    };
  }
  async verifyPayment(id: string): Promise<PaymentResult> {
    return { id, provider: 'fake', status: 'succeeded', metadata: {} };
  }
  async getStatus(id: string): Promise<PaymentResult> { return this.verifyPayment(id); }
  async refund(id: string, amount?: number | null): Promise<RefundResult> {
    return { id: `r_${id}`, provider: 'fake', status: 'succeeded', amount: { amount: amount ?? 0, currency: 'BDT' }, metadata: {} };
  }
  async handleWebhook(): Promise<WebhookEvent> {
    return { id: 'evt', provider: 'fake', type: 'x', data: {}, createdAt: new Date() };
  }
}

let engine: Awaited<ReturnType<typeof createRevenue>>;
let provider: FakeProvider;
let mongoAvailable = false;

function attempts() {
  return mongoose.connection.db!.collection('revenue_payment_attempts');
}

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  provider = new FakeProvider();
  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'BDT',
    providers: { fake: provider },
    modules: { subscription: false, escrow: false, settlement: false },
    scope: { enabled: false, fieldType: 'string' },
    forceRecreate: true,
  });
  await warmModels(engine);
}, TIMEOUT);

afterAll(async () => {
  if (engine) await engine.destroy();
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) {
    await clearCollections();
    provider.failCreate = false;
  }
});

describe('PaymentAttempt — attempt-before-I/O', () => {
  it('keyless createPaymentIntent succeeds and records one confirmed, linked attempt', async () => {
    if (!mongoAvailable) return;
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 100000, gateway: 'fake', methodKind: 'card',
      data: { customerId: 'buyer_1' },
      // NO idempotencyKey — phase 3 derives one from the attempt id.
    });
    expect(txn).not.toBeNull();

    const rows = await attempts().find({}).toArray();
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.outcome).toBe('confirmed');
    expect(String(a.transactionId)).toBe(String(txn._id));
    expect(a.idempotencyKey).toBe(`attempt:${String(a._id)}`);
    expect(a.gateway?.paymentIntentId).toBeTruthy();
    // The derived key also lands on the transaction (populates the unique index).
    expect((txn as any).idempotencyKey).toBe(`attempt:${String(a._id)}`);
  }, TIMEOUT);

  it('two keyless sales of the same amount do NOT collide (distinct derived keys)', async () => {
    if (!mongoAvailable) return;
    const a = await engine.repositories.transaction.createPaymentIntent({ amount: 100000, gateway: 'fake', methodKind: 'card' });
    const b = await engine.repositories.transaction.createPaymentIntent({ amount: 100000, gateway: 'fake', methodKind: 'card' });
    expect(String(a._id)).not.toBe(String(b._id));
    expect((a as any).idempotencyKey).not.toBe((b as any).idempotencyKey);
    expect(await attempts().countDocuments({})).toBe(2);
  }, TIMEOUT);

  it('an unobserved provider outcome leaves a VISIBLE unknown attempt and no transaction', async () => {
    if (!mongoAvailable) return;
    provider.failCreate = true;

    await expect(
      engine.repositories.transaction.createPaymentIntent({ amount: 50000, gateway: 'fake', methodKind: 'card' }),
    ).rejects.toThrow(IntentOutcomeUnknownError);

    // No transaction — but the attempt survives as the reconciliation anchor.
    expect(await engine.repositories.transaction.count({})).toBe(0);
    const rows = await attempts().find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('unknown');
    expect(rows[0]!.transactionId ?? null).toBeNull();
  }, TIMEOUT);

  it('honours a caller-supplied idempotency key on the attempt', async () => {
    if (!mongoAvailable) return;
    await engine.repositories.transaction.createPaymentIntent({
      amount: 25000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'order_caller_key',
    });
    const rows = await attempts().find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe('order_caller_key');
  }, TIMEOUT);
});
