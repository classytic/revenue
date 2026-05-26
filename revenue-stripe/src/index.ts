/**
 * `@classytic/revenue-stripe`
 *
 * Stripe provider package for `@classytic/revenue`. Four subpaths
 * cover the common patterns:
 *
 *   - `@classytic/revenue-stripe/saas`     — SaaS billing (your customer pays you)
 *   - `@classytic/revenue-stripe/connect`  — marketplace (end user pays your customer)
 *   - `@classytic/revenue-stripe/checkout` — lean Checkout-only (no PI, no subs)
 *   - `@classytic/revenue-stripe/webhooks` — shared signature verification + router
 *
 * A host that needs multiple patterns imports multiple subpaths and
 * registers each provider — they share one Stripe SDK key and one
 * webhook endpoint. See subpath READMEs for examples.
 *
 * This root export surfaces only the shared types + the SDK factory
 * for advanced callers. Most consumers should import from a subpath
 * directly so tree-shaking drops the patterns they don't use.
 */

// Stripe SDK factory (advanced — most callers use the provider classes)
export { createStripeClient } from './stripe-client.js';

// Stripe → PaymentMethodKind mapping — host calls this in hosted-checkout
// webhook handlers to backfill the customer's actual choice on the Transaction.
export { stripePaymentMethodToKind, stripePaymentIntentToKind } from './lib/method-kind.js';

// Shared base types — useful for hosts building custom helpers
export type {
  StripeProviderBaseConfig,
  StripeSaasProviderConfig,
  StripeConnectProviderConfig,
  StripeCheckoutProviderConfig,
  StripeIntentOptions,
  StripeRefundOptions,
  PaymentLinkResult,
} from './types.js';
