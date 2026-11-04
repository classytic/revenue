import { currencyCode } from '@classytic/primitives/currency';
/**
 * `verifyPayment` / `getStatus` — read ProviderIntent state and map to
 * the engine's narrow `PaymentResult.status` union.
 *
 * Stripe's status set is wider than the engine's, so we collapse:
 *   succeeded                                        → 'succeeded'
 *   processing                                       → 'processing'
 *   requires_action | requires_confirmation |
 *     requires_payment_method | requires_capture    → 'requires_action'
 *   canceled                                         → 'failed'
 *   anything else                                    → 'processing' (safe default)
 */

import type Stripe from 'stripe';
import type { PaymentResult, ProviderIntentStatus } from '@classytic/primitives/payment-gateway';
import { stripePaymentIntentToKind } from './method-kind.js';

const PROVIDER_INTENT_STATUSES: ReadonlySet<string> = new Set<ProviderIntentStatus>([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
]);

/**
 * Stripe PaymentIntent status → the engine's closed `ProviderIntentStatus`.
 *
 * stripe-node 23 types `PaymentIntent.status` as an OPEN union (`… | string`):
 * Stripe may add a status without a major. Every status the engine knows
 * passes through unchanged; an unknown one becomes `'processing'` —
 * non-terminal, so it is never read as paid or failed, and verify/webhooks
 * settle it later.
 */
export function mapIntentStatus(status: string): ProviderIntentStatus {
  return PROVIDER_INTENT_STATUSES.has(status) ? (status as ProviderIntentStatus) : 'processing';
}

export interface VerifyDeps {
  stripe: Stripe;
}

export function mapStripeStatus(status: string): PaymentResult['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'processing':
      return 'processing';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_payment_method':
    case 'requires_capture':
      return 'requires_action';
    case 'canceled':
      return 'failed';
    default:
      return 'processing';
  }
}

export async function verifyPayment(
  deps: VerifyDeps,
  intentId: string,
): Promise<PaymentResult> {
  const intent = await deps.stripe.paymentIntents.retrieve(intentId);
  return paymentIntentToResult(intent);
}

/**
 * Convert a Stripe PaymentIntent into the engine's PaymentResult.
 *
 * Exposed so webhook handlers (`payment_intent.succeeded`) can reuse
 * the same mapping when they need to surface a PaymentResult upstream.
 */
export function paymentIntentToResult(intent: Stripe.PaymentIntent): PaymentResult {
  const status = mapStripeStatus(intent.status);
  // `latest_charge` may be present + carries the booked timestamp;
  // fall back to `created` when unavailable.
  let paidAt: Date | undefined;
  if (status === 'succeeded') {
    if (typeof intent.latest_charge === 'object' && intent.latest_charge?.created) {
      paidAt = new Date(intent.latest_charge.created * 1000);
    } else {
      paidAt = new Date(intent.created * 1000);
    }
  }
  const methodKind = stripePaymentIntentToKind(
    intent as unknown as { payment_method_types?: string[]; payment_method?: { type: string } | string | null },
  );
  return {
    id: intent.id,
    provider: 'stripe',
    status,
    amount: {
      amount: intent.amount_received || intent.amount,
      currency: currencyCode(intent.currency.toUpperCase()),
    },
    paidAt,
    methodKind,
    metadata: {
      stripePaymentIntentStatus: intent.status,
      ...(intent.customer ? { customerId: String(intent.customer) } : {}),
    },
    raw: intent,
  };
}