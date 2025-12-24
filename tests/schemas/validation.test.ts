/**
 * Zod Validation Schema Tests
 * @classytic/revenue
 *
 * Tests for:
 * - All validation schemas work correctly
 * - z is NOT exported from public API (prevents mixed schema issues)
 * - Type inference works properly
 * - Error formatting is correct
 */

import { describe, it, expect } from 'vitest';
import * as z from 'zod';

// Import from the package - simulating consumer usage
import {
  // Primitive schemas
  ObjectIdSchema,
  CurrencySchema,
  MoneyAmountSchema,
  MoneySchema,
  EmailSchema,
  IdempotencyKeySchema,
  MetadataSchema,
  // Payment schemas
  CreatePaymentSchema,
  VerifyPaymentSchema,
  RefundSchema,
  // Current payment / split payment schemas
  PaymentStatusEnumSchema,
  PaymentEntrySchema,
  CurrentPaymentInputSchema,
  // Subscription schemas
  SubscriptionStatusSchema,
  IntervalSchema,
  CreateSubscriptionSchema,
  CancelSubscriptionSchema,
  // Monetization schemas
  MonetizationTypeSchema,
  CreateMonetizationSchema,
  // Commission schemas
  SplitRecipientSchema,
  CommissionConfigSchema,
  // Escrow schemas
  HoldStatusSchema,
  CreateHoldSchema,
  ReleaseHoldSchema,
  // Config schemas
  ProviderConfigSchema,
  RetryConfigSchema,
  RevenueConfigSchema,
  // Helpers
  validate,
  safeValidate,
  formatZodError,
  validateSplitPayments,
  // Types
  type CreatePaymentInput,
  type CreateSubscriptionInput,
  type CreateMonetizationInput,
  type PaymentEntryInput,
  type CurrentPaymentInput,
} from '../../revenue/dist/index.js';

// Import everything to check exports
import * as RevenueExports from '../../revenue/dist/index.js';

