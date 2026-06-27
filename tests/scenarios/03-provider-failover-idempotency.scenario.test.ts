/**
 * Scenario 03 — Multi-provider failover with preserved idempotency key.
 *
 * Real-world: Stripe is returning 500s on `createIntent`. The host's retry
 * policy falls back to SSLCOMMERZ with the SAME idempotency key (the order id).
 * After SSLCOMMERZ captures, Stripe eventually recovers and retroactively
 * delivers a webhook for the original attempt (Stripe may have created the
 * intent on their side even though the client saw a 500).
 *
 *   - First attempt: primary provider throws — no transaction written.
 *   - Retry with same idempotencyKey on the fallback: creates one transaction,
 *     returns it.
 *   - Second retry on fallback with SAME idempotencyKey: returns the EXISTING
 *     transaction; no duplicate write; no duplicate event.
 *   - Late webhook from the recovered PRIMARY provider for an unknown session:
 *     returns null (no transaction found), no side-effects.
 *   - Transaction count for that idempotencyKey is exactly 1.
 *
 * Competitor gap: Multi-provider resilience is manual in Stripe, Adyen, and
 * Recurly — you own the idempotency ledger yourself. Revenue's repository
 * returns the existing transaction from a prior `idempotencyKey` match before
 * ever touching the provider, so failover loops and retry storms can't
 * double-charge.
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
  REVENUE_EVENTS,
  type DomainEvent,
} from '../../revenue/src/index.js';
import type {
  CreateIntentParams,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

const TIMEOUT = 30000;

/** Primary provider — simulates an outage by throwing for the first N calls. */
class FlakyPrimary extends PaymentProvider {
  public override readonly name = 'stripe';
  public intentAttempts = 0;
  private failUntil = 1;
  private store = new Map<string, { amount: number }>();

  constructor() { super({}); }

  failFirstNCreateCalls(n: number) { this.failUntil = n; }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
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
      amount: r ? { amount: r.amount, currency: 'USD' } : undefined, metadata: {},
    };
  }
  async getStatus(id: string): Promise<PaymentResult> { return this.verifyPayment(id); }
  async refund(id: string, amount?: number | null): Promise<RefundResult> {
    return { id: `r_${id}`, provider: 'stripe', status: 'succeeded', amount: { amount: amount ?? 0, currency: 'USD' }, metadata: {} };
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
  public override readonly name = 'sslcommerz';
  public intentAttempts = 0;
  private store = new Map<string, { amount: number }>();
  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
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
      amount: r ? { amount: r.amount, currency: 'BDT' } : undefined, metadata: {},
    };
  }
  async getStatus(id: string): Promise<PaymentResult> { return this.verifyPayment(id); }
  async refund(id: string, amount?: number | null): Promise<RefundResult> {
    return { id: `r_${id}`, provider: 'sslcommerz', status: 'succeeded', amount: { amount: amount ?? 0, currency: 'BDT' }, metadata: {} };
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

describe('Scenario 03 — Multi-provider failover preserves idempotency', () => {
  it('falls back to the secondary provider and refuses to double-charge on retry', async () => {
    if (!mongoAvailable) return;

    const published: DomainEvent[] = [];
    const primary = new FlakyPrimary();
    const fallback = new FallbackSslcz();
    primary.failFirstNCreateCalls(1);

    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'BDT',
      providers: { stripe: primary, sslcommerz: fallback },
      scope: false,
      forceRecreate: true,
      eventTransport: {
        name: 't',
        async publish(event) { published.push(event); },
        async subscribe() { return () => {}; },
      },
    });
    await warmModels(engine);

    try {
      const idemKey = 'order_OX42'; // host's order id — stable across providers

      // Attempt 1: primary fails hard, no transaction created
      await expect(
        engine.repositories.transaction.createPaymentIntent({
          amount: 100000, gateway: 'stripe', methodKind: 'card',
          data: { customerId: 'buyer_fo' },
          idempotencyKey: idemKey,
        }),
      ).rejects.toThrow(/503/i);

      const postFailureCount = await engine.repositories.transaction.count({
        idempotencyKey: idemKey,
      });
      expect(postFailureCount).toBe(0);

      // Attempt 2: fallback succeeds — ONE transaction exists under the idemKey
      const firstSuccess = await engine.repositories.transaction.createPaymentIntent({
        amount: 100000, gateway: 'sslcommerz', methodKind: 'card',
        data: { customerId: 'buyer_fo' },
        idempotencyKey: idemKey,
      });
      expect(firstSuccess).not.toBeNull();
      expect(firstSuccess.method).toBe('sslcommerz');
      expect(fallback.intentAttempts).toBe(1);

      // Attempt 3: client retries the fallback with the same idemKey (network
      // hiccup on the response) — MUST return the existing, no extra provider call
      const retried = await engine.repositories.transaction.createPaymentIntent({
        amount: 100000, gateway: 'sslcommerz', methodKind: 'card',
        data: { customerId: 'buyer_fo' },
        idempotencyKey: idemKey,
      });
      expect(String(retried._id)).toBe(String(firstSuccess._id));
      expect(fallback.intentAttempts).toBe(1); // no extra provider call

      // Exactly one row under the idempotency key
      const finalCount = await engine.repositories.transaction.count({
        idempotencyKey: idemKey,
      });
      expect(finalCount).toBe(1);

      // Exactly one monetization.created event
      const created = published.filter(e => e.type === REVENUE_EVENTS.MONETIZATION_CREATED);
      expect(created).toHaveLength(1);

      // Even if client accidentally retries on the PRIMARY with same idemKey,
      // the idempotency check returns the existing row before calling primary
      const crossProviderRetry = await engine.repositories.transaction.createPaymentIntent({
        amount: 100000, gateway: 'stripe', methodKind: 'card',
        data: { customerId: 'buyer_fo' },
        idempotencyKey: idemKey,
      });
      expect(String(crossProviderRetry._id)).toBe(String(firstSuccess._id));
      expect(primary.intentAttempts).toBe(1); // primary NOT re-hit — still just the initial 503
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('late webhook from the recovered primary for an orphan session is a no-op', async () => {
    if (!mongoAvailable) return;

    const primary = new FlakyPrimary();
    const fallback = new FallbackSslcz();

    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'BDT',
      providers: { stripe: primary, sslcommerz: fallback },
      scope: false,
      forceRecreate: true,
    });
    await warmModels(engine);

    try {
      // Fallback captured the order — primary was never able to write to revenue
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
      await engine.destroy();
    }
  }, TIMEOUT);
});
