/**
 * Stripe Checkout Session helper.
 *
 * Hosts using `/saas` (SaaS billing) call this to start a self-serve
 * subscription or one-off purchase — the customer redirects to
 * Stripe's hosted payment page, then back to `successUrl` with the
 * session ID in the query string for confirmation.
 *
 * Connect-aware: pass `connectedAccountId` to route the session at
 * a connected account (use from `/connect`).
 */

import type Stripe from 'stripe';

export interface CreateCheckoutSessionInput {
  /** Either `subscription` (recurring) or `payment` (one-off). */
  mode: 'subscription' | 'payment';
  /** Pre-created Stripe Price IDs + quantities. */
  lineItems: Array<{ price: string; quantity: number }>;
  /** Where Stripe sends the customer after success. Should include `?session_id={CHECKOUT_SESSION_ID}` if you want to confirm server-side. */
  successUrl: string;
  /** Where Stripe sends the customer if they cancel. */
  cancelUrl: string;
  /** Existing Stripe customer (`cus_…`). When omitted, Stripe creates one and you get it back on the completed session. */
  customerId?: string;
  /** Email to pre-fill when no customerId. Stripe creates a new customer with this email. */
  customerEmail?: string;
  /** Pass-through metadata stamped on the session + subsequent invoice. */
  metadata?: Record<string, string>;
  /** Connect destination — sets `on_behalf_of` + `application_fee_percent` (when fee > 0). */
  connectedAccountId?: string;
  platformFeePercent?: number;
  /** Trial days for subscription mode. */
  trialPeriodDays?: number;
  /** Allow promotion codes at checkout (default false). */
  allowPromotionCodes?: boolean;
}

export interface CreateCheckoutSessionResult {
  id: string;
  url: string;
  /** Always null until the customer completes — populated on the resulting webhook. */
  customerId: string | null;
  raw: Stripe.Checkout.Session;
}

/** Stripe SDK's Session create params, derived from the actual function
 *  signature — avoids brittle `Stripe.Checkout.SessionCreateParams`
 *  namespace path which resolves differently across Stripe SDK versions. */
type SessionCreateParams = NonNullable<Parameters<Stripe['checkout']['sessions']['create']>[0]>;

export async function createCheckoutSession(
  stripe: Stripe,
  input: CreateCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult> {
  const params: SessionCreateParams = {
    mode: input.mode,
    line_items: input.lineItems,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    metadata: input.metadata,
  };
  if (input.customerId) params.customer = input.customerId;
  else if (input.customerEmail) params.customer_email = input.customerEmail;
  if (input.allowPromotionCodes) params.allow_promotion_codes = true;

  if (input.mode === 'subscription') {
    const subData: NonNullable<SessionCreateParams['subscription_data']> = {};
    if (input.trialPeriodDays !== undefined) subData.trial_period_days = input.trialPeriodDays;
    if (input.metadata) subData.metadata = input.metadata;
    if (input.connectedAccountId) {
      subData.on_behalf_of = input.connectedAccountId;
      subData.transfer_data = { destination: input.connectedAccountId };
      if (input.platformFeePercent && input.platformFeePercent > 0) {
        subData.application_fee_percent = input.platformFeePercent;
      }
    }
    if (Object.keys(subData).length) params.subscription_data = subData;
  } else if (input.connectedAccountId) {
    // For one-off payment mode Connect routing lives on payment_intent_data.
    const piData: NonNullable<SessionCreateParams['payment_intent_data']> = {
      transfer_data: { destination: input.connectedAccountId },
    };
    if (input.platformFeePercent && input.platformFeePercent > 0) {
      piData.on_behalf_of = input.connectedAccountId;
      // Application fee % isn't supported on PI data — for one-off Connect
      // charges with a percentage fee, use createIntent from /lib/charges
      // (it sets application_fee_amount on the PaymentIntent directly).
    }
    params.payment_intent_data = piData;
  }

  const session = await stripe.checkout.sessions.create(params);
  return {
    id: session.id,
    url: session.url ?? '',
    customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
    raw: session,
  };
}

/** Convenience: retrieve a Checkout Session by id (poll-fallback when webhook is delayed). */
export async function retrieveCheckoutSession(
  stripe: Stripe,
  sessionId: string,
): Promise<Stripe.Checkout.Session> {
  return stripe.checkout.sessions.retrieve(sessionId);
}

/** Convenience: create a Stripe Billing Portal session so the customer can manage their own sub (cancel, update payment method). */
export async function createBillingPortalSession(
  stripe: Stripe,
  input: { customerId: string; returnUrl: string },
): Promise<{ id: string; url: string; raw: Stripe.BillingPortal.Session }> {
  const session = await stripe.billingPortal.sessions.create({
    customer: input.customerId,
    return_url: input.returnUrl,
  });
  return { id: session.id, url: session.url, raw: session };
}
