/**
 * FakeProvider — in-memory payment provider for scenario/integration tests.
 *
 * Mirrors the real PaymentProvider contract: createIntent → verify → refund.
 * Supports deterministic failure injection via `setNextOutcome()` so scenarios
 * can exercise retry/failure paths without needing network or real gateway
 * sandboxes.
 */

import { PaymentProvider } from '../../revenue/src/index.js';
import type {
  CreateIntentParams,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

type Outcome = 'succeeded' | 'failed' | 'requires_action';

interface StoreEntry {
  amount: number;
  currency: string;
  status: Outcome;
}

export class FakeProvider extends PaymentProvider {
  public override readonly name = 'fake';
  private store = new Map<string, StoreEntry>();
  private nextOutcome: Outcome = 'succeeded';
  private nextError: Error | null = null;

  constructor() {
    super({});
  }

  /** Force the next verifyPayment / refund call to a specific outcome. */
  setNextOutcome(outcome: Outcome): void {
    this.nextOutcome = outcome;
  }

  /** Force the next createIntent call to throw. Useful for dunning scenarios. */
  failNextIntent(message = 'gateway unavailable'): void {
    this.nextError = new Error(message);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const id = `fake_pi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? 'USD';
    this.store.set(id, {
      amount,
      currency,
      status: 'succeeded',
    });
    return {
      id,
      sessionId: id,
      paymentIntentId: id,
      provider: 'fake',
      status: 'pending',
      amount: { amount, currency },
      metadata: {},
    };
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const record = this.store.get(intentId);
    const outcome = this.nextOutcome;
    this.nextOutcome = 'succeeded';
    if (!record) {
      return {
        id: intentId,
        provider: 'fake',
        status: 'failed',
        metadata: {},
      };
    }
    record.status = outcome;
    return {
      id: intentId,
      provider: 'fake',
      status: outcome,
      amount: { amount: record.amount, currency: record.currency },
      paidAt: outcome === 'succeeded' ? new Date() : undefined,
      metadata: {},
    };
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    return {
      id: `ref_${paymentId}_${Date.now()}`,
      provider: 'fake',
      status: 'succeeded',
      amount: { amount: amount ?? 0, currency: 'USD' },
      refundedAt: new Date(),
      metadata: {},
    };
  }

  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const p = payload as { type?: string; [k: string]: unknown } | null;
    return {
      id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      provider: 'fake',
      type: p?.type ?? 'payment.succeeded',
      data: (p as Record<string, unknown>) ?? {},
      createdAt: new Date(),
    };
  }

  override getCapabilities() {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }
}
