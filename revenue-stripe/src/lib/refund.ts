import { currencyCode } from '@classytic/primitives/currency';
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

import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import type {
  PaymentCommandContext,
  PaymentResult,
  RefundResult,
  RefundStatusQuery,
} from '@classytic/primitives/payment-gateway';
import type { StripeRefundOptions } from '../types.js';

export interface RefundDeps {
  stripe: Stripe;
  defaultCurrency: string;
}

/**
 * Stripe metadata key carrying a STABLE, deterministic reference derived from the refund
 * command's idempotency key. Stamped at refund-create time so `getRefundStatus` can find
 * OUR refund among a PaymentIntent's refunds when a timeout left us without the refund id —
 * the authoritative match that lets reconciliation avoid ever reading the PaymentIntent's
 * own status (a captured intent says nothing about whether THIS refund succeeded).
 */
export const REVENUE_REFUND_CMD_REF = 'revenue_refund_cmd_ref';

/** Deterministic, collision-resistant, ≤500-char Stripe-metadata-safe command reference. */
export function refundCommandRef(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40);
}

export async function refund(
  deps: RefundDeps,
  paymentId: string,
  amount: number | null | undefined,
  command: PaymentCommandContext,
  options: StripeRefundOptions = {},
): Promise<RefundResult> {
  // Stamp the stable command ref into the refund's metadata so a later `getRefundStatus`
  // can match THIS refund on the PaymentIntent even if the create response was lost.
  const stampedMetadata = {
    ...(toStringMetadata(options.metadata) ?? {}),
    ...(command.idempotencyKey
      ? { [REVENUE_REFUND_CMD_REF]: refundCommandRef(command.idempotencyKey) }
      : {}),
  };
  const createParams: Stripe.RefundCreateParams = {
    payment_intent: paymentId,
    metadata: stampedMetadata,
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
      currency: currencyCode(
        (refundObj.currency ?? options.currency ?? deps.defaultCurrency).toUpperCase(),
      ),
    },
    refundedAt: new Date(refundObj.created * 1000),
    reason: options.reason ?? refundObj.reason ?? undefined,
    metadata: options.metadata ?? {},
    raw: refundObj,
  };
}

/**
 * Query the authoritative status of a REFUND (never the PaymentIntent). Used by the engine's
 * reconciliation when a refund's create response was lost (timeout → `unknown`).
 *
 * Resolution order:
 *   1. `refundRef` known  → `refunds.retrieve` — direct and authoritative.
 *   2. otherwise          → list the PaymentIntent's refunds and match OUR stamped
 *                           `REVENUE_REFUND_CMD_REF`. The intent's own status is deliberately
 *                           NOT consulted — a captured intent tells us nothing about whether
 *                           this particular refund went through.
 *   3. no match           → `processing` (uncertain). The engine RETAINS the reservation;
 *                           it never frees the amount on a guess, which would risk a double
 *                           refund. Only a definitive `succeeded`/`failed` moves money.
 */
export async function getRefundStatus(
  deps: RefundDeps,
  query: RefundStatusQuery,
): Promise<PaymentResult> {
  if (query.refundRef) {
    const r = await deps.stripe.refunds.retrieve(query.refundRef);
    return refundToPaymentResult(r, deps.defaultCurrency);
  }
  const wanted = refundCommandRef(query.idempotencyKey);
  const list = await deps.stripe.refunds.list({ payment_intent: query.paymentId, limit: 100 });
  const match = list.data.find((r) => r.metadata?.[REVENUE_REFUND_CMD_REF] === wanted);
  if (match) return refundToPaymentResult(match, deps.defaultCurrency);
  return { id: query.idempotencyKey, provider: 'stripe', status: 'processing', metadata: {} };
}

/**
 * Map a Stripe `Refund` to the port's `PaymentResult` for reconciliation:
 *   - `succeeded`                → `succeeded` (engine finalizes: reserved → refunded)
 *   - `failed` / `canceled`      → `failed`    (engine releases the reservation — no money moved)
 *   - `pending` / `requires_action` / unknown → `processing` (engine RETAINS — still uncertain)
 */
function refundToPaymentResult(r: Stripe.Refund, defaultCurrency: string): PaymentResult {
  const status: PaymentResult['status'] =
    r.status === 'succeeded'
      ? 'succeeded'
      : r.status === 'failed' || r.status === 'canceled'
        ? 'failed'
        : 'processing';
  return {
    id: r.id,
    provider: 'stripe',
    status,
    amount: {
      amount: r.amount,
      currency: currencyCode((r.currency ?? defaultCurrency).toUpperCase()),
    },
    metadata: { refundStatus: r.status ?? '' },
    raw: r,
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