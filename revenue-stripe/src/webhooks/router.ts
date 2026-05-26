/**
 * Stripe webhook router with mandatory signature verification.
 *
 * SECURITY: This module is the only public ingress for state mutations
 * driven by Stripe. `stripe.webhooks.constructEvent(rawBody, signature,
 * secret)` MUST be called — it both verifies the HMAC signature and
 * parses the JSON. Skipping verification lets any HTTP caller forge
 * succeeded-payment events, draining the platform.
 *
 * Hosts wire this into a Fastify (or Express) route with raw body
 * parsing (Buffer, not pre-parsed JSON) and the `stripe-signature`
 * header. See README for the Fastify example.
 *
 * The router itself is stateless — handlers passed in by the host are
 * what record events to the database, kick subscriptions, etc.
 */

import type Stripe from 'stripe';

/**
 * Per-event handler hooks. All hooks optional — unset events are
 * acknowledged but no-op. Returning a Promise allows async work
 * (DB writes, fan-out); the router awaits each one.
 */
export interface StripeWebhookHandlers {
  onPaymentIntentSucceeded?: (event: Stripe.Event, data: Stripe.PaymentIntent) => Promise<void>;
  onPaymentIntentFailed?: (event: Stripe.Event, data: Stripe.PaymentIntent) => Promise<void>;
  onPaymentIntentProcessing?: (event: Stripe.Event, data: Stripe.PaymentIntent) => Promise<void>;
  onPaymentIntentRequiresAction?: (event: Stripe.Event, data: Stripe.PaymentIntent) => Promise<void>;
  onChargeRefunded?: (event: Stripe.Event, data: Stripe.Charge) => Promise<void>;
  onChargeSucceeded?: (event: Stripe.Event, data: Stripe.Charge) => Promise<void>;
  /** `charge.captured` — emit `payment.captured` (auth-capture lifecycle). */
  onChargeCaptured?: (event: Stripe.Event, data: Stripe.Charge) => Promise<void>;
  /** `payment_intent.canceled` — emit `payment.auth_voided` when after-auth. */
  onPaymentIntentCanceled?: (event: Stripe.Event, data: Stripe.PaymentIntent) => Promise<void>;
  /** `charge.dispute.created` — emit `payment.disputed`. */
  onChargeDisputeCreated?: (event: Stripe.Event, data: Stripe.Dispute) => Promise<void>;
  /** `charge.dispute.closed` — branch on `status` to emit `dispute_won` / `dispute_lost`. */
  onChargeDisputeClosed?: (event: Stripe.Event, data: Stripe.Dispute) => Promise<void>;
  /** `payout.paid` — emit `payment.settled` once funds hit the merchant bank. */
  onPayoutPaid?: (event: Stripe.Event, data: Stripe.Payout) => Promise<void>;
  onAccountUpdated?: (event: Stripe.Event, data: Stripe.Account) => Promise<void>;
  onAccountApplicationDeauthorized?: (event: Stripe.Event, data: Stripe.Application) => Promise<void>;
  onPaymentLinkCompleted?: (event: Stripe.Event, data: Stripe.PaymentLink) => Promise<void>;
  onCheckoutSessionCompleted?: (event: Stripe.Event, data: Stripe.Checkout.Session) => Promise<void>;
  onInvoicePaid?: (event: Stripe.Event, data: Stripe.Invoice) => Promise<void>;
  onInvoicePaymentFailed?: (event: Stripe.Event, data: Stripe.Invoice) => Promise<void>;
  onCustomerSubscriptionUpdated?: (event: Stripe.Event, data: Stripe.Subscription) => Promise<void>;
  onCustomerSubscriptionDeleted?: (event: Stripe.Event, data: Stripe.Subscription) => Promise<void>;
  /** Catch-all for events not explicitly routed. */
  onUnhandled?: (event: Stripe.Event) => Promise<void>;
}

export interface HandleWebhookResult {
  eventId: string;
  eventType: string;
  handled: boolean;
}

/**
 * Verify + route a Stripe webhook delivery.
 *
 * @throws Error from `stripe.webhooks.constructEvent` when the
 *         signature doesn't validate. Caller MUST surface this as
 *         HTTP 400 — never 200, or Stripe stops retrying real events.
 */
export async function handleStripeWebhook(
  rawBody: Buffer | string,
  signature: string,
  secret: string,
  handlers: StripeWebhookHandlers,
  stripe: Stripe,
): Promise<HandleWebhookResult> {
  // SECURITY: must validate before any branching on event content.
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  return routeStripeEvent(event, handlers);
}

