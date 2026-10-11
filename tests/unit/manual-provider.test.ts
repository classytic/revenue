import { currencyCode } from '@classytic/primitives/currency';
import { describe, expect, it } from 'vitest';
import { ManualProvider } from '@classytic/revenue-manual';
import type { CreateIntentParams, PaymentCommandContext } from '@classytic/primitives/payment-gateway';

/** Minimal command envelope for the money-moving provider calls (§3.4). */
const cmd = (idempotencyKey = 'test-key'): PaymentCommandContext => ({
  idempotencyKey,
  requestId: 'rq_test',
  merchantReference: 'mref_test',
  organizationId: 'org_test',
});

describe('ManualProvider', () => {
  const provider = new ManualProvider({ defaultCurrency: 'BDT' });

  it('reads Money shape from createIntent params', async () => {
    const params: CreateIntentParams = {
      amount: { amount: 50000, currency: currencyCode('BDT') },
      metadata: {},
    };
    const intent = await provider.createIntent(params, cmd());

    expect(intent.provider).toBe('manual');
    expect(intent.status).toBe('requires_payment_method');
    expect(intent.amount).toEqual({ amount: 50000, currency: currencyCode('BDT') });
    expect(intent.id).toMatch(/^manual_/);
  });

  it('falls back to defaultCurrency when Money.currency is omitted', async () => {
    const params: CreateIntentParams = {
      amount: { amount: 1000 } as CreateIntentParams['amount'],
      metadata: {},
    };
    const intent = await provider.createIntent(params, cmd());
    expect(intent.amount.currency).toBe('BDT');
  });

  it('verifyPayment marks as succeeded', async () => {
    const result = await provider.verifyPayment('manual_abc123');
    expect(result.status).toBe('succeeded');
    expect(result.metadata).toMatchObject({ manuallyVerified: true });
  });

  it('refund returns succeeded with correct amount', async () => {
    const result = await provider.refund('pay_123', 10000, cmd(), { currency: currencyCode('BDT'), reason: 'Test' });
    expect(result.status).toBe('succeeded');
    expect(result.amount).toEqual({ amount: 10000, currency: currencyCode('BDT') });
    expect(result.reason).toBe('Test');
  });

  it('refund defaults amount to 0 when not provided', async () => {
    const result = await provider.refund('pay_123', undefined, cmd());
    expect(result.amount!.amount).toBe(0);
  });

  it('handleWebhook throws — manual provider has no webhooks', async () => {
    await expect(provider.handleWebhook({})).rejects.toThrow('Manual provider does not support webhooks');
  });

  it('getCapabilities reflects manual provider constraints', () => {
    const caps = provider.getCapabilities();
    expect(caps.supportsWebhooks).toBe(false);
    expect(caps.supportsRefunds).toBe(true);
    expect(caps.supportsPartialRefunds).toBe(true);
    expect(caps.requiresManualVerification).toBe(true);
  });

  // Customer-facing: the amount prints in MAJOR units at the currency's own exponent, never the minor integer.
  it('instructions show the major amount at the currency exponent', async () => {
    const shown = async (amount: number, code: string) =>
      String((await provider.createIntent({ amount: { amount, currency: currencyCode(code) }, metadata: {} }, cmd())).instructions);
    const bdt = await shown(25000, 'BDT');
    expect(bdt).toContain('Payment Amount: 250.00 BDT');
    expect(bdt).not.toContain('25000');
    expect(await shown(150000, 'JPY')).toContain('Payment Amount: 150,000 JPY');
    expect(await shown(1234567, 'KWD')).toContain('Payment Amount: 1,234.567 KWD');
  });

  it('uses custom paymentInstructions from metadata', async () => {
    const intent = await provider.createIntent({
      amount: { amount: 500, currency: currencyCode('USD') },
      metadata: { paymentInstructions: 'Pay via bKash to 01711000000' },
    }, cmd());
    expect(intent.instructions).toBe('Pay via bKash to 01711000000');
  });
});
