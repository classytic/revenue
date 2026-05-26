/**
 * `@classytic/revenue-stripe/connect`
 *
 * Stripe Connect Express provider for marketplace patterns — END USERS
 * pay YOUR CUSTOMER (the connected account), optionally with an
 * `application_fee_amount` cut routed to your platform account.
 *
 * Use this when:
 *   - You run a marketplace and your sellers receive payouts directly
 *   - You let your customers issue invoices to their own customers (Xero-style)
 *   - You take a % fee on every charge that flows through your platform
 *
 * If the platform itself is the merchant (SaaS), use
 * `@classytic/revenue-stripe/saas` instead. Both can be registered
 * side-by-side via revenue's provider registry.
 *
 * @example
 * ```ts
 * import { createRevenue } from '@classytic/revenue';
 * import {
 *   StripeConnectProvider,
 *   createExpressAccount,
 *   createAccountLink,
 * } from '@classytic/revenue-stripe/connect';
 *
 * const revenue = createRevenue({
 *   providers: [new StripeConnectProvider({
 *     secretKey: process.env.STRIPE_SECRET_KEY!,
 *     webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
 *     platformFeePercent: 1.5, // 1.5% take rate
 *     defaultCurrency: 'USD',
 *   })],
 * });
 *
 * // Onboard a tenant to receive payments
 * const { accountId } = await createExpressAccount(stripe, {
 *   tenantOrgId: org.id,
 *   email: owner.email,
 *   country: 'US',
 * });
 * const { url } = await createAccountLink(stripe, {
 *   accountId,
 *   returnUrl: 'https://app.example.com/onboarding/done',
 *   refreshUrl: 'https://app.example.com/onboarding/refresh',
 * });
 * res.redirect(url);
 * ```
 */

export { StripeConnectProvider, default } from './provider.js';

// Connect onboarding flow
export {
  createExpressAccount,
  createAccountLink,
  getAccountStatus,
  type CreateAccountInput,
  type CreateAccountResult,
  type CreateAccountLinkInput,
  type CreateAccountLinkResult,
  type AccountStatus,
} from './onboarding.js';

// Account management
export { createLoginLink, getAccountBalance, deleteAccount } from './account.js';

// Payment helpers — Connect mode (with optional platform fee)
export { generatePaymentLink, type GeneratePaymentLinkInput } from '../lib/payment-link.js';
export { computeApplicationFee, createIntent } from '../lib/charges.js';

// Subscription helpers (pass `connectedAccountId` to route at a connected account)
export {
  createSubscription,
  cancelSubscription,
  retrieveSubscription,
  updateSubscription,
  type CreateSubscriptionInput,
} from '../lib/subscriptions.js';

// Refund helper (Connect-aware via options.reverseTransfer)
export { refund } from '../lib/refund.js';

// Verification mappers
export { mapStripeStatus, paymentIntentToResult } from '../lib/verify.js';

// Stripe → PaymentMethodKind mapping (use in hosted-checkout backfill flows)
export { stripePaymentMethodToKind, stripePaymentIntentToKind } from '../lib/method-kind.js';

// Types
export type {
  StripeConnectProviderConfig,
  StripeProviderBaseConfig,
  StripeIntentOptions,
  StripeRefundOptions,
  PaymentLinkResult,
} from '../types.js';

// Stripe SDK factory (advanced)
export { createStripeClient } from '../stripe-client.js';
