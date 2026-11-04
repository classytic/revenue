/**
 * Unit: the two stripe-node 23 contract changes the adapter depends on.
 *
 *   1. `payment_method_types` was REMOVED from PaymentIntent create params —
 *      the adapter's `paymentMethodTypes` knob must reach Stripe as
 *      `allowed_payment_method_types`, and the old key must never be sent.
 *   2. `PaymentIntent.status` is typed as an OPEN union — a status Stripe adds
 *      later must not leak into the engine's closed `ProviderIntentStatus`.
 */
import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { CreateIntentParams, PaymentCommandContext } from '@classytic/primitives/payment-gateway';
import { createIntent } from '../../src/lib/charges.js';
import { mapIntentStatus } from '../../src/lib/verify.js';

const command: PaymentCommandContext = {
  idempotencyKey: 'intent-cmd-1',
  requestId: 'req-1',
  merchantReference: 'ord_1',
};

function fakeStripe(status = 'requires_payment_method') {
  const create = vi.fn(async (params: Record<string, unknown>) => ({
    id: 'pi_test_1',
    status,
    amount: params.amount,
    currency: params.currency,
    client_secret: 'pi_test_1_secret',
  }));
  return { stripe: { paymentIntents: { create } } as unknown as Stripe, create };
}

function params(stripe: Record<string, unknown> = {}): CreateIntentParams {
  return { amount: { amount: 5000, currency: 'USD' }, stripe } as unknown as CreateIntentParams;
}

describe('createIntent — stripe-node 23 params', () => {
  it('sends paymentMethodTypes as allowed_payment_method_types, never the removed key', async () => {
    const { stripe, create } = fakeStripe();
    await createIntent(
      { stripe, defaultCurrency: 'usd', platformFeePercent: 0 },
      params({ paymentMethodTypes: ['card', 'us_bank_account'] }),
      command,
    );
    const sent = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.allowed_payment_method_types).toEqual(['card', 'us_bank_account']);
    expect(sent).not.toHaveProperty('payment_method_types');
  });

  it('omits the restriction entirely when no types are given', async () => {
    const { stripe, create } = fakeStripe();
    await createIntent({ stripe, defaultCurrency: 'usd', platformFeePercent: 0 }, params(), command);
    const sent = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('allowed_payment_method_types');
    expect(sent).not.toHaveProperty('payment_method_types');
  });

  it('maps a status Stripe adds later to processing in the returned intent', async () => {
    const { stripe } = fakeStripe('requires_reauthorization_2027');
    const intent = await createIntent(
      { stripe, defaultCurrency: 'usd', platformFeePercent: 0 },
      params(),
      command,
    );
    expect(intent.status).toBe('processing');
  });
});

describe('mapIntentStatus', () => {
  it.each([
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
    'canceled',
    'succeeded',
  ])('passes the known status %s through unchanged', (status) => {
    expect(mapIntentStatus(status)).toBe(status);
  });

  it('maps an unknown status to processing (non-terminal, never paid/failed)', () => {
    expect(mapIntentStatus('something_new')).toBe('processing');
    expect(mapIntentStatus('')).toBe('processing');
  });
});
