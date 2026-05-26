/**
 * `createIntent` — builds a Stripe PaymentIntent.
 *
 * When `connectedAccountId` is supplied the intent uses Stripe
 * Connect's *destination charge* model (funds go to the tenant minus
 * `application_fee_amount`). Without it the charge stays on the
 * platform (useful for first-party SaaS billing).
 *
 * Intent shape returned matches `@classytic/primitives/payment-gateway`
 * exactly so the engine can persist it without translation.
 */

import type Stripe from 'stripe';
import type { CreateIntentParams, PaymentIntent } from '@classytic/primitives/payment-gateway';
import type { StripeIntentOptions } from '../types.js';

export interface CreateIntentDeps {
  stripe: Stripe;
  defaultCurrency: string;
  /** Platform-wide default platform fee % (overridable per-call). */
  platformFeePercent: number;
}

/**
 * Compute the application fee in minor units. Returns `undefined`
 * when no Connect destination is involved (no fee can apply).
 */
export function computeApplicationFee(
  amount: number,
  feePercent: number,
  hasConnectedAccount: boolean,
): number | undefined {
  if (!hasConnectedAccount) return undefined;
  if (feePercent <= 0) return undefined;
  // Floor — Stripe rejects fractional minor units, and we'd rather
  // under-charge the tenant by 1 paisa than over-charge.
  return Math.floor((amount * feePercent) / 100);
}

export async function createIntent(
  deps: CreateIntentDeps,
  params: CreateIntentParams,
): Promise<PaymentIntent> {
  const amountValue = params.amount.amount;
  const currency = (params.amount.currency ?? deps.defaultCurrency).toLowerCase();

  // Pull Stripe-flavoured knobs out of the opaque `[key: string]: unknown`
  // tail of CreateIntentParams. Engine treats these as pass-through.
  const stripeOpts = (params.stripe ?? {}) as StripeIntentOptions;

  const feePercent = stripeOpts.platformFeePercent ?? deps.platformFeePercent;
  const applicationFeeAmount = computeApplicationFee(
    amountValue,
    feePercent,
    !!stripeOpts.connectedAccountId,
  );

  const createParams: Stripe.PaymentIntentCreateParams = {
    amount: amountValue,
    currency,
    metadata: toStringMetadata(params.metadata),
  };
  if (stripeOpts.description) createParams.description = stripeOpts.description;
  if (stripeOpts.statementDescriptor)
    createParams.statement_descriptor = stripeOpts.statementDescriptor.slice(0, 22);
  if (stripeOpts.captureMethod) createParams.capture_method = stripeOpts.captureMethod;
  if (stripeOpts.paymentMethodTypes?.length)
    createParams.payment_method_types = stripeOpts.paymentMethodTypes;
  if (stripeOpts.customerId) createParams.customer = stripeOpts.customerId;
  if (stripeOpts.paymentMethodId) {
    createParams.payment_method = stripeOpts.paymentMethodId;
    createParams.confirm = true;
    if (stripeOpts.offSession) createParams.off_session = true;
  }
  if (params.returnUrl) createParams.return_url = params.returnUrl;
  if (stripeOpts.connectedAccountId) {
    createParams.transfer_data = { destination: stripeOpts.connectedAccountId };
    if (applicationFeeAmount !== undefined) {
      createParams.application_fee_amount = applicationFeeAmount;
    }
  }

  const intent = await deps.stripe.paymentIntents.create(createParams);

  return {
    id: intent.id,
    provider: 'stripe',
    status: intent.status,
    amount: { amount: intent.amount, currency: intent.currency.toUpperCase() },
    paymentIntentId: intent.id,
    sessionId: null,
    clientSecret: intent.client_secret ?? undefined,
    metadata: params.metadata ?? {},
    raw: intent,
  };
}

/**
 * Stripe metadata values must be strings. Coerce the engine's
 * `Record<string, unknown>` defensively — booleans/numbers become
 * their `String()` form; objects are JSON-stringified.
 */
function toStringMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}