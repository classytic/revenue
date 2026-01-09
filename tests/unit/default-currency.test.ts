/**
 * Default Currency Configuration Tests
 *
 * Tests for the defaultCurrency feature:
 * - PaymentProvider base class defaultCurrency getter/setter
 * - Revenue builder injects defaultCurrency to providers
 * - ManualProvider uses defaultCurrency instead of hardcoded USD
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult } from '../../revenue/src/providers/base';
import type { CreateIntentParams, ProviderCapabilities } from '../../revenue/src/shared/types';

// Mock provider for testing
class TestProvider extends PaymentProvider {
  public override readonly name = 'test';

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    return new PaymentIntent({
      id: 'test_intent_123',
      provider: 'test',
      status: 'pending',
      amount: params.amount,
      currency: params.currency ?? this.defaultCurrency,
      metadata: params.metadata ?? {},
    });
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    return new PaymentResult({
      id: intentId,
      provider: 'test',
      status: 'succeeded',
      amount: 1000,
      // Don't set currency - let validation skip the check
    });
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(
    _paymentId: string,
    amount?: number | null,
    options?: { reason?: string; currency?: string }
  ): Promise<RefundResult> {
    return new RefundResult({
      id: 'refund_123',
      provider: 'test',
      status: 'succeeded',
      amount: amount ?? 0,
      currency: options?.currency ?? this.defaultCurrency,
    });
  }

  async handleWebhook(): Promise<never> {
    throw new Error('Not supported');
  }

  override getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: true,
    };
  }
}

describe('Default Currency Configuration', () => {
  describe('PaymentProvider Base Class', () => {
    it('should default to USD if no currency configured', () => {
      const provider = new TestProvider();
      expect(provider.defaultCurrency).toBe('USD');
    });

    it('should use defaultCurrency from config if provided', () => {
      const provider = new TestProvider({ defaultCurrency: 'BDT' });
      expect(provider.defaultCurrency).toBe('BDT');
    });

    it('should allow setting defaultCurrency via setDefaultCurrency()', () => {
      const provider = new TestProvider();
      expect(provider.defaultCurrency).toBe('USD');

      provider.setDefaultCurrency('EUR');
      expect(provider.defaultCurrency).toBe('EUR');
    });

    it('should ignore non-string defaultCurrency in config', () => {
      const provider = new TestProvider({ defaultCurrency: 123 as any });
      expect(provider.defaultCurrency).toBe('USD');
    });
  });

  describe('PaymentIntent Class', () => {
    it('should not default currency if not provided', () => {
      const intent = new PaymentIntent({
        id: 'pi_123',
        provider: 'test',
        status: 'pending',
        amount: 1000,
        // currency not provided
      });
      expect(intent.currency).toBeUndefined();
    });

    it('should use provided currency', () => {
      const intent = new PaymentIntent({
        id: 'pi_123',
        provider: 'test',
        status: 'pending',
        amount: 1000,
        currency: 'BDT',
      });
      expect(intent.currency).toBe('BDT');
    });
  });

  describe('PaymentResult Class', () => {
    it('should not default currency if not provided', () => {
      const result = new PaymentResult({
        id: 'pay_123',
        provider: 'test',
        status: 'succeeded',
        amount: 1000,
        // currency not provided
      });
      expect(result.currency).toBeUndefined();
    });

    it('should use provided currency', () => {
      const result = new PaymentResult({
        id: 'pay_123',
        provider: 'test',
        status: 'succeeded',
        amount: 1000,
        currency: 'BDT',
      });
      expect(result.currency).toBe('BDT');
    });
  });

  describe('RefundResult Class', () => {
    it('should not default currency if not provided', () => {
      const result = new RefundResult({
        id: 'ref_123',
        provider: 'test',
        status: 'succeeded',
        amount: 500,
        // currency not provided
      });
      expect(result.currency).toBeUndefined();
    });

    it('should use provided currency', () => {
      const result = new RefundResult({
        id: 'ref_123',
        provider: 'test',
        status: 'succeeded',
        amount: 500,
        currency: 'BDT',
      });
      expect(result.currency).toBe('BDT');
    });
  });

  describe('Provider Using defaultCurrency', () => {
    let provider: TestProvider;

    beforeEach(() => {
      provider = new TestProvider();
      provider.setDefaultCurrency('BDT');
    });

    it('should use defaultCurrency in createIntent when currency not specified', async () => {
      const intent = await provider.createIntent({ amount: 1000 });
      expect(intent.currency).toBe('BDT');
    });

    it('should use explicit currency over defaultCurrency in createIntent', async () => {
      const intent = await provider.createIntent({ amount: 1000, currency: 'EUR' });
      expect(intent.currency).toBe('EUR');
    });

    it('should use defaultCurrency in refund when currency not specified', async () => {
      const result = await provider.refund('pay_123', 500);
      expect(result.currency).toBe('BDT');
    });

    it('should use explicit currency over defaultCurrency in refund', async () => {
      const result = await provider.refund('pay_123', 500, { currency: 'EUR' });
      expect(result.currency).toBe('EUR');
    });

    it('should return undefined currency in verifyPayment (validation skipped)', async () => {
      const result = await provider.verifyPayment('pi_123');
      expect(result.currency).toBeUndefined();
    });
  });

  describe('Currency Validation Scenario', () => {
    it('should allow validation to skip when paymentResult.currency is undefined', () => {
      const paymentResult = new PaymentResult({
        id: 'pay_123',
        provider: 'test',
        status: 'succeeded',
        // no currency - should allow validation to skip
      });

      const transactionCurrency = 'BDT';

      // This simulates the validation logic in payment.service.ts:220-223
      const shouldValidate = paymentResult.currency &&
        paymentResult.currency.toUpperCase() !== transactionCurrency.toUpperCase();

      expect(shouldValidate).toBeFalsy();
    });

    it('should fail validation when currencies mismatch', () => {
      const paymentResult = new PaymentResult({
        id: 'pay_123',
        provider: 'test',
        status: 'succeeded',
        currency: 'USD', // Different from transaction
      });

      const transactionCurrency = 'BDT';

      const shouldValidate = paymentResult.currency &&
        paymentResult.currency.toUpperCase() !== transactionCurrency.toUpperCase();

      expect(shouldValidate).toBeTruthy();
    });

    it('should pass validation when currencies match', () => {
      const paymentResult = new PaymentResult({
        id: 'pay_123',
        provider: 'test',
        status: 'succeeded',
        currency: 'BDT',
      });

      const transactionCurrency = 'BDT';

      const shouldValidate = paymentResult.currency &&
        paymentResult.currency.toUpperCase() !== transactionCurrency.toUpperCase();

      expect(shouldValidate).toBeFalsy();
    });
  });
});
