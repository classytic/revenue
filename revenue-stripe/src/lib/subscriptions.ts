/**
 * Thin wrapper over `stripe.subscriptions.*` for recurring services
 * (memberships, monthly retainers, SaaS-style billing on top of a
 * tenant's connected account).
 *
 * Kept intentionally small — most callers will use `stripe.*` directly
 * for advanced use cases. The wrapper exists so:
 *   1. Host code doesn't import Stripe SDK directly (single ownership).
 *   2. We can stamp Connect-aware defaults (on_behalf_of + fee) in one place.
 */

import type Stripe from 'stripe';

export interface CreateSubscriptionInput {
  customerId: string;
  /** Pre-created recurring prices. */
  items: Array<{ price: string; quantity?: number }>;
  /** Connect destination. When set, fees route via `application_fee_percent`. */
  connectedAccountId?: string;
  platformFeePercent?: number;
  metadata?: Record<string, string>;
  /** `'charge_automatically'` (default) or `'send_invoice'`. */
  collectionMethod?: 'charge_automatically' | 'send_invoice';
  daysUntilDue?: number;
  trialPeriodDays?: number;
}

export async function createSubscription(
  stripe: Stripe,
  input: CreateSubscriptionInput,
): Promise<Stripe.Subscription> {
  const params: Stripe.SubscriptionCreateParams = {
    customer: input.customerId,
    items: input.items.map((i) => ({ price: i.price, quantity: i.quantity ?? 1 })),
    metadata: input.metadata,
    collection_method: input.collectionMethod ?? 'charge_automatically',
  };
  if (input.daysUntilDue !== undefined) params.days_until_due = input.daysUntilDue;
  if (input.trialPeriodDays !== undefined) params.trial_period_days = input.trialPeriodDays;
  if (input.connectedAccountId) {
    params.on_behalf_of = input.connectedAccountId;
    params.transfer_data = { destination: input.connectedAccountId };
    if (input.platformFeePercent && input.platformFeePercent > 0) {
      params.application_fee_percent = input.platformFeePercent;
    }
  }
  return stripe.subscriptions.create(params);
}

export async function cancelSubscription(
  stripe: Stripe,
  subscriptionId: string,
  opts: { invoiceNow?: boolean; prorate?: boolean } = {},
): Promise<Stripe.Subscription> {
  return stripe.subscriptions.cancel(subscriptionId, {
    invoice_now: opts.invoiceNow,
    prorate: opts.prorate,
  });
}

export async function retrieveSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<Stripe.Subscription> {
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function updateSubscription(
  stripe: Stripe,
  subscriptionId: string,
  params: Stripe.SubscriptionUpdateParams,
): Promise<Stripe.Subscription> {
  return stripe.subscriptions.update(subscriptionId, params);
}