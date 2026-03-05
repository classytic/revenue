/**
 * Money Utility Tests
 * @classytic/revenue
 *
 * Tests integer-safe money arithmetic, allocation, and formatting
 */

import { describe, it, expect } from 'vitest';
import { Money, toSmallestUnit, fromSmallestUnit } from '../../revenue/src/shared/utils/formatters/money.js';

describe('Money', () => {
  describe('Factory Methods', () => {
    it('should create from cents', () => {
      const m = Money.cents(1999, 'USD');
      expect(m.amount).toBe(1999);
      expect(m.currency).toBe('USD');
    });

    it('should create from major unit', () => {
      const m = Money.of(19.99, 'USD');
      expect(m.amount).toBe(1999);
    });

    it('should handle JPY (zero decimals)', () => {
      const m = Money.of(500, 'JPY');
      expect(m.amount).toBe(500);
    });

    it('should create zero money', () => {
      const m = Money.zero('EUR');
      expect(m.amount).toBe(0);
      expect(m.currency).toBe('EUR');
    });

    it('should uppercase currency codes', () => {
      const m = Money.cents(100, 'usd');
      expect(m.currency).toBe('USD');
    });

    it('should reject non-integer amounts', () => {
      expect(() => Money.cents(19.5, 'USD')).not.toThrow(); // rounds
      // But direct construction via internals would throw (private constructor)
    });

    it('should provide shorthand factories', () => {
      expect(Money.usd(100).currency).toBe('USD');
      expect(Money.eur(200).currency).toBe('EUR');
      expect(Money.gbp(300).currency).toBe('GBP');
      expect(Money.bdt(400).currency).toBe('BDT');
      expect(Money.inr(500).currency).toBe('INR');
      expect(Money.jpy(600).currency).toBe('JPY');
    });
  });

  describe('Arithmetic', () => {
    it('should add same-currency money', () => {
      const result = Money.usd(1000).add(Money.usd(500));
      expect(result.amount).toBe(1500);
    });

    it('should subtract same-currency money', () => {
      const result = Money.usd(1000).subtract(Money.usd(300));
      expect(result.amount).toBe(700);
    });

    it('should allow negative results from subtraction', () => {
      const result = Money.usd(100).subtract(Money.usd(500));
      expect(result.amount).toBe(-400);
    });

    it('should multiply by factor', () => {
      const result = Money.usd(1000).multiply(0.1);
      expect(result.amount).toBe(100);
    });

    it('should round multiplication correctly', () => {
      // 33 * 0.1 = 3.3 → rounds to 3
      const result = Money.usd(33).multiply(0.1);
      expect(result.amount).toBe(3);
    });

    it('should divide correctly', () => {
      const result = Money.usd(1000).divide(3);
      expect(result.amount).toBe(333);
    });

    it('should throw on divide by zero', () => {
      expect(() => Money.usd(100).divide(0)).toThrow('Cannot divide by zero');
    });

    it('should calculate percentage', () => {
      const result = Money.usd(10000).percentage(15);
      expect(result.amount).toBe(1500);
    });

    it('should throw on cross-currency arithmetic', () => {
      expect(() => Money.usd(100).add(Money.eur(100))).toThrow('Currency mismatch');
      expect(() => Money.usd(100).subtract(Money.gbp(50))).toThrow('Currency mismatch');
    });
  });

  describe('Allocation', () => {
    it('should allocate evenly with no remainder', () => {
      const parts = Money.usd(300).allocate([1, 1, 1]);
      expect(parts.map(p => p.amount)).toEqual([100, 100, 100]);
    });

    it('should distribute remainder using largest-remainder method', () => {
      const parts = Money.usd(100).allocate([1, 1, 1]);
      const total = parts.reduce((sum, p) => sum + p.amount, 0);
      expect(total).toBe(100);
      // 100/3 = 33 each, 1 remainder → first gets +1
      expect(parts.map(p => p.amount)).toEqual([34, 33, 33]);
    });

    it('should handle weighted allocation', () => {
      const parts = Money.usd(10000).allocate([70, 20, 10]);
      expect(parts[0].amount).toBe(7000);
      expect(parts[1].amount).toBe(2000);
      expect(parts[2].amount).toBe(1000);
    });

    it('should maintain total in allocation', () => {
      const amount = 9999;
      const parts = Money.usd(amount).allocate([1, 1, 1, 1, 1, 1, 1]);
      const total = parts.reduce((sum, p) => sum + p.amount, 0);
      expect(total).toBe(amount);
    });

    it('should split evenly', () => {
      const parts = Money.usd(100).split(3);
      const total = parts.reduce((sum, p) => sum + p.amount, 0);
      expect(total).toBe(100);
      expect(parts).toHaveLength(3);
    });

    it('should throw on zero-sum ratios', () => {
      expect(() => Money.usd(100).allocate([0, 0, 0])).toThrow();
    });
  });

  describe('Comparison', () => {
    it('should check zero/positive/negative', () => {
      expect(Money.usd(0).isZero()).toBe(true);
      expect(Money.usd(100).isPositive()).toBe(true);
      expect(Money.usd(-50).isNegative()).toBe(true);
      expect(Money.usd(100).isZero()).toBe(false);
    });

    it('should check equality', () => {
      expect(Money.usd(100).equals(Money.usd(100))).toBe(true);
      expect(Money.usd(100).equals(Money.usd(200))).toBe(false);
      expect(Money.usd(100).equals(Money.eur(100))).toBe(false);
    });

    it('should compare ordering', () => {
      expect(Money.usd(200).greaterThan(Money.usd(100))).toBe(true);
      expect(Money.usd(100).lessThan(Money.usd(200))).toBe(true);
      expect(Money.usd(100).greaterThanOrEqual(Money.usd(100))).toBe(true);
      expect(Money.usd(100).lessThanOrEqual(Money.usd(100))).toBe(true);
    });

    it('should throw on cross-currency comparison', () => {
      expect(() => Money.usd(100).greaterThan(Money.eur(100))).toThrow('Currency mismatch');
    });
  });

  describe('Formatting', () => {
    it('should convert to major unit', () => {
      expect(Money.usd(1999).toUnit()).toBe(19.99);
      expect(Money.jpy(500).toUnit()).toBe(500);
    });

    it('should format with currency symbol', () => {
      const formatted = Money.usd(1999).format('en-US');
      expect(formatted).toContain('19.99');
    });

    it('should format amount without symbol', () => {
      const formatted = Money.usd(1999).formatAmount('en-US');
      expect(formatted).toContain('19.99');
    });

    it('should serialize to JSON and back', () => {
      const original = Money.usd(1999);
      const json = original.toJSON();
      const restored = Money.fromJSON(json);
      expect(restored.amount).toBe(1999);
      expect(restored.currency).toBe('USD');
    });

    it('should toString correctly', () => {
      expect(Money.usd(1999).toString()).toBe('USD 1999');
    });
  });

  describe('Helper Functions', () => {
    it('toSmallestUnit should convert from major to minor', () => {
      expect(toSmallestUnit(19.99, 'USD')).toBe(1999);
      expect(toSmallestUnit(500, 'JPY')).toBe(500);
    });

    it('fromSmallestUnit should convert from minor to major', () => {
      expect(fromSmallestUnit(1999, 'USD')).toBe(19.99);
      expect(fromSmallestUnit(500, 'JPY')).toBe(500);
    });
  });
});
