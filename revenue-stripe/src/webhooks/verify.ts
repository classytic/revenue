/**
 * Stripe webhook signature verification — shared utility.
 *
 * SECURITY: Every webhook delivery from Stripe MUST be verified before
 * any state mutation. Skipping verification lets any HTTP caller forge
 * `payment_intent.succeeded` events, draining the platform.
 *
 * Hosts wire this from any subpath's webhook route. The verification
 * itself is provider-agnostic (uses the Stripe SDK's HMAC) — the
 * resulting verified `Stripe.Event` is then dispatched by the router.
 *
 * @example
 * ```ts
 * import { verifyStripeSignature } from '@classytic/revenue-stripe/webhooks';
 *
 * fastify.post('/api/stripe/webhook', { config: { rawBody: true } }, async (req, reply) => {
 *   try {
 *     const event = verifyStripeSignature(
 *       req.rawBody,
 *       req.headers['stripe-signature'] as string,
 *       process.env.STRIPE_WEBHOOK_SECRET!,
 *       stripe,
 *     );
 *     // event is now safe to act on
 *     await routeStripeWebhook(event, handlers);
 *     reply.send({ received: true });
 *   } catch (err) {
 *     // ALWAYS surface as 400, never 200 — otherwise Stripe stops retrying real events
 *     reply.code(400).send({ error: 'invalid_signature' });
 *   }
 * });
 * ```
 */

import type Stripe from 'stripe';

/**
 * Verify a Stripe webhook signature and parse the JSON body.
 *
 * @param rawBody - The raw, unparsed HTTP body. MUST be a Buffer or
 *                  the exact string the request arrived as — pre-parsed
 *                  JSON will fail signature verification.
 * @param signature - The `stripe-signature` header value.
 * @param secret - Your endpoint's webhook signing secret (`whsec_…`).
 * @param stripe - Stripe SDK instance (any version >= 22).
 *
 * @throws Error from `stripe.webhooks.constructEvent` when the
 *         signature doesn't validate. Caller MUST surface as HTTP 400.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  signature: string,
  secret: string,
  stripe: Stripe,
): Stripe.Event {
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
