/**
 * Stripe Payment Link generator for AI-driven flows.
 *
 * The Spawn agent uses this when a customer wants to pay over WhatsApp
 * or SMS — much simpler than a Checkout Session (no return URL, no
 * webhooks-as-RPC pattern, just a URL you send).
 *
 * Connect: when `connectedAccountId` is supplied we set `on_behalf_of`
 * + `application_fee_percent` so the tenant collects (minus our cut)
 * with funds settled directly to their connected account.
 */

import type Stripe from 'stripe';
import type { PaymentLinkResult } from '../types.js';

export interface GeneratePaymentLinkInput {
  /** Pre-created Stripe Price IDs (`price_…`) + quantities. */
  lineItems: Array<{ price: string; quantity: number }>;
  /** Connect destination (optional — omit for platform-direct charges). */
  connectedAccountId?: string;
  /** Platform fee %. Applied when `connectedAccountId` is set. */
  platformFeePercent?: number;
  /** Pass-through metadata (Stripe stamps it on the resulting PaymentIntent). */
  metadata?: Record<string, string>;
  /** Where the customer lands after paying. */
  afterCompletion?: { type: 'redirect'; url: string } | { type: 'hosted_confirmation' };
}

export interface GeneratePaymentLinkDeps {
  stripe: Stripe;
  defaultPlatformFeePercent: number;
}

export async function generatePaymentLink(
  deps: GeneratePaymentLinkDeps,
  input: GeneratePaymentLinkInput,
): Promise<PaymentLinkResult> {
  const params: Stripe.PaymentLinkCreateParams = {
    line_items: input.lineItems,
    metadata: input.metadata,
  };
  if (input.afterCompletion) {
    params.after_completion =
      input.afterCompletion.type === 'redirect'
        ? { type: 'redirect', redirect: { url: input.afterCompletion.url } }
        : { type: 'hosted_confirmation' };
  }
  if (input.connectedAccountId) {
    params.on_behalf_of = input.connectedAccountId;
    const feePercent = input.platformFeePercent ?? deps.defaultPlatformFeePercent;
    if (feePercent > 0) {
      params.application_fee_percent = feePercent;
      params.transfer_data = { destination: input.connectedAccountId };
    }
  }
  const link = await deps.stripe.paymentLinks.create(params);
  return {
    id: link.id,
    url: link.url,
    active: link.active,
    raw: link,
  };
}