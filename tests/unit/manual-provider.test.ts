import { describe, expect, it } from 'vitest';
import { ManualProvider } from '@classytic/revenue-manual';
import type { CreateIntentParams } from '@classytic/primitives/payment-gateway';

describe('ManualProvider', () => {
  const provider = new ManualProvider({ defaultCurrency: 'BDT' });

  it('reads Money shape from createIntent params', async () => {
    const params: CreateIntentParams = {
      amount: { amount: 50000, currency: 'BDT' },
      metadata: {},
    };
    const intent = await provider.createIntent(params);

    expect(intent.provider).toBe('manual');
    expect(intent.status).toBe('requires_payment_method');
    expect(intent.amount).toEqual({ amount: 50000, currency: 'BDT' });
    expect(intent.id).toMatch(/^manual_/);
  });

  it('falls back to defaultCurrency when Money.currency is omitted', async () => {
    const params: CreateIntentParams = {
      amount: { amount: 1000 } as CreateIntentParams['amount'],
      metadata: {},
    };
    const intent = await provider.createIntent(params);
    expect(intent.amount.currency).toBe('BDT');
  });

  it('verifyPayment marks as succeeded', async () => {
    const result = await provider.verifyPayment('manual_abc123');
    expect(result.status).toBe('succeeded');
    expect(result.metadata).toMatchObject({ manuallyVerified: true });
  });

  it('refund returns succeeded with correct amount', async () => {
    const result = await provider.refund('pay_123', 10000, { currency: 'BDT', reason: 'Test' });
    expect(result.status).toBe('succeeded');
    expect(result.amount).toEqual({ amount: 10000, currency: 'BDT' });
    expect(result.reason).toBe('Test');
  });

  it('refund defaults amount to 0 when not provided', async () => {
    const result = await provider.refund('pay_123');
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

  it('instructions include amount and currency', async () => {
    const intent = await provider.createIntent({
      amount: { amount: 25000, currency: 'BDT' },
      metadata: {},
    });
    expect(intent.instructions).toContain('25000');
    expect(intent.instructions).toContain('BDT');
  });

  it('uses custom paymentInstructions from metadata', async () => {
    const intent = await provider.createIntent({
      amount: { amount: 500, currency: 'USD' },
      metadata: { paymentInstructions: 'Pay via bKash to 01711000000' },
    });
    expect(intent.instructions).toBe('Pay via bKash to 01711000000');
  });
});
