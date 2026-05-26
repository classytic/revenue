/**
 * `@classytic/revenue-stripe/checkout`
 *
 * Lean Stripe-Checkout-Session-only provider. Use when you only need
 * "redirect user to Stripe-hosted payment page, get a webhook when
 * they pay" — no Payment Intents, no Connect, no subscriptions.
 *
 * For SaaS subs use `/saas`. For marketplaces use `/connect`.
 *
 * @example
 * ```ts
 * import { createRevenue } from '@classytic/revenue';
 * import { StripeCheckoutProvider } from '@classytic/revenue-stripe/checkout';
 *
 * const revenue = createRevenue({
 *   providers: [new StripeCheckoutProvider({
 *     secretKey: process.env.STRIPE_SECRET_KEY!,
 *     webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
 *     successUrl: 'https://app.example.com/paid?session_id={CHECKOUT_SESSION_ID}',
 *     cancelUrl: 'https://app.example.com/canceled',
 *     defaultCurrency: 'USD',
 *   })],
 * });
 * ```
 */

export { StripeCheckoutProvider, default } from './provider.js';

// Helpers (shared with /saas — re-exported for callers that import just /checkout)
export {
  createCheckoutSession,
  retrieveCheckoutSession,
  createBillingPortalSession,
  type CreateCheckoutSessionInput,
  type CreateCheckoutSessionResult,
} from '../lib/checkout.js';

export { refund } from '../lib/refund.js';

// Stripe → PaymentMethodKind mapping (use in hosted-checkout backfill flows)
export { stripePaymentMethodToKind, stripePaymentIntentToKind } from '../lib/method-kind.js';

export type {
  StripeCheckoutProviderConfig,
  StripeProviderBaseConfig,
  StripeRefundOptions,
} from '../types.js';

export { createStripeClient } from '../stripe-client.js';
