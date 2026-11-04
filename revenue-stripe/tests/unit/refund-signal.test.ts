/**
 * Unit: gateway-reported refunds reach the engine as `WebhookEvent.data.refund`, and a
 * Checkout verify reports the PaymentIntent so later refund/dispute events can be linked.
 *
 *   1. Only a SUCCEEDED refund is signalled — pending (bank rails) and failed are not.
 *   2. A refund this adapter issued carries its command ref; a dashboard refund does not.
 *   3. Non-refund events never carry a refund signal.
 *   4. The Checkout provider's webhook surfaces the signal and routes it by PaymentIntent.
 *   5. Checkout verify reports `paymentIntentId` once the customer paid.
 */
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { StripeCheckoutProvider } from '../../src/checkout/provider.js';
import { REVENUE_REFUND_CMD_REF } from '../../src/lib/refund.js';
import { refundSignalOf } from '../../src/lib/refund-signal.js';

const SECRET = 'whsec_unit';

function refundEvent(
  type: string,
  refund: { status: string; amount?: number; metadata?: Record<string, string> },
): Stripe.Event {
  return {
    id: 'evt_1',
    object: 'event',
    type,
    created: 1_700_000_000,
    livemode: false,
    data: {
      object: {
        id: 're_1',
        object: 'refund',
        amount: refund.amount ?? 1500,
        payment_intent: 'pi_1',
        status: refund.status,
        metadata: refund.metadata ?? {},
      },
    },
  } as unknown as Stripe.Event;
}

describe('refundSignalOf', () => {
  it('signals a succeeded refund with its own id and amount', () => {
    expect(refundSignalOf(refundEvent('refund.created', { status: 'succeeded' }))).toEqual({
      id: 're_1',
      amount: 1500,
    });
  });

  it('signals the refund.updated that settles a pending refund', () => {
    expect(refundSignalOf(refundEvent('refund.updated', { status: 'succeeded' }))?.id).toBe('re_1');
  });

  it.each(['pending', 'requires_action', 'failed', 'canceled'])(
    'does not signal a %s refund',
    (status) => {
      expect(refundSignalOf(refundEvent('refund.created', { status }))).toBeUndefined();
    },
  );

  it('carries the command ref when the engine initiated the refund', () => {
    const signal = refundSignalOf(
      refundEvent('refund.created', {
        status: 'succeeded',
        metadata: { [REVENUE_REFUND_CMD_REF]: 'abc123' },
      }),
    );
    expect(signal?.commandRef).toBe('abc123');
  });

  it('ignores events that are not refund events', () => {
    expect(refundSignalOf(refundEvent('charge.refunded', { status: 'succeeded' }))).toBeUndefined();
  });
});

describe('StripeCheckoutProvider — refunds and payment linking', () => {
  const stripe = new Stripe('sk_test_unit');
  const provider = new StripeCheckoutProvider({
    stripe,
    webhookSecret: SECRET,
    successUrl: 'https://x.test/ok',
    cancelUrl: 'https://x.test/no',
  });

  it('surfaces a dashboard refund on the webhook, routed by PaymentIntent', async () => {
    const payload = JSON.stringify(refundEvent('refund.created', { status: 'succeeded', amount: 700 }));
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const event = await provider.handleWebhook(payload, { 'stripe-signature': header });
    expect(event.data.paymentIntentId).toBe('pi_1');
    expect(event.data.refund).toEqual({ id: 're_1', amount: 700 });
  });

  it('reports the PaymentIntent from a paid Checkout session on verify', async () => {
    vi.spyOn(stripe.checkout.sessions, 'retrieve').mockResolvedValue({
      id: 'cs_1',
      payment_status: 'paid',
      payment_intent: 'pi_9',
      amount_total: 5000,
      currency: 'usd',
      created: 1_700_000_000,
      status: 'complete',
    } as unknown as Stripe.Response<Stripe.Checkout.Session>);
    const result = await provider.verifyPayment('cs_1');
    expect(result.status).toBe('succeeded');
    expect(result.paymentIntentId).toBe('pi_9');
  });

  it('reports no PaymentIntent for a session nobody has paid yet', async () => {
    vi.spyOn(stripe.checkout.sessions, 'retrieve').mockResolvedValue({
      id: 'cs_2',
      payment_status: 'unpaid',
      payment_intent: null,
      amount_total: 5000,
      currency: 'usd',
      created: 1_700_000_000,
      status: 'open',
    } as unknown as Stripe.Response<Stripe.Checkout.Session>);
    const result = await provider.verifyPayment('cs_2');
    expect(result).not.toHaveProperty('paymentIntentId');
  });
});