describe('Zod Validation Schemas', () => {
  // ============ CRITICAL: z NOT EXPORTED ============
  describe('Public API Export Safety', () => {
    it('should NOT export z (Zod instance) from public API', () => {
      // This is critical - exporting z causes mixed schema issues
      // when consumers use their own Zod instance
      expect((RevenueExports as Record<string, unknown>)['z']).toBeUndefined();
    });

    it('should NOT export zod namespace', () => {
      expect((RevenueExports as Record<string, unknown>)['zod']).toBeUndefined();
    });

    it('should NOT export Zod', () => {
      expect((RevenueExports as Record<string, unknown>)['Zod']).toBeUndefined();
    });

    it('schemas should be compatible with consumer Zod instance', () => {
      // Consumer creates their own schema using their Zod
      const consumerSchema = z.object({
        payment: CreatePaymentSchema,
      });

      // This should work without _zod runtime errors
      const result = consumerSchema.safeParse({
        payment: {
          amount: 1000,
          currency: 'USD',
          customerId: 'cust_123',
          organizationId: 'org_123',
          provider: 'stripe',
        },
      });

      expect(result.success).toBe(true);
    });
  });

  // ============ PRIMITIVE SCHEMAS ============
  describe('Primitive Schemas', () => {
    describe('ObjectIdSchema', () => {
      it('accepts valid 24-char hex ObjectId', () => {
        const validId = '507f1f77bcf86cd799439011';
        expect(ObjectIdSchema.parse(validId)).toBe(validId);
      });

      it('rejects invalid ObjectId - too short', () => {
        expect(() => ObjectIdSchema.parse('507f1f77bcf86cd79943901')).toThrow();
      });

      it('rejects invalid ObjectId - non-hex characters', () => {
        expect(() => ObjectIdSchema.parse('507f1f77bcf86cd79943901g')).toThrow();
      });

      it('rejects invalid ObjectId - too long', () => {
        expect(() => ObjectIdSchema.parse('507f1f77bcf86cd7994390111')).toThrow();
      });
    });

    describe('CurrencySchema', () => {
      it('accepts valid 3-char currency code', () => {
        expect(CurrencySchema.parse('usd')).toBe('USD'); // transforms to uppercase
      });

      it('transforms to uppercase', () => {
        expect(CurrencySchema.parse('bdt')).toBe('BDT');
      });

      it('defaults to USD when using default', () => {
        // Test the default behavior through an object schema
        const schema = z.object({ currency: CurrencySchema });
        expect(schema.parse({}).currency).toBe('USD');
      });

      it('rejects currency codes with wrong length', () => {
        expect(() => CurrencySchema.parse('US')).toThrow();
        expect(() => CurrencySchema.parse('USDD')).toThrow();
      });
    });

    describe('MoneyAmountSchema', () => {
      it('accepts valid non-negative integer', () => {
        expect(MoneyAmountSchema.parse(1000)).toBe(1000);
        expect(MoneyAmountSchema.parse(0)).toBe(0);
      });

      it('rejects negative amounts', () => {
        expect(() => MoneyAmountSchema.parse(-100)).toThrow();
      });

      it('rejects floating point amounts', () => {
        expect(() => MoneyAmountSchema.parse(10.5)).toThrow();
      });
    });

    describe('MoneySchema', () => {
      it('accepts valid money object', () => {
        const money = { amount: 1000, currency: 'USD' };
        expect(MoneySchema.parse(money)).toEqual(money);
      });

      it('applies defaults', () => {
        const result = MoneySchema.parse({ amount: 500 });
        expect(result.currency).toBe('USD');
      });
    });

    describe('EmailSchema', () => {
      it('accepts valid email', () => {
        expect(EmailSchema.parse('test@example.com')).toBe('test@example.com');
      });

      it('rejects invalid email', () => {
        expect(() => EmailSchema.parse('not-an-email')).toThrow();
        expect(() => EmailSchema.parse('missing@domain')).toThrow();
      });
    });

    describe('IdempotencyKeySchema', () => {
      it('accepts valid idempotency key', () => {
        expect(IdempotencyKeySchema.parse('idem_123')).toBe('idem_123');
      });

      it('is optional', () => {
        expect(IdempotencyKeySchema.parse(undefined)).toBeUndefined();
      });

      it('rejects empty string', () => {
        expect(() => IdempotencyKeySchema.parse('')).toThrow();
      });

      it('rejects keys over 255 characters', () => {
        const longKey = 'a'.repeat(256);
        expect(() => IdempotencyKeySchema.parse(longKey)).toThrow();
      });
    });

    describe('MetadataSchema', () => {
      it('accepts record of string to unknown', () => {
        const metadata = { key1: 'value1', key2: 123, key3: { nested: true } };
        expect(MetadataSchema.parse(metadata)).toEqual(metadata);
      });

      it('defaults to empty object', () => {
        expect(MetadataSchema.parse(undefined)).toEqual({});
      });
    });
  });

  // ============ PAYMENT SCHEMAS ============
  describe('Payment Schemas', () => {
    describe('CreatePaymentSchema', () => {
      const validPayment = {
        amount: 1000,
        currency: 'USD',
        customerId: 'cust_123',
        organizationId: 'org_123',
        provider: 'stripe',
      };

      it('accepts valid payment input', () => {
        const result = CreatePaymentSchema.parse(validPayment);
        expect(result.amount).toBe(1000);
        expect(result.customerId).toBe('cust_123');
      });

      it('applies default values', () => {
        const result = CreatePaymentSchema.parse({
          amount: 500,
          customerId: 'cust_1',
          organizationId: 'org_1',
          provider: 'test',
        });
        expect(result.currency).toBe('USD');
        expect(result.metadata).toEqual({});
      });

      it('accepts optional fields', () => {
        const result = CreatePaymentSchema.parse({
          ...validPayment,
          description: 'Test payment',
          successUrl: 'https://example.com/success',
          cancelUrl: 'https://example.com/cancel',
          idempotencyKey: 'idem_123',
        });
        expect(result.description).toBe('Test payment');
        expect(result.successUrl).toBe('https://example.com/success');
      });

      it('rejects missing required fields', () => {
        expect(() => CreatePaymentSchema.parse({ amount: 1000 })).toThrow();
        expect(() => CreatePaymentSchema.parse({ ...validPayment, customerId: '' })).toThrow();
      });

      it('validates URL format for redirects', () => {
        expect(() =>
          CreatePaymentSchema.parse({
            ...validPayment,
            successUrl: 'not-a-url',
          })
        ).toThrow();
      });

      it('type inference works correctly', () => {
        const input: CreatePaymentInput = {
          amount: 1000,
          currency: 'USD',
          customerId: 'cust_123',
          organizationId: 'org_123',
          provider: 'stripe',
        };
        expect(CreatePaymentSchema.parse(input)).toBeDefined();
      });
    });

    describe('VerifyPaymentSchema', () => {
      it('accepts valid verification input', () => {
        const result = VerifyPaymentSchema.parse({ id: 'txn_123' });
        expect(result.id).toBe('txn_123');
      });

      it('accepts optional provider and data', () => {
        const result = VerifyPaymentSchema.parse({
          id: 'txn_123',
          provider: 'stripe',
          data: { sessionId: 'sess_123' },
        });
        expect(result.provider).toBe('stripe');
        expect(result.data).toEqual({ sessionId: 'sess_123' });
      });

      it('rejects empty id', () => {
        expect(() => VerifyPaymentSchema.parse({ id: '' })).toThrow();
      });
    });

    describe('RefundSchema', () => {
      it('accepts valid refund input', () => {
        const result = RefundSchema.parse({ transactionId: 'txn_123' });
        expect(result.transactionId).toBe('txn_123');
      });

      it('accepts optional amount for partial refund', () => {
        const result = RefundSchema.parse({
          transactionId: 'txn_123',
          amount: 500,
          reason: 'Customer request',
        });
        expect(result.amount).toBe(500);
      });

      it('rejects negative refund amount', () => {
        expect(() =>
          RefundSchema.parse({
            transactionId: 'txn_123',
            amount: -100,
          })
        ).toThrow();
      });
    });
  });

  // ============ CURRENT PAYMENT / SPLIT PAYMENT SCHEMAS ============
  describe('Current Payment / Split Payment Schemas', () => {
    describe('PaymentStatusEnumSchema', () => {
      it('accepts valid payment status values', () => {
        const validStatuses = ['pending', 'verified', 'failed', 'refunded', 'cancelled'];
        validStatuses.forEach((status) => {
          expect(PaymentStatusEnumSchema.parse(status)).toBe(status);
        });
      });

      it('rejects invalid status', () => {
        expect(() => PaymentStatusEnumSchema.parse('invalid')).toThrow();
      });
    });

    describe('PaymentEntrySchema', () => {
      it('accepts valid payment entry', () => {
        const entry = {
          method: 'cash',
          amount: 10000, // 100 BDT in paisa
        };
        const result = PaymentEntrySchema.parse(entry);
        expect(result.method).toBe('cash');
        expect(result.amount).toBe(10000);
      });

      it('accepts optional reference and details', () => {
        const entry = {
          method: 'bkash',
          amount: 30000,
          reference: 'TRX456',
          details: { walletNumber: '01712345678' },
        };
        const result = PaymentEntrySchema.parse(entry);
        expect(result.reference).toBe('TRX456');
        expect(result.details).toEqual({ walletNumber: '01712345678' });
      });

      it('rejects empty method', () => {
        expect(() => PaymentEntrySchema.parse({ method: '', amount: 1000 })).toThrow();
      });

      it('rejects negative amount', () => {
        expect(() => PaymentEntrySchema.parse({ method: 'cash', amount: -100 })).toThrow();
      });

      it('type inference works correctly', () => {
        const entry: PaymentEntryInput = {
          method: 'bank_transfer',
          amount: 5000,
          reference: 'TRF123',
        };
        expect(PaymentEntrySchema.parse(entry)).toBeDefined();
      });
    });

    describe('CurrentPaymentInputSchema', () => {
      describe('Single Payment (backward compatible)', () => {
        it('accepts single payment without payments array', () => {
          const payment = {
            amount: 50000,
            method: 'cash',
            status: 'verified',
          };
          const result = CurrentPaymentInputSchema.parse(payment);
          expect(result.amount).toBe(50000);
          expect(result.method).toBe('cash');
          expect(result.payments).toBeUndefined();
        });

        it('applies default status', () => {
          const result = CurrentPaymentInputSchema.parse({
            amount: 1000,
            method: 'cash',
          });
          expect(result.status).toBe('pending');
        });

        it('accepts optional fields', () => {
          const result = CurrentPaymentInputSchema.parse({
            amount: 1000,
            method: 'bank_transfer',
            reference: 'REF123',
            transactionId: 'txn_123',
          });
          expect(result.reference).toBe('REF123');
          expect(result.transactionId).toBe('txn_123');
        });
      });

      describe('Split Payment (multi-method)', () => {
        it('accepts split payment with matching totals', () => {
          const payment = {
            amount: 50000, // Total: 500 BDT
            method: 'split',
            status: 'verified',
            payments: [
              { method: 'cash', amount: 10000 },           // 100 BDT
              { method: 'bank_transfer', amount: 10000 },  // 100 BDT
              { method: 'bkash', amount: 30000 },          // 300 BDT
            ],
          };
          const result = CurrentPaymentInputSchema.parse(payment);
          expect(result.method).toBe('split');
          expect(result.payments).toHaveLength(3);
          expect(result.payments![0].method).toBe('cash');
        });

        it('accepts split payment with references and details', () => {
          const payment = {
            amount: 50000,
            method: 'split',
            payments: [
              { method: 'cash', amount: 10000 },
              { method: 'bank_transfer', amount: 10000, reference: 'TRF123' },
              { method: 'bkash', amount: 30000, reference: 'TRX456', details: { walletNumber: '01712345678' } },
            ],
          };
          const result = CurrentPaymentInputSchema.parse(payment);
          expect(result.payments![1].reference).toBe('TRF123');
          expect(result.payments![2].details).toEqual({ walletNumber: '01712345678' });
        });

        it('rejects split payment with mismatched totals', () => {
          const payment = {
            amount: 50000, // 500 BDT total
            method: 'split',
            payments: [
              { method: 'cash', amount: 10000 },   // 100 BDT
              { method: 'bkash', amount: 20000 },  // 200 BDT - Total: 300, not 500!
            ],
          };
          const result = safeValidate(CurrentPaymentInputSchema, payment);
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error.issues.some((i) =>
              i.message.includes('Split payments total must equal')
            )).toBe(true);
          }
        });

        it('accepts empty payments array (treated as single payment)', () => {
          const payment = {
            amount: 50000,
            method: 'cash',
            payments: [],
          };
          // Empty array should pass - no validation needed
          const result = CurrentPaymentInputSchema.parse(payment);
          expect(result.payments).toEqual([]);
        });
      });

      it('type inference works correctly', () => {
        const payment: CurrentPaymentInput = {
          amount: 50000,
          method: 'split',
          status: 'verified',
          payments: [
            { method: 'cash', amount: 25000 },
            { method: 'bkash', amount: 25000 },
          ],
        };
        expect(CurrentPaymentInputSchema.parse(payment)).toBeDefined();
      });
    });

    describe('validateSplitPayments helper', () => {
      it('returns true for single payment (no payments array)', () => {
        const payment = { amount: 50000 };
        expect(validateSplitPayments(payment)).toBe(true);
      });

      it('returns true for empty payments array', () => {
        const payment = { amount: 50000, payments: [] };
        expect(validateSplitPayments(payment)).toBe(true);
      });

      it('returns true when split totals match', () => {
        const payment = {
          amount: 50000,
          payments: [
            { amount: 10000 },
            { amount: 10000 },
            { amount: 30000 },
          ],
        };
        expect(validateSplitPayments(payment)).toBe(true);
      });

      it('returns false when split totals do not match', () => {
        const payment = {
          amount: 50000,
          payments: [
            { amount: 10000 },
            { amount: 20000 },
            // Missing 20000!
          ],
        };
        expect(validateSplitPayments(payment)).toBe(false);
      });

      it('handles zero amounts correctly', () => {
        const payment = {
          amount: 0,
          payments: [
            { amount: 0 },
            { amount: 0 },
          ],
        };
        expect(validateSplitPayments(payment)).toBe(true);
      });
    });
  });

  // ============ SUBSCRIPTION SCHEMAS ============
  describe('Subscription Schemas', () => {
    describe('SubscriptionStatusSchema', () => {
      it('accepts valid status values', () => {
        const validStatuses = ['pending', 'active', 'paused', 'cancelled', 'expired', 'past_due'];
        validStatuses.forEach((status) => {
          expect(SubscriptionStatusSchema.parse(status)).toBe(status);
        });
      });

      it('rejects invalid status', () => {
        expect(() => SubscriptionStatusSchema.parse('invalid')).toThrow();
      });
    });

    describe('IntervalSchema', () => {
      it('accepts valid interval values', () => {
        const validIntervals = ['day', 'week', 'month', 'year', 'one_time'];
        validIntervals.forEach((interval) => {
          expect(IntervalSchema.parse(interval)).toBe(interval);
        });
      });

      it('rejects invalid interval', () => {
        expect(() => IntervalSchema.parse('hourly')).toThrow();
      });
    });

    describe('CreateSubscriptionSchema', () => {
      const validSubscription = {
        customerId: 'cust_123',
        organizationId: 'org_123',
        planKey: 'premium',
        amount: 999,
        provider: 'stripe',
      };

      it('accepts valid subscription input', () => {
        const result = CreateSubscriptionSchema.parse(validSubscription);
        expect(result.planKey).toBe('premium');
      });

      it('applies default values', () => {
        const result = CreateSubscriptionSchema.parse(validSubscription);
        expect(result.currency).toBe('USD');
        expect(result.interval).toBe('month');
        expect(result.intervalCount).toBe(1);
      });

      it('accepts trial days', () => {
        const result = CreateSubscriptionSchema.parse({
          ...validSubscription,
          trialDays: 14,
        });
        expect(result.trialDays).toBe(14);
      });

      it('rejects negative trial days', () => {
        expect(() =>
          CreateSubscriptionSchema.parse({
            ...validSubscription,
            trialDays: -1,
          })
        ).toThrow();
      });

      it('accepts reference fields', () => {
        const result = CreateSubscriptionSchema.parse({
          ...validSubscription,
          referenceId: 'course_123',
          referenceModel: 'Course',
        });
        expect(result.referenceId).toBe('course_123');
        expect(result.referenceModel).toBe('Course');
      });

      it('type inference works correctly', () => {
        const input: CreateSubscriptionInput = {
          customerId: 'cust_123',
          organizationId: 'org_123',
          planKey: 'basic',
          amount: 499,
          provider: 'stripe',
        };
        expect(CreateSubscriptionSchema.parse(input)).toBeDefined();
      });
    });

    describe('CancelSubscriptionSchema', () => {
      it('accepts valid cancellation input', () => {
        const result = CancelSubscriptionSchema.parse({
          subscriptionId: 'sub_123',
        });
        expect(result.subscriptionId).toBe('sub_123');
        expect(result.immediate).toBe(false); // default
      });

      it('accepts immediate cancellation', () => {
        const result = CancelSubscriptionSchema.parse({
          subscriptionId: 'sub_123',
          immediate: true,
          reason: 'Customer requested',
        });
        expect(result.immediate).toBe(true);
        expect(result.reason).toBe('Customer requested');
      });
    });
  });

  // ============ MONETIZATION SCHEMAS ============
  describe('Monetization Schemas', () => {
    describe('MonetizationTypeSchema', () => {
      it('accepts valid monetization types', () => {
        expect(MonetizationTypeSchema.parse('purchase')).toBe('purchase');
        expect(MonetizationTypeSchema.parse('subscription')).toBe('subscription');
        expect(MonetizationTypeSchema.parse('free')).toBe('free');
      });

      it('rejects invalid type', () => {
        expect(() => MonetizationTypeSchema.parse('rental')).toThrow();
      });
    });

    describe('CreateMonetizationSchema', () => {
      const baseInput = {
        customerId: 'cust_123',
        organizationId: 'org_123',
        provider: 'stripe',
      };

      it('accepts purchase with amount', () => {
        const result = CreateMonetizationSchema.parse({
          ...baseInput,
          type: 'purchase',
          amount: 1000,
        });
        expect(result.type).toBe('purchase');
        expect(result.amount).toBe(1000);
      });

      it('accepts subscription with interval', () => {
        const result = CreateMonetizationSchema.parse({
          ...baseInput,
          type: 'subscription',
          amount: 999,
          interval: 'month',
        });
        expect(result.interval).toBe('month');
      });

      it('accepts free without amount', () => {
        const result = CreateMonetizationSchema.parse({
          ...baseInput,
          type: 'free',
        });
        expect(result.type).toBe('free');
        expect(result.amount).toBeUndefined();
      });

      it('rejects purchase without amount (refinement)', () => {
        const result = safeValidate(CreateMonetizationSchema, {
          ...baseInput,
          type: 'purchase',
          // Missing amount!
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues.some((i) => i.message.includes('Amount is required'))).toBe(
            true
          );
        }
      });

      it('rejects subscription without amount (refinement)', () => {
        const result = safeValidate(CreateMonetizationSchema, {
          ...baseInput,
          type: 'subscription',
          // Missing amount!
        });
        expect(result.success).toBe(false);
      });

      it('type inference works correctly', () => {
        const input: CreateMonetizationInput = {
          type: 'purchase',
          amount: 1000,
          customerId: 'cust_123',
          organizationId: 'org_123',
          provider: 'stripe',
        };
        expect(CreateMonetizationSchema.parse(input)).toBeDefined();
      });
    });
  });

  // ============ COMMISSION SCHEMAS ============
  describe('Commission Schemas', () => {
    describe('SplitRecipientSchema', () => {
      it('accepts valid split recipient', () => {
        const result = SplitRecipientSchema.parse({
          recipientId: 'user_123',
          percentage: 25,
        });
        expect(result.recipientId).toBe('user_123');
        expect(result.recipientType).toBe('user'); // default
        expect(result.percentage).toBe(25);
      });

      it('rejects percentage over 100', () => {
        expect(() =>
          SplitRecipientSchema.parse({
            recipientId: 'user_123',
            percentage: 101,
          })
        ).toThrow();
      });

      it('rejects negative percentage', () => {
        expect(() =>
          SplitRecipientSchema.parse({
            recipientId: 'user_123',
            percentage: -5,
          })
        ).toThrow();
      });
    });

    describe('CommissionConfigSchema', () => {
      it('accepts valid commission config', () => {
        const result = CommissionConfigSchema.parse({
          platformRate: 10,
          gatewayFeeRate: 2.9,
          gatewayFixedFee: 30,
        });
        expect(result.platformRate).toBe(10);
      });

      it('applies default values', () => {
        const result = CommissionConfigSchema.parse({});
        expect(result.platformRate).toBe(0);
        expect(result.gatewayFeeRate).toBe(0);
        expect(result.gatewayFixedFee).toBe(0);
      });

      it('accepts splits array', () => {
        const result = CommissionConfigSchema.parse({
          platformRate: 10,
          splits: [
            { recipientId: 'instructor_1', percentage: 70 },
            { recipientId: 'instructor_2', percentage: 30 },
          ],
        });
        expect(result.splits).toHaveLength(2);
      });

      it('accepts affiliate config', () => {
        const result = CommissionConfigSchema.parse({
          platformRate: 10,
          affiliate: {
            recipientId: 'affiliate_123',
            rate: 15,
          },
        });
        expect(result.affiliate?.rate).toBe(15);
      });
    });
  });

  // ============ ESCROW SCHEMAS ============
  describe('Escrow Schemas', () => {
    describe('HoldStatusSchema', () => {
      it('accepts valid hold statuses', () => {
        const statuses = ['none', 'held', 'partial_release', 'released', 'cancelled'];
        statuses.forEach((status) => {
          expect(HoldStatusSchema.parse(status)).toBe(status);
        });
      });
    });

    describe('CreateHoldSchema', () => {
      it('accepts valid hold input', () => {
        const result = CreateHoldSchema.parse({
          transactionId: 'txn_123',
          reason: 'Quality review',
        });
        expect(result.transactionId).toBe('txn_123');
      });

      it('accepts optional amount and holdUntil', () => {
        const holdUntil = new Date('2025-01-01');
        const result = CreateHoldSchema.parse({
          transactionId: 'txn_123',
          amount: 500,
          holdUntil,
        });
        expect(result.amount).toBe(500);
        expect(result.holdUntil).toEqual(holdUntil);
      });
    });

    describe('ReleaseHoldSchema', () => {
      it('accepts valid release input', () => {
        const result = ReleaseHoldSchema.parse({
          transactionId: 'txn_123',
          recipientId: 'user_123',
        });
        expect(result.recipientId).toBe('user_123');
        expect(result.recipientType).toBe('user'); // default
      });

      it('accepts partial release with amount', () => {
        const result = ReleaseHoldSchema.parse({
          transactionId: 'txn_123',
          recipientId: 'user_123',
          amount: 500,
          notes: 'Partial release after review',
        });
        expect(result.amount).toBe(500);
        expect(result.notes).toBe('Partial release after review');
      });
    });
  });

  // ============ CONFIG SCHEMAS ============
  describe('Config Schemas', () => {
    describe('ProviderConfigSchema', () => {
      it('accepts any record of string to unknown', () => {
        const config = {
          apiKey: 'sk_test_123',
          webhookSecret: 'whsec_123',
          sandbox: true,
        };
        expect(ProviderConfigSchema.parse(config)).toEqual(config);
      });
    });

    describe('RetryConfigSchema', () => {
      it('applies default values', () => {
        const result = RetryConfigSchema.parse({});
        expect(result.maxAttempts).toBe(3);
        expect(result.baseDelay).toBe(1000);
        expect(result.maxDelay).toBe(30000);
        expect(result.backoffMultiplier).toBe(2);
        expect(result.jitter).toBe(0.1);
      });

      it('accepts custom values', () => {
        const result = RetryConfigSchema.parse({
          maxAttempts: 5,
          baseDelay: 500,
          jitter: 0.2,
        });
        expect(result.maxAttempts).toBe(5);
        expect(result.baseDelay).toBe(500);
        expect(result.jitter).toBe(0.2);
      });

      it('rejects invalid jitter range', () => {
        expect(() => RetryConfigSchema.parse({ jitter: 1.5 })).toThrow();
        expect(() => RetryConfigSchema.parse({ jitter: -0.1 })).toThrow();
      });
    });

    describe('RevenueConfigSchema', () => {
      it('applies default values', () => {
        const result = RevenueConfigSchema.parse({});
        expect(result.defaultCurrency).toBe('USD');
        expect(result.debug).toBe(false);
        expect(result.environment).toBe('development');
      });

      it('accepts valid environment values', () => {
        expect(RevenueConfigSchema.parse({ environment: 'production' }).environment).toBe(
          'production'
        );
        expect(RevenueConfigSchema.parse({ environment: 'staging' }).environment).toBe('staging');
      });

      it('rejects invalid environment', () => {
        expect(() => RevenueConfigSchema.parse({ environment: 'test' })).toThrow();
      });

      it('accepts nested commission config', () => {
        const result = RevenueConfigSchema.parse({
          commission: {
            platformRate: 15,
            gatewayFeeRate: 2.9,
          },
        });
        expect(result.commission?.platformRate).toBe(15);
      });
    });
  });

  // ============ VALIDATION HELPERS ============
  describe('Validation Helpers', () => {
    describe('validate()', () => {
      it('returns parsed value on success', () => {
        const result = validate(ObjectIdSchema, '507f1f77bcf86cd799439011');
        expect(result).toBe('507f1f77bcf86cd799439011');
      });

      it('throws ZodError on failure', () => {
        expect(() => validate(ObjectIdSchema, 'invalid')).toThrow();
      });

      it('works with complex schemas', () => {
        const result = validate(CreatePaymentSchema, {
          amount: 1000,
          customerId: 'cust_1',
          organizationId: 'org_1',
          provider: 'test',
        });
        expect(result.amount).toBe(1000);
      });
    });

    describe('safeValidate()', () => {
      it('returns success result on valid input', () => {
        const result = safeValidate(ObjectIdSchema, '507f1f77bcf86cd799439011');
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe('507f1f77bcf86cd799439011');
        }
      });

      it('returns error result on invalid input', () => {
        const result = safeValidate(ObjectIdSchema, 'invalid');
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBeDefined();
          expect(result.error.issues.length).toBeGreaterThan(0);
        }
      });

      it('does not throw on invalid input', () => {
        expect(() => safeValidate(ObjectIdSchema, 'invalid')).not.toThrow();
      });
    });

    describe('formatZodError()', () => {
      it('formats single error correctly', () => {
        const result = safeValidate(ObjectIdSchema, 'invalid');
        if (!result.success) {
          const formatted = formatZodError(result.error);
          expect(formatted).toContain('Invalid ObjectId format');
        }
      });

      it('formats multiple errors correctly', () => {
        const result = safeValidate(CreatePaymentSchema, {
          amount: -100, // invalid
          customerId: '', // invalid
          organizationId: 'org_1',
          provider: 'test',
        });
        if (!result.success) {
          const formatted = formatZodError(result.error);
          expect(formatted).toContain(','); // multiple errors separated
        }
      });

      it('includes field path in error message', () => {
        const result = safeValidate(CreatePaymentSchema, {
          amount: 1000,
          customerId: '', // invalid
          organizationId: 'org_1',
          provider: 'test',
        });
        if (!result.success) {
          const formatted = formatZodError(result.error);
          expect(formatted).toContain('customerId');
        }
      });
    });
  });

  // ============ EDGE CASES ============
  describe('Edge Cases', () => {
    it('handles null input gracefully', () => {
      const result = safeValidate(CreatePaymentSchema, null);
      expect(result.success).toBe(false);
    });

    it('handles undefined input gracefully', () => {
      const result = safeValidate(CreatePaymentSchema, undefined);
      expect(result.success).toBe(false);
    });

    it('handles empty object input', () => {
      const result = safeValidate(CreatePaymentSchema, {});
      expect(result.success).toBe(false);
    });

    it('strips unknown properties by default', () => {
      const result = CreatePaymentSchema.parse({
        amount: 1000,
        customerId: 'cust_1',
        organizationId: 'org_1',
        provider: 'test',
        unknownProp: 'should be stripped',
      });
      expect((result as Record<string, unknown>).unknownProp).toBeUndefined();
    });

    it('handles large amounts', () => {
      const result = MoneyAmountSchema.parse(999999999);
      expect(result).toBe(999999999);
    });

    it('handles zero amount', () => {
      const result = MoneyAmountSchema.parse(0);
      expect(result).toBe(0);
    });
  });
});
