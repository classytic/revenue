/**
 * `@classytic/revenue-stripe/saas`
 *
 * Stripe provider for SaaS billing — YOUR customer pays YOU. No Connect
 * routing, no platform fees, no destination charges. Use this for:
 *
 *   - Charging orgs for their Pro plan
 *   - Self-serve subscription start via Stripe Checkout
 *   - Metered AI usage billing (usage records on subscription items)
 *   - One-off addon purchases
 *
 * If you're charging an end user on BEHALF of your customer
 * (marketplace), use `@classytic/revenue-stripe/connect` instead. Both
 * can be registered side-by-side via revenue's provider registry.
 *
 * @example
 * ```ts
 * import { createRevenue } from '@classytic/revenue';
 * import { StripeSaasProvider, createCheckoutSession } from '@classytic/revenue-stripe/saas';
 *
 * const revenue = createRevenue({
 *   providers: [new StripeSaasProvider({
 *     secretKey: process.env.STRIPE_SECRET_KEY!,
 *     webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
 *     defaultCurrency: 'USD',
 *   })],
 * });
 *
 * // Self-serve sub start
 * const session = await createCheckoutSession(stripe, {
 *   mode: 'subscription',
 *   lineItems: [{ price: 'price_pro_monthly', quantity: 1 }],
 *   successUrl: 'https://app.example.com/billing?session_id={CHECKOUT_SESSION_ID}',
 *   cancelUrl: 'https://app.example.com/billing',
 *   customerEmail: user.email,
 *   metadata: { organizationId: org.id },
 *   trialPeriodDays: 14,
 * });
 * res.redirect(session.url);
 * ```
 */

export { StripeSaasProvider, default } from './provider.js';

// Subscription lifecycle helpers (mode-agnostic; SaaS uses them without
// connectedAccountId, Connect provider uses them with it)
export {
  createSubscription,
  cancelSubscription,
  retrieveSubscription,
  updateSubscription,
  type CreateSubscriptionInput,
} from '../lib/subscriptions.js';

// Checkout Session helpers (self-serve flow + customer portal)
export {
  createCheckoutSession,
  retrieveCheckoutSession,
  createBillingPortalSession,
  type CreateCheckoutSessionInput,
  type CreateCheckoutSessionResult,
} from '../lib/checkout.js';

// One-off charge helper (addon purchases, top-ups)
export { createIntent } from '../lib/charges.js';

// Refund helper
export { refund } from '../lib/refund.js';

// Verification mappers (use these in webhook handlers to settle Transactions immediately)
export { mapStripeStatus, paymentIntentToResult } from '../lib/verify.js';

// Stripe → PaymentMethodKind mapping (use in hosted-checkout backfill flows)
export { stripePaymentMethodToKind, stripePaymentIntentToKind } from '../lib/method-kind.js';

// Types
export type {
  StripeSaasProviderConfig,
  StripeProviderBaseConfig,
  StripeIntentOptions,
  StripeRefundOptions,
} from '../types.js';

// Stripe SDK factory (advanced — most callers go through the provider class)
export { createStripeClient } from '../stripe-client.js';
