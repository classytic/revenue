/**
 * Stripe → `PaymentMethodKind` mapping.
 *
 * Stripe's `PaymentMethod.type` values are a moving target — new wallets,
 * bank-debit schemes, and BNPL providers ship every quarter. This module
 * is the single place we collapse Stripe's catalogue down to the engine's
 * canonical `PaymentMethodKind` enum so hosts never need to write a
 * switch statement themselves.
 *
 * Unknown / future Stripe types collapse to `'other'` so an outdated
 * mapping never throws at runtime — the host's analytics may bucket
 * them imprecisely until this table is updated, but transactions
 * still settle.
 *
 * Reference: https://docs.stripe.com/api/payment_methods/object#payment_method_object-type
 */

import type { PaymentMethodKind } from '@classytic/primitives/payment-method-kind';

const CARD_TYPES = new Set<string>(['card', 'card_present']);

// Bank debit schemes — mandate-based pull from a customer bank account.
const DIRECT_DEBIT_TYPES = new Set<string>([
  'us_bank_account',
  'sepa_debit',
  'bacs_debit',
  'au_becs_debit',
  'acss_debit',
]);

// Bank credit flows — customer pushes funds (or pre-funded balance).
const BANK_TRANSFER_TYPES = new Set<string>([
  'customer_balance',
  'sepa_credit_transfer',
]);

// Real-time / instant bank rails (each region's "tap to pay from bank").
const INSTANT_BANK_TRANSFER_TYPES = new Set<string>([
  'sofort',
  'ideal',
  'giropay',
  'eps',
  'bancontact',
  'p24',
  'fpx',
  'grabpay',
  'paynow',
  'promptpay',
  'blik',
  'multibanco',
]);

const WALLET_TYPES = new Set<string>([
  'apple_pay',
  'google_pay',
  'link',
  'wechat_pay',
  'alipay',
  'cashapp',
  'revolut_pay',
  'samsung_pay',
  'paypal',
]);

const BNPL_TYPES = new Set<string>(['klarna', 'afterpay_clearpay', 'affirm']);

// Voucher-print + cash-pay-at-retailer flows.
const CASH_VOUCHER_TYPES = new Set<string>(['oxxo', 'boleto', 'konbini']);

const CRYPTO_TYPES = new Set<string>(['crypto']);

/**
 * Map a Stripe `PaymentMethod.type` string to the engine's canonical
 * `PaymentMethodKind`. Falls through to `'other'` for unrecognised
 * (or just-shipped) Stripe values — never throws.
 */
export function stripePaymentMethodToKind(stripeType: string): PaymentMethodKind {
  if (CARD_TYPES.has(stripeType)) return 'card';
  if (DIRECT_DEBIT_TYPES.has(stripeType)) return 'direct_debit';
  if (BANK_TRANSFER_TYPES.has(stripeType)) return 'bank_transfer';
  if (INSTANT_BANK_TRANSFER_TYPES.has(stripeType)) return 'instant_bank_transfer';
  if (WALLET_TYPES.has(stripeType)) return 'wallet';
  if (BNPL_TYPES.has(stripeType)) return 'bnpl';
  if (CASH_VOUCHER_TYPES.has(stripeType)) return 'cash';
  if (CRYPTO_TYPES.has(stripeType)) return 'cryptocurrency';
  return 'other';
}

/**
 * Pick the most-specific `PaymentMethodKind` for a Stripe PaymentIntent.
 *
 * Prefers `payment_method.type` (the customer's actual choice, known
 * post-confirmation) over `payment_method_types[0]` (the merchant's
 * accepted list, known at creation). Falls back to `'other'` when
 * neither is available — hosted-checkout intents created before the
 * customer has picked a method are a legitimate `'other'`.
 */
export function stripePaymentIntentToKind(intent: {
  payment_method_types?: string[];
  payment_method?: { type: string } | string | null;
}): PaymentMethodKind {
  const pm = intent.payment_method;
  if (pm && typeof pm === 'object' && typeof pm.type === 'string') {
    return stripePaymentMethodToKind(pm.type);
  }
  const types = intent.payment_method_types;
  if (Array.isArray(types) && types.length > 0 && typeof types[0] === 'string') {
    return stripePaymentMethodToKind(types[0]);
  }
  return 'other';
}
