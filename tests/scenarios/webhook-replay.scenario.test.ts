/**
 * Scenario: Webhook replay dedup.
 *
 * Payment gateways retry webhook delivery on 5xx or timeout — the same
 * `event.id` can arrive multiple times. Revenue MUST be idempotent:
 *
 *   - First delivery updates the transaction and emits `webhook.processed`.
 *   - Replay with identical `event.id` is a no-op — no second update, no
 *     duplicate side-effects — and returns the same transaction unchanged.
 *   - A genuinely new webhook for the same transaction (different id) DOES
 *     process and update.
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
  PaymentIntent,
  PaymentProvider,
  PaymentResult,
  RefundResult,
  REVENUE_EVENTS,
  WebhookEvent,
  type CreateIntentParams,
  type DomainEvent,
} from '../../revenue/src/index.js';

const TIMEOUT = 15000;

/**
 * FakeProvider variant that echoes caller-supplied webhook id/type back. Lets
 * the test assert dedup on `event.id` exactly.
 */
class DeterministicProvider extends PaymentProvider {
  public override readonly name = 'det';
  private store = new Map<string, { amount: number; currency: string }>();

  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `det_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.store.set(id, { amount: params.amount, currency: params.currency ?? 'USD' });
    return new PaymentIntent({
      id, sessionId: id, paymentIntentId: id,
      provider: 'det', status: 'pending',
      amount: params.amount, currency: params.currency, metadata: {},
    });
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const record = this.store.get(intentId);
    return new PaymentResult({
      id: intentId, provider: 'det',
      status: record ? 'succeeded' : 'failed',
      amount: record?.amount, currency: record?.currency,
      paidAt: record ? new Date() : undefined, metadata: {},
    });
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    return new RefundResult({
      id: `ref_${paymentId}`, provider: 'det', status: 'succeeded',
      amount: amount ?? 0, refundedAt: new Date(), metadata: {},
    });
  }

  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const p = payload as { id: string; type: string; sessionId: string };
    return new WebhookEvent({
      id: p.id,
      provider: 'det',
      type: p.type,
      data: { sessionId: p.sessionId },
      createdAt: new Date(),
    });
  }
}

let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
}, TIMEOUT);

afterAll(async () => {
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
});

describe('Scenario: Webhook replay dedup', () => {
  it('second delivery with same event.id is a no-op', async () => {
    if (!mongoAvailable) return;

    const published: DomainEvent[] = [];
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { det: new DeterministicProvider() },
      scope: false,
      forceRecreate: true,
      eventTransport: {
        name: 'test-transport',
        async publish(event) { published.push(event); },
        async subscribe() { return () => {}; },
      },
    });
    await warmModels(engine);

    try {
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 1500, gateway: 'det',
        data: { customerId: 'cust_1' },
      });
      const sessionId = txn.gateway!.sessionId as string;

      // First webhook.
      const firstResult = await engine.repositories.transaction.handleWebhook('det', {
        id: 'evt_stable_001',
        type: 'payment.succeeded',
        sessionId,
      });
      expect(firstResult).not.toBeNull();
      expect(firstResult!.webhook!.eventId).toBe('evt_stable_001');
      const processedCount1 = published.filter(
        e => e.type === REVENUE_EVENTS.WEBHOOK_PROCESSED,
      ).length;
      expect(processedCount1).toBe(1);

      // Replay (same id). Expected: no second publish, no field change.
      const replayResult = await engine.repositories.transaction.handleWebhook('det', {
        id: 'evt_stable_001',
        type: 'payment.succeeded',
        sessionId,
      });
      expect(replayResult).not.toBeNull();
      expect(replayResult!.webhook!.eventId).toBe('evt_stable_001');
      const processedCount2 = published.filter(
        e => e.type === REVENUE_EVENTS.WEBHOOK_PROCESSED,
      ).length;
      expect(processedCount2).toBe(1);

      // A DIFFERENT event id for the same transaction DOES get processed.
      await engine.repositories.transaction.handleWebhook('det', {
        id: 'evt_stable_002',
        type: 'charge.updated',
        sessionId,
      });
      const processedCount3 = published.filter(
        e => e.type === REVENUE_EVENTS.WEBHOOK_PROCESSED,
      ).length;
      expect(processedCount3).toBe(2);
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('returns null when the webhook references an unknown session', async () => {
    if (!mongoAvailable) return;
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { det: new DeterministicProvider() },
      scope: false,
      forceRecreate: true,
    });
    await warmModels(engine);
    try {
      const result = await engine.repositories.transaction.handleWebhook('det', {
        id: 'evt_orphan',
        type: 'payment.succeeded',
        sessionId: 'unknown-session',
      });
      expect(result).toBeNull();
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);
});