/**
 * Pure routing — exposed for hosts that handle signature verification
 * upstream (e.g. via a Stripe-managed event bus) or for unit tests.
 *
 * Never call this with an un-verified event from an HTTP request.
 */
export async function routeStripeEvent(
  event: Stripe.Event,
  handlers: StripeWebhookHandlers,
): Promise<HandleWebhookResult> {
  let handled = true;
  switch (event.type) {
    case 'payment_intent.succeeded':
      await handlers.onPaymentIntentSucceeded?.(event, event.data.object as Stripe.PaymentIntent);
      handled = !!handlers.onPaymentIntentSucceeded;
      break;
    case 'payment_intent.payment_failed':
      await handlers.onPaymentIntentFailed?.(event, event.data.object as Stripe.PaymentIntent);
      handled = !!handlers.onPaymentIntentFailed;
      break;
    case 'payment_intent.processing':
      await handlers.onPaymentIntentProcessing?.(event, event.data.object as Stripe.PaymentIntent);
      handled = !!handlers.onPaymentIntentProcessing;
      break;
    case 'payment_intent.requires_action':
      await handlers.onPaymentIntentRequiresAction?.(event, event.data.object as Stripe.PaymentIntent);
      handled = !!handlers.onPaymentIntentRequiresAction;
      break;
    case 'charge.refunded':
      await handlers.onChargeRefunded?.(event, event.data.object as Stripe.Charge);
      handled = !!handlers.onChargeRefunded;
      break;
    case 'charge.succeeded':
      await handlers.onChargeSucceeded?.(event, event.data.object as Stripe.Charge);
      handled = !!handlers.onChargeSucceeded;
      break;
    case 'charge.captured':
      await handlers.onChargeCaptured?.(event, event.data.object as Stripe.Charge);
      handled = !!handlers.onChargeCaptured;
      break;
    case 'payment_intent.canceled':
      await handlers.onPaymentIntentCanceled?.(event, event.data.object as Stripe.PaymentIntent);
      handled = !!handlers.onPaymentIntentCanceled;
      break;
    case 'charge.dispute.created':
      await handlers.onChargeDisputeCreated?.(event, event.data.object as Stripe.Dispute);
      handled = !!handlers.onChargeDisputeCreated;
      break;
    case 'charge.dispute.closed':
      await handlers.onChargeDisputeClosed?.(event, event.data.object as Stripe.Dispute);
      handled = !!handlers.onChargeDisputeClosed;
      break;
    case 'payout.paid':
      await handlers.onPayoutPaid?.(event, event.data.object as Stripe.Payout);
      handled = !!handlers.onPayoutPaid;
      break;
    case 'account.updated':
      await handlers.onAccountUpdated?.(event, event.data.object as Stripe.Account);
      handled = !!handlers.onAccountUpdated;
      break;
    case 'account.application.deauthorized':
      await handlers.onAccountApplicationDeauthorized?.(
        event,
        event.data.object as Stripe.Application,
      );
      handled = !!handlers.onAccountApplicationDeauthorized;
      break;
    case 'payment_link.completed' as Stripe.Event.Type:
      await handlers.onPaymentLinkCompleted?.(event, event.data.object as Stripe.PaymentLink);
      handled = !!handlers.onPaymentLinkCompleted;
      break;
    case 'checkout.session.completed':
      await handlers.onCheckoutSessionCompleted?.(
        event,
        event.data.object as Stripe.Checkout.Session,
      );
      handled = !!handlers.onCheckoutSessionCompleted;
      break;
    case 'invoice.paid':
      await handlers.onInvoicePaid?.(event, event.data.object as Stripe.Invoice);
      handled = !!handlers.onInvoicePaid;
      break;
    case 'invoice.payment_failed':
      await handlers.onInvoicePaymentFailed?.(event, event.data.object as Stripe.Invoice);
      handled = !!handlers.onInvoicePaymentFailed;
      break;
    case 'customer.subscription.updated':
      await handlers.onCustomerSubscriptionUpdated?.(
        event,
        event.data.object as Stripe.Subscription,
      );
      handled = !!handlers.onCustomerSubscriptionUpdated;
      break;
    case 'customer.subscription.deleted':
      await handlers.onCustomerSubscriptionDeleted?.(
        event,
        event.data.object as Stripe.Subscription,
      );
      handled = !!handlers.onCustomerSubscriptionDeleted;
      break;
    default:
      await handlers.onUnhandled?.(event);
      handled = false;
  }
  return { eventId: event.id, eventType: event.type, handled };
}