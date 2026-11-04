/**
 * Stripe refund events → the engine's {@link ProviderRefundSignal}.
 *
 * `refund.created` / `refund.updated` carry the Refund object itself: its own id,
 * THIS refund's amount, its status, and the PaymentIntent it reverses — exactly what
 * the engine needs to record a refund that was issued OUTSIDE it (the Stripe
 * dashboard, the API, a support tool). `charge.refunded` is not used: since API
 * 2022-11-15 a Charge no longer embeds its refunds, so it can't say which refund
 * happened or for how much.
 *
 * Only a SUCCEEDED refund is signalled. A pending refund (bank rails) arrives as
 * `refund.created` with `status: 'pending'` and is signalled later by the
 * `refund.updated` that moves it to `succeeded`; a failed one never is.
 */
import type { ProviderRefundSignal } from '@classytic/primitives/payment-gateway';
import type Stripe from 'stripe';
import { REVENUE_REFUND_CMD_REF } from './refund.js';

const REFUND_EVENTS: ReadonlySet<string> = new Set(['refund.created', 'refund.updated']);

export function refundSignalOf(event: Stripe.Event): ProviderRefundSignal | undefined {
  if (!REFUND_EVENTS.has(event.type)) return undefined;
  const refund = event.data.object as Stripe.Refund;
  if (refund.status !== 'succeeded') return undefined;
  // Stamped by this adapter's own `refund()` — present means the engine initiated it.
  const commandRef = refund.metadata?.[REVENUE_REFUND_CMD_REF];
  return { id: refund.id, amount: refund.amount, ...(commandRef ? { commandRef } : {}) };
}

/** `{ refund }` for a spread into `WebhookEvent.data` — empty when the event reports no completed refund. */
export function withRefundSignal(event: Stripe.Event): { refund?: ProviderRefundSignal } {
  const refund = refundSignalOf(event);
  return refund ? { refund } : {};
}
