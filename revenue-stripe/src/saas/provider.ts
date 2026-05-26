/**
 * StripeSaasProvider — `PaymentProvider` for SaaS billing where YOUR
 * customer pays YOU (no Connect routing, no platform fee, no
 * destination charges).
 *
 * Use this when the platform itself is the merchant — e.g., charging
 * orgs for their Pro tier subscription, metering AI usage, selling
 * addons. If you're charging an end user on BEHALF of your customer
 * (marketplace pattern), use `StripeConnectProvider` from
 * `@classytic/revenue-stripe/connect` instead.
 *
 * Shares the same `lib/` helpers as the Connect provider — the only
 * difference is `platformFeePercent` is always 0 and Connect routing
 * fields are never set on intents.
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
import type { StripeRefundOptions, StripeSaasProviderConfig } from '../types.js';
import { createIntent } from '../lib/charges.js';
import { verifyPayment, paymentIntentToResult } from '../lib/verify.js';
import { refund } from '../lib/refund.js';
import { stripePaymentIntentToKind } from '../lib/method-kind.js';
import { buildWebhookEnrichment } from '../lib/webhook-meta.js';

export class StripeSaasProvider extends PaymentProvider {
  public override readonly name: string = 'stripe-saas';

  /** Stripe SDK instance — public so advanced callers can drop down. */
  public readonly stripe: Stripe;

  /** Webhook signing secret (only required if you use `verifyWebhookSignature`). */
  public readonly webhookSecret?: string;

  constructor(config: StripeSaasProviderConfig) {
    super(config);
    this.stripe = createStripeClient(config);
    this.webhookSecret = config.webhookSecret;
    if (config.defaultCurrency) this.setDefaultCurrency(config.defaultCurrency);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    // SaaS provider never applies platform fee — pass 0 + ignore any
    // accidentally-provided connectedAccountId in stripe options.
    return createIntent(
      {
        stripe: this.stripe,
        defaultCurrency: this.defaultCurrency,
        platformFeePercent: 0,
      },
      params,
    );
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    return verifyPayment({ stripe: this.stripe }, intentId);
  }

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
   * Webhook parsing — handles SaaS-relevant events:
   *   - payment_intent.*  (one-off charges, addons)
   *   - invoice.*         (recurring sub invoices)
   *   - customer.subscription.*  (sub lifecycle)
   *   - checkout.session.completed  (self-serve sub start)
   *
   * If you also use Connect, register a `StripeConnectProvider` alongside
   * and route by `event.account` presence — see `@classytic/revenue-stripe/webhooks`.
   */
  async handleWebhook(
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<WebhookEvent> {
    if (!this.webhookSecret) {
      throw new Error(
        '[revenue-stripe/saas] webhookSecret not configured — cannot verify Stripe webhook',
      );
    }
    const signature = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    if (!signature) {
      throw new Error('[revenue-stripe/saas] missing stripe-signature header');
    }
    const rawBody = payload as Buffer | string;
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);

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
   * PaymentResult without an extra Stripe round-trip.
   */
  static paymentIntentToResult(intent: Stripe.PaymentIntent): PaymentResult {
    return paymentIntentToResult(intent);
  }
}

export default StripeSaasProvider;
