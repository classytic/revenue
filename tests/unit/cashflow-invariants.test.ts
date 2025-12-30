/**
 * Cashflow Invariants Test Suite
 * @classytic/revenue
 *
 * Tests mathematical correctness of all financial operations
 * Ensures money conservation laws are maintained
 */

import { describe, it, expect } from 'vitest';
import { calculateCommission, reverseCommission } from '../../revenue/src/shared/utils/calculators/commission.js';
import { calculateTax, reverseTax } from '../../revenue/src/shared/utils/calculators/tax.js';
import { calculateSplits, reverseSplits } from '../../revenue/src/shared/utils/calculators/commission-split.js';

describe('Cashflow Invariants', () => {
  describe('Tax Calculation Invariants', () => {
    it('should maintain: total = baseAmount + taxAmount', () => {
      const testCases = [
        { amount: 10000, rate: 0.15, pricesIncludeTax: false },
        { amount: 50000, rate: 0.10, pricesIncludeTax: false },
        { amount: 100000, rate: 0.20, pricesIncludeTax: false },
        { amount: 1, rate: 0.15, pricesIncludeTax: false }, // Edge case: $0.01
        { amount: 999999999, rate: 0.15, pricesIncludeTax: false }, // Edge case: large amount
      ];

      testCases.forEach(({ amount, rate, pricesIncludeTax }) => {
        const config = {
          isRegistered: true,
          defaultRate: rate,
          pricesIncludeTax,
          exemptCategories: [],
        };

        const result = calculateTax(amount, 'subscription', config);

        // Invariant: total = baseAmount + taxAmount
        expect(result.totalAmount).toBe(result.baseAmount + result.taxAmount);

        // All amounts must be integers (cents)
        expect(Number.isInteger(result.baseAmount)).toBe(true);
        expect(Number.isInteger(result.taxAmount)).toBe(true);
        expect(Number.isInteger(result.totalAmount)).toBe(true);

        // Tax amount should match expected calculation
        const expectedTaxAmount = Math.round(amount * rate);
        expect(result.taxAmount).toBe(expectedTaxAmount);
        expect(result.totalAmount).toBe(amount + expectedTaxAmount);
      });
    });

    it('should maintain: baseAmount = totalAmount - taxAmount when prices include tax', () => {
      const testCases = [
        { amount: 11500, rate: 0.15 }, // $115 with 15% tax included
        { amount: 22000, rate: 0.10 }, // $220 with 10% tax included
        { amount: 12000, rate: 0.20 }, // $120 with 20% tax included
      ];

      testCases.forEach(({ amount, rate }) => {
        const config = {
          isRegistered: true,
          defaultRate: rate,
          pricesIncludeTax: true,
          exemptCategories: [],
        };

        const result = calculateTax(amount, 'subscription', config);

        // Invariant: baseAmount = totalAmount - taxAmount
        expect(result.baseAmount).toBe(result.totalAmount - result.taxAmount);

        // Total should equal input when tax is included
        expect(result.totalAmount).toBe(amount);

        // All amounts must be integers
        expect(Number.isInteger(result.baseAmount)).toBe(true);
        expect(Number.isInteger(result.taxAmount)).toBe(true);
      });
    });

    it('should maintain conservation on tax reversal: refundTax ≤ originalTax', () => {
      const originalAmount = 11500; // Total with tax
      const config = {
        isRegistered: true,
        defaultRate: 0.15,
        pricesIncludeTax: false,
        exemptCategories: [],
      };

      const originalTax = calculateTax(10000, 'subscription', config);

      const testCases = [
        { refundAmount: 5750, label: 'partial refund (50%)' }, // 50% of total
        { refundAmount: 11500, label: 'full refund (100%)' },
        { refundAmount: 2875, label: 'partial refund (25%)' }, // 25% of total
      ];

      testCases.forEach(({ refundAmount, label }) => {
        const reversedTax = reverseTax(originalTax, originalAmount, refundAmount);

        // Invariant: refund tax cannot exceed original tax
        expect(reversedTax.taxAmount).toBeLessThanOrEqual(originalTax.taxAmount);

        // Proportionality check
        const expectedRefundTax = Math.round(
          (refundAmount / originalAmount) * originalTax.taxAmount
        );
        expect(reversedTax.taxAmount).toBe(expectedRefundTax);

        // All amounts must be integers
        expect(Number.isInteger(reversedTax.taxAmount)).toBe(true);
        expect(Number.isInteger(reversedTax.baseAmount)).toBe(true);
        expect(Number.isInteger(reversedTax.totalAmount)).toBe(true);
      });
    });
  });

  describe('Commission Calculation Invariants', () => {
    it('should maintain: netAmount ≤ grossAmount', () => {
      const testCases = [
        { amount: 10000, commissionRate: 0.10, gatewayFeeRate: 0.029 },
        { amount: 50000, commissionRate: 0.15, gatewayFeeRate: 0.035 },
        { amount: 100000, commissionRate: 0.05, gatewayFeeRate: 0.025 },
        { amount: 1, commissionRate: 0.10, gatewayFeeRate: 0.029 }, // Edge case
      ];

      testCases.forEach(({ amount, commissionRate, gatewayFeeRate }) => {
        const result = calculateCommission(amount, commissionRate, gatewayFeeRate);

        // Invariant: net cannot exceed gross
        expect(result!.netAmount).toBeLessThanOrEqual(result!.grossAmount);

        // Invariant: net = gross - gateway fees
        expect(result!.netAmount).toBe(result!.grossAmount - result!.gatewayFeeAmount);

        // All amounts must be integers
        expect(Number.isInteger(result!.grossAmount)).toBe(true);
        expect(Number.isInteger(result!.gatewayFeeAmount)).toBe(true);
        expect(Number.isInteger(result!.netAmount)).toBe(true);

        // Non-negative check
        expect(result!.grossAmount).toBeGreaterThanOrEqual(0);
        expect(result!.gatewayFeeAmount).toBeGreaterThanOrEqual(0);
        expect(result!.netAmount).toBeGreaterThanOrEqual(0);
      });
    });

    it('should maintain conservation on commission reversal', () => {
      const originalAmount = 10000;
      const originalCommission = calculateCommission(originalAmount, 0.10, 0.029);

      const testCases = [
        { refundAmount: 5000, label: 'partial refund (50%)' },
        { refundAmount: 10000, label: 'full refund (100%)' },
        { refundAmount: 2500, label: 'partial refund (25%)' },
      ];

      testCases.forEach(({ refundAmount, label }) => {
        const reversedCommission = reverseCommission(
          originalCommission,
          originalAmount,
          refundAmount
        );

        // Invariant: refund amounts cannot exceed original amounts
        expect(reversedCommission!.grossAmount).toBeLessThanOrEqual(
          originalCommission!.grossAmount
        );
        expect(reversedCommission!.gatewayFeeAmount).toBeLessThanOrEqual(
          originalCommission!.gatewayFeeAmount
        );
        expect(reversedCommission!.netAmount).toBeLessThanOrEqual(
          originalCommission!.netAmount
        );

        // Proportionality check
        const refundRatio = refundAmount / originalAmount;
        expect(reversedCommission!.grossAmount).toBe(
          Math.round(originalCommission!.grossAmount * refundRatio)
        );

        // All amounts must be integers
        expect(Number.isInteger(reversedCommission!.grossAmount)).toBe(true);
        expect(Number.isInteger(reversedCommission!.netAmount)).toBe(true);
        expect(Number.isInteger(reversedCommission!.gatewayFeeAmount)).toBe(true);
      });
    });
  });

  describe('Split Distribution Invariants', () => {
    it('should maintain: sum(splits) = grossAmount (when calculated)', () => {
      const testCases = [
        {
          amount: 10000,
          splitRules: [
            { recipientId: 'user1', recipientType: 'user', rate: 0.50 },
            { recipientId: 'user2', recipientType: 'user', rate: 0.30 },
          ],
        },
        {
          amount: 50000,
          splitRules: [
            { recipientId: 'creator1', recipientType: 'user', rate: 0.60 },
            { recipientId: 'creator2', recipientType: 'user', rate: 0.25 },
          ],
        },
      ];

      testCases.forEach(({ amount, splitRules }) => {
        const splits = calculateSplits(amount, splitRules, 0);

        // Calculate sum of all split amounts
        const totalSplitAmount = splits.reduce(
          (sum, split) => sum + split.grossAmount,
          0
        );

        // Calculate total rate
        const totalRate = splitRules.reduce((sum, rule) => sum + rule.rate, 0);
        const expectedTotal = Math.round(amount * totalRate);

        // Invariant: sum of splits matches expected total
        expect(totalSplitAmount).toBe(expectedTotal);

        // All split amounts must be integers
        splits.forEach((split) => {
          expect(Number.isInteger(split.grossAmount)).toBe(true);
          expect(split.grossAmount).toBeGreaterThanOrEqual(0);
        });
      });
    });

    it('should maintain proportionality: split.amount = grossAmount * rate', () => {
      const amount = 10000;
      const splitRules = [
        { recipientId: 'user1', recipientType: 'user', rate: 0.50 },
        { recipientId: 'user2', recipientType: 'user', rate: 0.30 },
      ];

      const splits = calculateSplits(amount, splitRules, 0);

      splits.forEach((split, index) => {
        const expectedAmount = Math.round(amount * splitRules[index].rate);
        expect(split.grossAmount).toBe(expectedAmount);
        expect(split.rate).toBe(splitRules[index].rate);
      });
    });

    it('should maintain conservation on split reversal', () => {
      const originalAmount = 10000;
      const splitRules = [
        { recipientId: 'user1', recipientType: 'user', rate: 0.50 },
        { recipientId: 'user2', recipientType: 'user', rate: 0.30 },
      ];

      const originalSplits = calculateSplits(originalAmount, splitRules, 0);

      const refundAmount = 5000; // 50% refund

      const reversedSplits = reverseSplits(originalSplits, originalAmount, refundAmount);

      // Invariant: refund amounts cannot exceed original amounts
      reversedSplits.forEach((refundSplit, index) => {
        expect(refundSplit.grossAmount).toBeLessThanOrEqual(
          originalSplits[index].grossAmount
        );
        expect(refundSplit.netAmount).toBeLessThanOrEqual(
          originalSplits[index].netAmount
        );

        // Proportionality check
        const refundRatio = refundAmount / originalAmount;
        expect(refundSplit.grossAmount).toBe(
          Math.round(originalSplits[index].grossAmount * refundRatio)
        );

        // All amounts must be integers
        expect(Number.isInteger(refundSplit.grossAmount)).toBe(true);
        expect(Number.isInteger(refundSplit.netAmount)).toBe(true);
      });
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle zero amounts correctly', () => {
      const zeroCommission = calculateCommission(0, 0.10, 0.029);
      expect(zeroCommission!.grossAmount).toBe(0);
      expect(zeroCommission!.gatewayFeeAmount).toBe(0);
      expect(zeroCommission!.netAmount).toBe(0);

      const zeroTax = calculateTax(0, 'subscription', {
        isRegistered: true,
        defaultRate: 0.15,
        pricesIncludeTax: false,
        exemptCategories: [],
      });
      expect(zeroTax.baseAmount).toBe(0);
      expect(zeroTax.taxAmount).toBe(0);
      expect(zeroTax.totalAmount).toBe(0);
    });

    it('should handle very small amounts without rounding errors', () => {
      // $0.01 with 15% tax
      const tax = calculateTax(1, 'subscription', {
        isRegistered: true,
        defaultRate: 0.15,
        pricesIncludeTax: false,
        exemptCategories: [],
      });

      expect(Number.isInteger(tax.taxAmount)).toBe(true);
      expect(tax.totalAmount).toBe(tax.baseAmount + tax.taxAmount);

      // $0.01 with 10% commission
      const commission = calculateCommission(1, 0.10, 0.029);
      expect(Number.isInteger(commission!.grossAmount)).toBe(true);
      expect(Number.isInteger(commission!.netAmount)).toBe(true);
    });

    it('should handle very large amounts without overflow', () => {
      const largeAmount = 999999999; // $9,999,999.99

      const tax = calculateTax(largeAmount, 'subscription', {
        isRegistered: true,
        defaultRate: 0.15,
        pricesIncludeTax: false,
        exemptCategories: [],
      });

      expect(Number.isInteger(tax.totalAmount)).toBe(true);
      expect(tax.totalAmount).toBeGreaterThan(largeAmount);

      const commission = calculateCommission(largeAmount, 0.10, 0.029);
      expect(Number.isInteger(commission!.grossAmount)).toBe(true);
      expect(commission!.netAmount).toBeLessThan(commission!.grossAmount);
    });

    it('should throw on invalid refund amounts', () => {
      const originalAmount = 10000;
      const originalCommission = calculateCommission(originalAmount, 0.10, 0.029);

      // Refund exceeds original
      expect(() => {
        reverseCommission(originalCommission, originalAmount, 15000);
      }).toThrow();

      // Negative refund
      expect(() => {
        reverseCommission(originalCommission, originalAmount, -100);
      }).toThrow();

      // Zero original amount
      expect(() => {
        reverseCommission(originalCommission, 0, 5000);
      }).toThrow();
    });
  });

  describe('Combined Financial Operations', () => {
    it('should maintain total conservation across tax + commission + splits', () => {
      const baseAmount = 10000; // $100

      // 1. Calculate tax
      const tax = calculateTax(baseAmount, 'subscription', {
        isRegistered: true,
        defaultRate: 0.15,
        pricesIncludeTax: false,
        exemptCategories: [],
      });

      // 2. Calculate commission on total (base + tax)
      const commission = calculateCommission(tax.totalAmount, 0.10, 0.029);

      // 3. Calculate splits on gross commission
      const splitRules = [
        { recipientId: 'creator', recipientType: 'user', rate: 0.70 },
        { recipientId: 'platform', recipientType: 'platform', rate: 0.30 },
      ];
      const splits = calculateSplits(commission!.grossAmount, splitRules, 0);

      // Invariant checks
      expect(tax.totalAmount).toBe(tax.baseAmount + tax.taxAmount);
      expect(commission!.netAmount).toBe(
        commission!.grossAmount - commission!.gatewayFeeAmount
      );

      const totalSplitAmount = splits.reduce(
        (sum, split) => sum + split.grossAmount,
        0
      );
      const totalRate = splitRules.reduce((sum, rule) => sum + rule.rate, 0);
      expect(totalSplitAmount).toBe(Math.round(commission!.grossAmount * totalRate));

      // All amounts are integers
      expect(Number.isInteger(tax.totalAmount)).toBe(true);
      expect(Number.isInteger(commission!.grossAmount)).toBe(true);
      splits.forEach((split) => {
        expect(Number.isInteger(split.grossAmount)).toBe(true);
      });
    });

    it('should maintain conservation during full transaction refund with tax and splits', () => {
      const originalAmount = 10000;

      // Original transaction
      const originalTax = calculateTax(originalAmount, 'subscription', {
        isRegistered: true,
        defaultRate: 0.15,
        pricesIncludeTax: false,
        exemptCategories: [],
      });

      const originalCommission = calculateCommission(
        originalTax.totalAmount,
        0.10,
        0.029
      );

      const splitRules = [
        { recipientId: 'creator', recipientType: 'user', rate: 0.70 },
      ];
      const originalSplits = calculateSplits(
        originalCommission!.grossAmount,
        splitRules,
        0
      );

      // Full refund on total (including tax)
      const refundTotalAmount = originalTax.totalAmount;

      const refundTax = reverseTax(originalTax, originalTax.totalAmount, refundTotalAmount);
      const refundCommission = reverseCommission(
        originalCommission,
        originalTax.totalAmount,
        refundTotalAmount
      );
      const refundSplits = reverseSplits(
        originalSplits,
        originalCommission!.grossAmount,
        refundCommission!.grossAmount
      );

      // Invariants for full refund (100%)
      expect(refundTax.taxAmount).toBe(originalTax.taxAmount);
      expect(refundCommission!.grossAmount).toBe(originalCommission!.grossAmount);

      refundSplits.forEach((split, index) => {
        expect(split.grossAmount).toBe(originalSplits[index].grossAmount);
      });
    });
  });
});
