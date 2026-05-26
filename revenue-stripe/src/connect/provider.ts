/**
 * StripeConnectProvider — `PaymentProvider` implementation for Stripe
 * Connect Express + Payment Intents.
 *
 * Mirrors the shape of `@classytic/revenue-manual`'s `ManualProvider`
 * so any host using the revenue engine can swap one for the other via
 * config alone. All gateway calls are delegated to the focused modules
 * under `payments/` and `connect/` — this file is the glue that wires
 * them to the engine's contract.
 */

import type Stripe from 'stripe';
import { PaymentProvider } from '@classytic/revenue';
import type {
  CreateIntentParams,
  PaymentIntent,
  PaymentResult,
  ProviderCapabilities,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';
import { createStripeClient } from '../stripe-client.js';
import type { StripeConnectProviderConfig, StripeRefundOptions } from '../types.js';
import { createIntent } from '../lib/charges.js';
import { verifyPayment, paymentIntentToResult } from '../lib/verify.js';
import { refund } from '../lib/refund.js';
import { stripePaymentIntentToKind } from '../lib/method-kind.js';
import { buildWebhookEnrichment } from '../lib/webhook-meta.js';

const DEFAULT_PLATFORM_FEE_PERCENT = 1;

export class StripeConnectProvider extends PaymentProvider {
  public override readonly name: string = 'stripe';

  /** Stripe SDK instance — public so advanced callers can drop down. */
  public readonly stripe: Stripe;

  /** Webhook signing secret (only required if you use `verifyWebhookSignature`). */
  public readonly webhookSecret?: string;

  /** Default `application_fee_amount` % applied when no per-call override. */
  public readonly platformFeePercent: number;

  constructor(config: StripeConnectProviderConfig) {
    super(config);
    this.stripe = createStripeClient(config);
    this.webhookSecret = config.webhookSecret;
    this.platformFeePercent = config.platformFeePercent ?? DEFAULT_PLATFORM_FEE_PERCENT;
    if (config.defaultCurrency) this.setDefaultCurrency(config.defaultCurrency);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    return createIntent(
      {
        stripe: this.stripe,
        defaultCurrency: this.defaultCurrency,
        platformFeePercent: this.platformFeePercent,
      },
      params,
    );
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    return verifyPayment({ stripe: this.stripe }, intentId);
  }

  /** Status read is identical to verify for PaymentIntents. */
  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(
    paymentId: string,
    amount?: number | null,
    options: StripeRefundOptions = {},
  ): Promise<RefundResult> {
    return refund(
      { stripe: this.stripe, defaultCurrency: this.defaultCurrency },
      paymentId,
      amount,
      options,
    );
  }

  /**
   * Webhook parsing. Engine calls this from its webhook handler with
   * the raw request body + headers. We surface the verified Stripe
   * event in `WebhookEvent.raw` so engine event consumers can inspect
   * it without re-parsing.
   *
   * SECURITY: signature verification IS performed here. Callers MUST
   * pass the raw, untouched HTTP body (Buffer for Fastify with
   * `addContentTypeParser('application/json', ...)`).
   */
  async handleWebhook(
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<WebhookEvent> {
    if (!this.webhookSecret) {
      throw new Error(
        '[revenue-stripe] webhookSecret not configured — cannot verify Stripe webhook',
      );
    }
    const signature = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    if (!signature) {
      throw new Error('[revenue-stripe] missing stripe-signature header');
    }
    const rawBody = payload as Buffer | string;
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);

    // Normalize to engine's WebhookEvent shape. Pull paymentIntentId
    // from the event data where present so the engine can route to
    // the matching Transaction by gateway id.
    const obj = event.data.object as {
      id?: string;
      payment_intent?: string;
      payment_method_types?: string[];
      payment_method?: { type: string } | string | null;
    };
    const paymentIntentId =
      typeof obj.payment_intent === 'string'
        ? obj.payment_intent
        : event.type.startsWith('payment_intent.')
          ? obj.id
          : undefined;
    const methodKind =
      event.type.startsWith('payment_intent.') || event.type === 'charge.succeeded'
        ? stripePaymentIntentToKind(obj)
        : undefined;

    return {
      id: event.id,
      provider: 'stripe',
      type: event.type,
      data: {
        ...(paymentIntentId ? { paymentIntentId } : {}),
        objectId: obj.id,
      },
      ...(methodKind ? { methodKind } : {}),
      createdAt: new Date(event.created * 1000),
      ...buildWebhookEnrichment(event, signature),
      raw: event,
    };
  }

  override verifyWebhookSignature(payload: unknown, signature: string): boolean {
    if (!this.webhookSecret) return false;
    try {
      this.stripe.webhooks.constructEvent(payload as Buffer | string, signature, this.webhookSecret);
      return true;
    } catch {
      return false;
    }
  }

  override getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }

  /**
   * Convenience: turn a verified-by-webhook PaymentIntent into a
   * PaymentResult without an extra Stripe round-trip. Useful for
   * `payment_intent.succeeded` handlers that want to settle the
   * Transaction immediately.
   */
  static paymentIntentToResult(intent: Stripe.PaymentIntent): PaymentResult {
    return paymentIntentToResult(intent);
  }
}

export default StripeConnectProvider;