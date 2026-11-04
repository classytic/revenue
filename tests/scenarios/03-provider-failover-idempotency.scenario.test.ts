import { currencyCode } from '@classytic/primitives/currency';
import { bindRevenue } from '../helpers/bind-revenue.js';
/** A primary timeout retains its command identity across all providers. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';
import {
  PaymentProvider,
  REVENUE_EVENTS,
  IntentOutcomeUnknownError,
  type DomainEvent,
} from '../../revenue/src/index.js';
import type {
  CreateIntentParams,
  ProviderIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

const TIMEOUT = 30000;

/** Primary provider — simulates an outage by throwing for the first N calls. */
class FlakyPrimary extends PaymentProvider {
  /**
   * A TEST double has no real signature to verify, so it says so EXPLICITLY.
   *
   * `verifyWebhookSignature` is abstract on `PaymentProvider` precisely so this
   * answer is stated per provider rather than inherited: the base used to default to
   * accept-all, which meant a provider that forgot to override accepted any signature
   * on the call that transitions a payment.
   */
  verifyWebhookSignature(): boolean {
    return true;
  }

  public override readonly name = 'stripe';
  public intentAttempts = 0;
  private failUntil = 1;
  private store = new Map<string, { amount: number }>();

  constructor() { super({}); }

  failFirstNCreateCalls(n: number) { this.failUntil = n; }

  async createIntent(params: CreateIntentParams): Promise<ProviderIntent> {
    this.intentAttempts += 1;
    if (this.intentAttempts <= this.failUntil) {
      throw new Error('stripe gateway 503 service unavailable');
    }
    const id = `stripe_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? 'USD';
    this.store.set(id, { amount });
    return {
      id, sessionId: id, paymentIntentId: id,
      provider: 'stripe', status: 'requires_payment_method',
      amount: { amount, currency }, metadata: {},
    };
  }

  async verifyPayment(id: string): Promise<PaymentResult> {
    const r = this.store.get(id);
    return {
      id, provider: 'stripe', status: this.store.has(id) ? 'succeeded' : 'failed',
      amount: r ? { amount: r.amount, currency: currencyCode('USD') } : undefined, metadata: {},
    };
  }
  async getStatus(id: string): Promise<PaymentResult> { return this.verifyPayment(id); }
  async refund(id: string, amount?: number | null): Promise<RefundResult> {
    return { id: `r_${id}`, provider: 'stripe', status: 'succeeded', amount: { amount: amount ?? 0, currency: currencyCode('USD') }, metadata: {} };
  }
  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const p = payload as { id: string; type: string; sessionId: string };
    return {
      id: p.id, provider: 'stripe', type: p.type,
      data: { sessionId: p.sessionId }, createdAt: new Date(),
    };
  }
}

/** Fallback provider — always succeeds. */
class FallbackSslcz extends PaymentProvider {
  /**
   * A TEST double has no real signature to verify, so it says so EXPLICITLY.
   *
   * `verifyWebhookSignature` is abstract on `PaymentProvider` precisely so this
   * answer is stated per provider rather than inherited: the base used to default to
   * accept-all, which meant a provider that forgot to override accepted any signature
   * on the call that transitions a payment.
   */
  verifyWebhookSignature(): boolean {
    return true;
  }

  public override readonly name = 'sslcommerz';
  public intentAttempts = 0;
  private store = new Map<string, { amount: number }>();
  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<ProviderIntent> {
    this.intentAttempts += 1;
    const id = `sslcz_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? 'USD';
    this.store.set(id, { amount });
    return {
      id, sessionId: id, paymentIntentId: id,
      provider: 'sslcommerz', status: 'requires_payment_method',
      amount: { amount, currency }, metadata: {},
    };
  }
  async verifyPayment(id: string): Promise<PaymentResult> {
    const r = this.store.get(id);
    return {
      id, provider: 'sslcommerz', status: this.store.has(id) ? 'succeeded' : 'failed',
      amount: r ? { amount: r.amount, currency: currencyCode('BDT') } : undefined, metadata: {},
    };
  }
  async getStatus(id: string): Promise<PaymentResult> { return this.verifyPayment(id); }
  async refund(id: string, amount?: number | null): Promise<RefundResult> {
    return { id: `r_${id}`, provider: 'sslcommerz', status: 'succeeded', amount: { amount: amount ?? 0, currency: currencyCode('BDT') }, metadata: {} };
  }
  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const p = payload as { id: string; type: string; sessionId: string };
    return {
      id: p.id, provider: 'sslcommerz', type: p.type,
      data: { sessionId: p.sessionId }, createdAt: new Date(),
    };
  }
}

