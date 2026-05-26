/**
 * Provider configuration + Stripe-flavoured option types.
 *
 * Keep gateway-specific knobs (Connect account routing, platform fee,
 * webhook secret) typed here so callers get IDE help without spelunking
 * through Stripe's union types.
 */

import type Stripe from 'stripe';

/**
 * Shared base config for every Stripe provider in this package.
 * Specific providers extend this with their own knobs.
 */
export interface StripeProviderBaseConfig {
  /** Stripe secret key (`sk_test_…` / `sk_live_…`). Optional when `stripe` is supplied. */
  secretKey?: string;
  /**
   * Optional Stripe API version override. Defaults to the SDK pinned
   * version. Pass a Stripe-published version date string like
   * `'2024-12-18.acacia'`.
   */
  apiVersion?: string;
  /** Webhook signing secret (`whsec_…`) for `verifyWebhookSignature`. */
  webhookSecret?: string;
  /** Default currency. Engine pushes this to `provider.defaultCurrency`. */
  defaultCurrency?: string;
  /**
   * Pre-built Stripe SDK client (DI hook for tests + custom retry/timeout
   * configs, or sharing one SDK across multiple providers). Construction
   * wins over `secretKey` when both supplied.
   */
  stripe?: Stripe;
  /** Pass-through configuration keys. */
  [key: string]: unknown;
}

/**
 * Constructor config for {@link StripeSaasProvider} (`/saas` subpath).
 *
 * Use when the platform is the merchant — your customer pays YOU. No
 * Connect routing, no platform fee, no destination charges. Common
 * case: charging orgs for their SaaS plan, metering usage, addons.
 */
export interface StripeSaasProviderConfig extends StripeProviderBaseConfig {
  // No SaaS-specific knobs today — exported as its own interface so
  // future additions (default usage-record action, statement
  // descriptor preset, etc.) land without breaking callers.
}

/**
 * Constructor config for {@link StripeConnectProvider} (`/connect` subpath).
 *
 * Use when an end user pays YOUR CUSTOMER (marketplace pattern) and
 * you optionally take an `application_fee_amount` cut.
 *
 * `platformFeePercent` is the default cut applied when callers don't
 * override per-intent; supply `0` for direct charges (no fee).
 */
export interface StripeConnectProviderConfig extends StripeProviderBaseConfig {
  /** Platform fee % (0–100) applied to `application_fee_amount`. Default 1. */
  platformFeePercent?: number;
}

/**
 * Constructor config for {@link StripeCheckoutProvider} (`/checkout` subpath).
 *
 * Lean Checkout-Session-only provider for hosts that just need a
 * "redirect user to Stripe-hosted payment page" surface (no Payment
 * Intents, no Connect). Mirrors clinic's existing pattern.
 */
export interface StripeCheckoutProviderConfig extends StripeProviderBaseConfig {
  /** Default success URL — overrideable per checkout session. */
  successUrl?: string;
  /** Default cancel URL — overrideable per checkout session. */
  cancelUrl?: string;
}

/**
 * Per-call Stripe knobs accepted on `createIntent({ stripe: ... })`.
 *
 * Engine treats this as opaque `[key: string]: unknown` on
 * `CreateIntentParams`. Provider strips and forwards the documented
 * keys; unknown keys are ignored.
 */
export interface StripeIntentOptions {
  /** Connected account ID — required for Connect destination charges. */
  connectedAccountId?: string;
  /** Override default platform fee % for this charge. */
  platformFeePercent?: number;
  /** Stripe-managed customer id (`cus_…`). */
  customerId?: string;
  /** Existing payment method id for off-session capture. */
  paymentMethodId?: string;
  /** Payment-method types (`['card']`, `['card', 'us_bank_account']`, …). */
  paymentMethodTypes?: string[];
  /** Description shown on the Stripe dashboard + receipts. */
  description?: string;
  /** Statement descriptor (capped at 22 chars by Stripe). */
  statementDescriptor?: string;
  /** Capture method — `'automatic'` (default) or `'manual'`. */
  captureMethod?: 'automatic' | 'manual';
  /** `true` → off-session charge (saved card). */
  offSession?: boolean;
}

/**
 * Per-call refund knobs.
 */
export interface StripeRefundOptions {
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer' | string;
  currency?: string;
  metadata?: Record<string, unknown>;
  /** Reverse the Connect transfer when refunding from a destination charge. */
  reverseTransfer?: boolean;
  /** Refund the application fee too. Default true when fee was charged. */
  refundApplicationFee?: boolean;
}

/**
 * Result shape from {@link generatePaymentLink}. Hosts persist `url`
 * (send to customer) + `id` (correlate webhook events).
 */
export interface PaymentLinkResult {
  id: string;
  url: string;
  active: boolean;
  raw: Stripe.PaymentLink;
}