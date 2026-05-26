/**
 * Helpers for extracting WebhookEvent enrichment fields (signature
 * timestamp, livemode flag, connected-account id) from Stripe events.
 *
 * Kept separate so every provider (saas/connect/checkout) populates the
 * same shape — engine-side consumers can replay/route without branching
 * on which subpackage produced the event.
 */

import type Stripe from 'stripe';

/** Pulls the `t=<unix>` claim out of Stripe's signature header. */
export function parseSignatureTimestamp(signature: string | undefined): Date | undefined {
  if (!signature) return undefined;
  for (const part of signature.split(',')) {
    const [k, v] = part.split('=');
    if (k?.trim() === 't' && v) {
      const secs = Number(v);
      if (Number.isFinite(secs)) return new Date(secs * 1000);
    }
  }
  return undefined;
}

export interface WebhookEnrichment {
  signature?: string;
  signatureTimestamp?: Date;
  accountId?: string;
  livemode?: boolean;
}

export function buildWebhookEnrichment(
  event: Stripe.Event,
  signature: string | undefined,
): WebhookEnrichment {
  return {
    ...(signature ? { signature } : {}),
    ...(parseSignatureTimestamp(signature)
      ? { signatureTimestamp: parseSignatureTimestamp(signature) }
      : {}),
    ...(event.account ? { accountId: event.account } : {}),
    livemode: event.livemode,
  };
}
