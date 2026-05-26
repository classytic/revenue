/**
 * `@classytic/revenue-stripe/webhooks`
 *
 * Shared webhook utilities — signature verification + event router.
 * Both SaaS and Connect subpaths use these; this subpath is the
 * canonical home so there's exactly one HMAC implementation in the
 * package.
 *
 * @example Full host wiring (works for hosts using /saas, /connect, or both)
 * ```ts
 * import { verifyStripeSignature, routeStripeEvent } from '@classytic/revenue-stripe/webhooks';
 *
 * fastify.post('/api/stripe/webhook', { config: { rawBody: true } }, async (req, reply) => {
 *   try {
 *     const event = verifyStripeSignature(req.rawBody, req.headers['stripe-signature'] as string, secret, stripe);
 *     await routeStripeEvent(event, {
 *       onCheckoutSessionCompleted: async (_event, session) => { ... },
 *       onCustomerSubscriptionUpdated: async (_event, sub) => { ... },
 *       onInvoicePaid: async (_event, invoice) => { ... },
 *     });
 *     reply.send({ received: true });
 *   } catch (err) {
 *     // ALWAYS 400 on signature failure — never 200, or Stripe stops retrying real events.
 *     reply.code(400).send({ error: 'invalid_signature' });
 *   }
 * });
 * ```
 *
 * For apps that use BOTH SaaS and Connect, inspect `event.account`
 * presence inside your handlers to dispatch to the right code path
 * (platform sub vs. connected-account sub).
 */

export { verifyStripeSignature } from './verify.js';

export {
  handleStripeWebhook,
  routeStripeEvent,
  type StripeWebhookHandlers,
  type HandleWebhookResult,
} from './router.js';
