/**
 * StripeCheckoutProvider — minimal Stripe provider for hosts that ONLY
 * need Stripe-hosted Checkout Sessions (no PaymentIntents, no Connect,
 * no subscriptions).
 *
 * Mirrors the lightweight pattern used in clinic-be (where the host
 * just wants "redirect user to Stripe, get back a webhook when they
 * pay"). The `PaymentProvider.createIntent` contract is satisfied by
 * creating a Checkout Session and surfacing its `id` as the intent id.
 *
 * Use when:
 *   - You want the simplest possible Stripe integration for one-off
 *     purchases (clinic appointments, course bookings, paid downloads)
 *   - You don't need recurring billing or Connect routing
 *
 * For SaaS subs use `/saas`. For marketplaces use `/connect`.
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
import type { StripeCheckoutProviderConfig, StripeRefundOptions } from '../types.js';
import { refund } from '../lib/refund.js';
import { stripePaymentIntentToKind } from '../lib/method-kind.js';
import { buildWebhookEnrichment } from '../lib/webhook-meta.js';

export class StripeCheckoutProvider extends PaymentProvider {
  public override readonly name: string = 'stripe-checkout';

  public readonly stripe: Stripe;
  public readonly webhookSecret?: string;
  public readonly defaultSuccessUrl?: string;
  public readonly defaultCancelUrl?: string;

  constructor(config: StripeCheckoutProviderConfig) {
    super(config);
    this.stripe = createStripeClient(config);
    this.webhookSecret = config.webhookSecret;
    this.defaultSuccessUrl = config.successUrl;
    this.defaultCancelUrl = config.cancelUrl;
    if (config.defaultCurrency) this.setDefaultCurrency(config.defaultCurrency);
  }

  /**
   * Creates a Checkout Session (instead of a bare PaymentIntent). Returns
   * the engine's PaymentIntent shape with the session ID slot populated
   * — the engine persists this as the Transaction's gateway id and
   * matches it on the webhook event.
   *
   * Callers MUST pass `returnUrl` on `CreateIntentParams` (mapped to
   * Stripe's `success_url`), OR configure `successUrl` on the provider.
   */
  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const amountValue = params.amount.amount;
    const currency = (params.amount.currency ?? this.defaultCurrency).toLowerCase();
    const successUrl = params.returnUrl ?? this.defaultSuccessUrl;
    const cancelUrl =
      (params.metadata?.cancelUrl as string | undefined) ?? this.defaultCancelUrl ?? successUrl;
    if (!successUrl) {
      throw new Error(
        '[revenue-stripe/checkout] params.returnUrl or config.successUrl is required',
      );
    }
    if (!cancelUrl) {
      throw new Error(
        '[revenue-stripe/checkout] config.cancelUrl is required (or metadata.cancelUrl per call)',
      );
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amountValue,
            product_data: {
              name:
                (params.metadata?.productName as string | undefined) ??
                (params.metadata?.description as string | undefined) ??
                'Payment',
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: toStringMetadata(params.metadata),
    });

    return {
      id: session.id,
      provider: 'stripe',
      status: 'requires_action', // customer must complete checkout
      amount: { amount: amountValue, currency: currency.toUpperCase() },
      paymentIntentId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id ?? null,
      sessionId: session.id,
      // `url` is the value the host redirects to. Surface via clientSecret
      // slot since the engine's PaymentIntent type doesn't have a `url`.
      clientSecret: session.url ?? undefined,
      metadata: params.metadata ?? {},
      raw: session,
    };
  }

  /**
   * Verify by retrieving the Checkout Session. Status maps from session
   * payment_status — `paid` → 'succeeded'; `unpaid` → 'requires_action'.
   */
  async verifyPayment(sessionId: string): Promise<PaymentResult> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    return checkoutSessionToResult(session);
  }

  async getStatus(sessionId: string): Promise<PaymentResult> {
    return this.verifyPayment(sessionId);
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
   * Webhook parsing — handles Checkout-relevant events:
   *   - checkout.session.completed
   *   - charge.refunded
   * Other events pass through as no-ops.
   */
  async handleWebhook(
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<WebhookEvent> {
    if (!this.webhookSecret) {
      throw new Error(
        '[revenue-stripe/checkout] webhookSecret not configured — cannot verify Stripe webhook',
      );
    }
    const signature = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    if (!signature) {
      throw new Error('[revenue-stripe/checkout] missing stripe-signature header');
    }
    const rawBody = payload as Buffer | string;
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);

    const obj = event.data.object as {
      id?: string;
      payment_intent?: string | { id?: string; payment_method_types?: string[]; payment_method?: { type: string } | string | null };
      payment_method_types?: string[];
      payment_method?: { type: string } | string | null;
    };
    const paymentIntentId =
      typeof obj.payment_intent === 'string'
        ? obj.payment_intent
        : typeof obj.payment_intent === 'object' && obj.payment_intent
          ? obj.payment_intent.id
          : event.type.startsWith('payment_intent.')
            ? obj.id
            : undefined;
    // `checkout.session.completed` ships the expanded PaymentIntent on
    // `payment_intent` when the session has one — pull the kind from
    // there so hosts get the customer's actual selection.
    let methodKind: ReturnType<typeof stripePaymentIntentToKind> | undefined;
    if (event.type.startsWith('payment_intent.') || event.type === 'charge.succeeded') {
      methodKind = stripePaymentIntentToKind(obj);
    } else if (event.type === 'checkout.session.completed' && typeof obj.payment_intent === 'object' && obj.payment_intent) {
      methodKind = stripePaymentIntentToKind(obj.payment_intent);
    }

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
}

function checkoutSessionToResult(session: Stripe.Checkout.Session): PaymentResult {
  const paid = session.payment_status === 'paid';
  return {
    id: session.id,
    provider: 'stripe',
    status: paid ? 'succeeded' : 'requires_action',
    amount: {
      amount: session.amount_total ?? 0,
      currency: (session.currency ?? 'usd').toUpperCase(),
    },
    paidAt: paid && session.created ? new Date(session.created * 1000) : undefined,
    metadata: {
      checkoutSessionStatus: session.status ?? '',
      paymentStatus: session.payment_status,
      ...(session.customer ? { customerId: String(session.customer) } : {}),
    },
    raw: session,
  };
}

function toStringMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

export default StripeCheckoutProvider;