let mongoAvailable = false;
beforeAll(async () => { mongoAvailable = await connectToMongoDB(); }, TIMEOUT);
afterAll(async () => { await disconnectFromMongoDB(); });
beforeEach(async () => { if (mongoAvailable) await clearCollections(); });

describe('Scenario 03 — Provider changes cannot fork an unresolved command', () => {
  it('blocks failover while the primary creation outcome is unknown', async () => {
    expect(mongoAvailable).toBe(true);
    const primary = new FlakyPrimary(); const fallback = new FallbackSslcz();
    primary.failFirstNCreateCalls(1);
    const engine = bindRevenue({ connection: mongoose.connection, defaultCurrency: 'BDT', providers: { stripe: primary, sslcommerz: fallback }, scope: false, forceRecreate: true });
    await warmModels(engine); await engine.models.PaymentAttempt.init();
    try {
      const input = { amount: 100000, gateway: 'stripe', methodKind: 'card' as const, data: { customerId: 'buyer_fo' }, idempotencyKey: 'order_OX42' };
      await expect(engine.repositories.transaction.createPaymentIntent(input)).rejects.toThrow(IntentOutcomeUnknownError);
      await expect(engine.repositories.transaction.createPaymentIntent({ ...input, gateway: 'sslcommerz' })).rejects.toMatchObject({ code: 'revenue.intent.conflict', status: 409 });
      expect(primary.intentAttempts).toBe(1); expect(fallback.intentAttempts).toBe(0);
      expect(await engine.repositories.transaction.count({ idempotencyKey: input.idempotencyKey })).toBe(0);
      expect(await engine.repositories.paymentAttempt.count({ operation: 'create-intent', idempotencyKey: input.idempotencyKey })).toBe(1);
    } finally { await engine.close(); }
  }, TIMEOUT);

  it('replays identical facts and rejects a changed provider after creation', async () => {
    expect(mongoAvailable).toBe(true);
    const primary = new FlakyPrimary(); const fallback = new FallbackSslcz();
    const engine = bindRevenue({ connection: mongoose.connection, defaultCurrency: 'BDT', providers: { stripe: primary, sslcommerz: fallback }, scope: false, forceRecreate: true });
    await warmModels(engine); await engine.models.PaymentAttempt.init();
    try {
      const input = { amount: 100000, gateway: 'sslcommerz', methodKind: 'card' as const, data: { customerId: 'buyer_fo' }, idempotencyKey: 'order_REPLAY' };
      const first = await engine.repositories.transaction.createPaymentIntent(input);
      expect(String((await engine.repositories.transaction.createPaymentIntent(input))._id)).toBe(String(first._id));
      await expect(engine.repositories.transaction.createPaymentIntent({ ...input, gateway: 'stripe' })).rejects.toMatchObject({ status: 409 });
      expect(primary.intentAttempts).toBe(0); expect(fallback.intentAttempts).toBe(1);
    } finally { await engine.close(); }
  }, TIMEOUT);

  it('late webhook from the recovered primary for an orphan session is a no-op', async () => {
    if (!mongoAvailable) return;

    const primary = new FlakyPrimary();
    const fallback = new FallbackSslcz();

    const engine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'BDT',
      providers: { stripe: primary, sslcommerz: fallback },
      scope: false,
      forceRecreate: true,
    });
    await warmModels(engine);

    try {
      // This independent command used the secondary from the start.
      const captured = await engine.repositories.transaction.createPaymentIntent({
        amount: 50000, gateway: 'sslcommerz', methodKind: 'card',
        data: { customerId: 'buyer_late_wh' },
        idempotencyKey: 'order_LATE1',
      });
      expect(captured.method).toBe('sslcommerz');

      // Primary recovers and ships a webhook for a session_id that revenue
      // never saw (primary created the intent on their side after the 500 but
      // the client abandoned and re-routed to sslcommerz)
      const result = await engine.repositories.transaction.handleWebhook('stripe', {
        id: 'evt_stripe_ghost',
        type: 'payment_intent.succeeded',
        sessionId: 'stripe_pi_ghost_never_stored',
      });
      expect(result).toBeNull();

      // No corruption: the sslcommerz-captured transaction is still the only one
      const rows = await engine.repositories.transaction.count({
        idempotencyKey: 'order_LATE1',
      });
      expect(rows).toBe(1);
    } finally {
      await engine.close();
    }
  }, TIMEOUT);
});
