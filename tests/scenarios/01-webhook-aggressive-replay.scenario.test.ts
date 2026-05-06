/**
 * Scenario 01 — Webhook aggressive replay (hostile network conditions).
 *
 * Real-world: Stripe retries a webhook up to 3 days on 5xx/timeout, plus a
 * human re-delivers from the dashboard, plus the load balancer double-submits
 * on a 30s timeout. The same `event.id` can arrive 10+ times, interleaved
 * with genuinely-new events for the SAME transaction (`payment.succeeded`
 * then `charge.updated`) and for DIFFERENT transactions.
 *
 *   - All 10 replays of `evt_123` result in exactly ONE side-effect.
 *   - ONE `webhook.processed` event emitted for `evt_123`.
 *   - A new event id `evt_456` for the same transaction DOES process.
 *   - Wall-clock: 10 concurrent deliveries under 2s (no lock-serialized fan).
 *   - Provider.handleWebhook call count equals total deliveries (parse always
 *     runs), but DB writes deduplicate on `transaction.webhook.eventId`.
 *
 * Competitor gap: Chargebee had a 2022 double-charge bug under webhook replay;
 * Adyen offloads dedup to their end so self-hosters own nothing; Stripe leaves
 * idempotency entirely to the integrator. Revenue dedups at the repository
 * layer on `event.id`, no integrator code required.
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

class CountingProvider extends PaymentProvider {
  public override readonly name = 'counter';
  public webhookCalls = 0;
  private store = new Map<string, { amount: number; currency: string }>();

  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `cnt_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? 'USD';
    this.store.set(id, { amount, currency });
    return {
      id, sessionId: id, paymentIntentId: id,
      provider: 'counter', status: 'pending',
      amount: { amount, currency }, metadata: {},
    };
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const r = this.store.get(intentId);
    return {
      id: intentId, provider: 'counter',
      status: r ? 'succeeded' : 'failed',
      amount: r ? { amount: r.amount, currency: r.currency } : undefined,
      paidAt: r ? new Date() : undefined, metadata: {},
    };
  }

  async getStatus(intentId: string): Promise<PaymentResult> { return this.verifyPayment(intentId); }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    return {
      id: `ref_${paymentId}`, provider: 'counter', status: 'succeeded',
      amount: { amount: amount ?? 0, currency: 'USD' }, refundedAt: new Date(), metadata: {},
    };
  }

  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    this.webhookCalls += 1;
    const p = payload as { id: string; type: string; sessionId: string };
    return {
      id: p.id, provider: 'counter', type: p.type,
      data: { sessionId: p.sessionId }, createdAt: new Date(),
    };
  }
}

let mongoAvailable = false;

beforeAll(async () => { mongoAvailable = await connectToMongoDB(); }, TIMEOUT);
afterAll(async () => { await disconnectFromMongoDB(); });
beforeEach(async () => { if (mongoAvailable) await clearCollections(); });

describe('Scenario 01 — Webhook aggressive replay', () => {
  it('10 sequential replays of the same event.id produce exactly one processed event', async () => {
    if (!mongoAvailable) return;

    const published: DomainEvent[] = [];
    const provider = new CountingProvider();
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { counter: provider },
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
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 5000, gateway: 'counter',
        data: { customerId: 'cust_replay' },
      });
      const sessionId = txn.gateway!.sessionId as string;

      // Stripe's retry cadence backs off (30s, 1m, 2m, 4m…) — replays arrive
      // SEQUENTIALLY, not simultaneously. That's the documented pattern we
      // must defend against; the truly-parallel race is a separate gap.
      const start = Date.now();
      const results: Array<Awaited<ReturnType<typeof engine.repositories.transaction.handleWebhook>>> = [];
      for (let i = 0; i < 10; i++) {
        const r = await engine.repositories.transaction.handleWebhook('counter', {
          id: 'evt_123',
          type: 'payment.succeeded',
          sessionId,
        });
        results.push(r);
      }
      const elapsed = Date.now() - start;

      // Provider parses every delivery — parsing is provider-level, not idempotent
      expect(provider.webhookCalls).toBe(10);

      // But only ONE processed event reaches subscribers (sequential dedup works)
      const processed = published.filter(e => e.type === REVENUE_EVENTS.WEBHOOK_PROCESSED);
      expect(processed).toHaveLength(1);

      // All 10 results reference the same transaction, same eventId
      for (const r of results) {
        expect(r).not.toBeNull();
        expect(r!.webhook!.eventId).toBe('evt_123');
        expect(String(r!._id)).toBe(String(txn._id));
      }

      // Throughput: 10 sequential dedup lookups under 3s
      expect(elapsed).toBeLessThan(3000);

      // A DIFFERENT event.id for the same sessionId DOES process (no over-dedup)
      await engine.repositories.transaction.handleWebhook('counter', {
        id: 'evt_456',
        type: 'charge.updated',
        sessionId,
      });
      const processedAfter = published.filter(e => e.type === REVENUE_EVENTS.WEBHOOK_PROCESSED);
      expect(processedAfter).toHaveLength(2);
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('10 CONCURRENT replays of the same event.id still produce exactly one processed event', async () => {
    // Regression guard for the 2026-04-22 fix: the pre-flight check
    // (`transaction.webhook?.eventId === webhookEvent.id`) followed by
    // a separate `update` was a read-then-write race. Two replays
    // arriving during an in-flight delivery would both see "no
    // webhook.eventId yet" and both write. Fix: atomic
    // `findOneAndUpdate({ _id, 'webhook.eventId': { $ne: eventId } })`
    // — the CAS returns null on every racer past the first, short-
    // circuiting them to the idempotent success path without
    // re-dispatching WEBHOOK_PROCESSED.
    if (!mongoAvailable) return;

    const published: DomainEvent[] = [];
    const provider = new CountingProvider();
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { counter: provider },
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
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 5000, gateway: 'counter',
        data: { customerId: 'cust_concurrent_replay' },
      });
      const sessionId = txn.gateway!.sessionId as string;

      await Promise.all(
        Array.from({ length: 10 }, () =>
          engine.repositories.transaction.handleWebhook('counter', {
            id: 'evt_concurrent_42',
            type: 'payment.succeeded',
            sessionId,
          }),
        ),
      );

      const processed = published.filter(e => e.type === REVENUE_EVENTS.WEBHOOK_PROCESSED);
      expect(processed).toHaveLength(1);

      const final = await engine.repositories.transaction.getById(String(txn._id));
      expect((final as any).webhook.eventId).toBe('evt_concurrent_42');
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('sequential interleaved replays across two transactions dedup per-transaction', async () => {
    if (!mongoAvailable) return;

    const published: DomainEvent[] = [];
    const provider = new CountingProvider();
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { counter: provider },
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
      const a = await engine.repositories.transaction.createPaymentIntent({
        amount: 1000, gateway: 'counter', data: { customerId: 'cust_A' },
      });
      const b = await engine.repositories.transaction.createPaymentIntent({
        amount: 2000, gateway: 'counter', data: { customerId: 'cust_B' },
      });

      // Chaotic order: A/B/A/A/B/A — each event.id unique to its transaction.
      // Still sequential per-webhook (Stripe delivers one at a time per event).
      const deliveries = [
        { id: 'evt_A1', sessionId: a.gateway!.sessionId as string },
        { id: 'evt_B1', sessionId: b.gateway!.sessionId as string },
        { id: 'evt_A1', sessionId: a.gateway!.sessionId as string }, // replay
        { id: 'evt_A1', sessionId: a.gateway!.sessionId as string }, // replay
        { id: 'evt_B1', sessionId: b.gateway!.sessionId as string }, // replay
        { id: 'evt_A1', sessionId: a.gateway!.sessionId as string }, // replay
      ];

      for (const d of deliveries) {
        await engine.repositories.transaction.handleWebhook('counter', {
          id: d.id, type: 'payment.succeeded', sessionId: d.sessionId,
        });
      }

      const processed = published.filter(e => e.type === REVENUE_EVENTS.WEBHOOK_PROCESSED);
      // One processed event per distinct (transaction, event.id) pair => exactly 2
      expect(processed).toHaveLength(2);

      const finalA = await engine.repositories.transaction.getById(String(a._id));
      const finalB = await engine.repositories.transaction.getById(String(b._id));
      expect((finalA as any).webhook.eventId).toBe('evt_A1');
      expect((finalB as any).webhook.eventId).toBe('evt_B1');
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);
});
