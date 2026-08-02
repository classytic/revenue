/**
 * `refund` — reverses a captured ProviderIntent.
 *
 * Accepts the same `paymentId` shape revenue gives us (the Stripe
 * `pi_…` id). Optional `amount` for partial refunds; omitted = full.
 *
 * For Connect destination charges, the host typically wants both the
 * funds AND the application fee reversed; we default to true on both
 * when the underlying charge was a destination charge, but callers can
 * override via `options.reverseTransfer` / `options.refundApplicationFee`.
 */

import type Stripe from 'stripe';
import type { PaymentCommandContext } from '@classytic/primitives/payment-gateway';
import type { RefundResult } from '@classytic/primitives/payment-gateway';
import type { StripeRefundOptions } from '../types.js';

export interface RefundDeps {
  stripe: Stripe;
  defaultCurrency: string;
}

export async function refund(
  deps: RefundDeps,
  paymentId: string,
  amount: number | null | undefined,
  command: PaymentCommandContext,
  options: StripeRefundOptions = {},
): Promise<RefundResult> {
  const createParams: Stripe.RefundCreateParams = {
    payment_intent: paymentId,
    metadata: toStringMetadata(options.metadata),
  };
  if (amount !== null && amount !== undefined && amount > 0) createParams.amount = amount;
  if (options.reason && isStripeRefundReason(options.reason)) createParams.reason = options.reason;
  if (options.reverseTransfer !== undefined) createParams.reverse_transfer = options.reverseTransfer;
  if (options.refundApplicationFee !== undefined)
    createParams.refund_application_fee = options.refundApplicationFee;

  /**
   * The idempotency key is forwarded to STRIPE, not merely accepted.
   *
   * It previously was not — the port documented Stripe as the provider that "MUST forward
   * it" and this adapter dropped it silently, so a retried refund created a SECOND one at
   * the gateway. The engine's local claim stopped a retry it could see; it could do nothing
   * about a client or proxy retrying the HTTP request underneath.
   *
   * Stripe replays the original response for 24h against the same key, which is precisely
   * the window a timeout-driven retry falls in.
   */
  const refundObj = await deps.stripe.refunds.create(createParams, {
    idempotencyKey: command.idempotencyKey,
  });

  return {
    id: refundObj.id,
    provider: 'stripe',
    status: mapRefundStatus(refundObj.status),
    amount: {
      amount: refundObj.amount,
      currency: (refundObj.currency ?? options.currency ?? deps.defaultCurrency).toUpperCase(),
    },
    refundedAt: new Date(refundObj.created * 1000),
    reason: options.reason ?? refundObj.reason ?? undefined,
    metadata: options.metadata ?? {},
    raw: refundObj,
  };
}

// Stripe types `Refund.status` as `string | null` (open union), so we
// keep this signature liberal and match on the known values.
function mapRefundStatus(status: string | null | undefined): RefundResult['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'pending':
      return 'pending';
    case 'requires_action':
      return 'requires_action';
    case 'canceled':
      return 'canceled';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

const STRIPE_REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);
function isStripeRefundReason(reason: string): reason is Stripe.RefundCreateParams.Reason {
  return STRIPE_REFUND_REASONS.has(reason);
}

function toStringMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}