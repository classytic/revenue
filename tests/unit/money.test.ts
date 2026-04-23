/**
 * Money Utility Tests — @classytic/revenue
 *
 * Revenue re-exports the canonical `Money` surface from
 * `@classytic/primitives/money` (PACKAGE_RULES P1/P12). These tests pin the
 * re-export contract so hosts continue to get functional equivalence and
 * revenue's own arithmetic stays integer-safe.
 */

import { describe, expect, it } from 'vitest';
import {
  addMoney,
  compareMoney,
  CurrencyMismatchError,
  equalsMoney,
  fromMajor,
  fromSmallestUnit,
  isNegativeMoney,
  isPositiveMoney,
  isZeroMoney,
  money,
  multiplyMoney,
  subtractMoney,
  sumMoney,
  toSmallestUnit,
} from '../../revenue/src/shared/formatters/money.js';
import { allocate } from '@classytic/primitives/split-allocation';

describe('Money (re-exported from @classytic/primitives/money)', () => {
  describe('Construction', () => {
    it('money() builds from minor-unit integer', () => {
      const m = money(1999, 'USD');
      expect(m.amount).toBe(1999);
      expect(m.currency).toBe('USD');
    });

    it('fromMajor() scales to minor units', () => {
      expect(fromMajor(19.99, 'USD').amount).toBe(1999);
    });

    it('fromMajor() respects JPY zero-decimal', () => {
      expect(fromMajor(500, 'JPY').amount).toBe(500);
    });

    it('fromMajor() respects KWD three-decimal', () => {
      expect(fromMajor(1.234, 'KWD').amount).toBe(1234);
    });

    it('money() rejects non-integer amounts', () => {
      expect(() => money(19.5, 'USD')).toThrow(TypeError);
    });

    it('money(0, currency) is the zero value', () => {
      const m = money(0, 'EUR');
      expect(m.amount).toBe(0);
      expect(m.currency).toBe('EUR');
      expect(isZeroMoney(m)).toBe(true);
    });
  });

  describe('Arithmetic', () => {
    it('addMoney sums same-currency values', () => {
      expect(addMoney(money(1000, 'USD'), money(500, 'USD')).amount).toBe(1500);
    });

    it('subtractMoney allows negative results', () => {
      expect(subtractMoney(money(100, 'USD'), money(500, 'USD')).amount).toBe(-400);
    });

    it('multiplyMoney rounds half-away-from-zero', () => {
      expect(multiplyMoney(money(33, 'USD'), 0.1).amount).toBe(3);
      expect(multiplyMoney(money(1000, 'USD'), 0.1).amount).toBe(100);
    });

    it('sumMoney zero-case returns zero in currency', () => {
      expect(sumMoney([], 'USD')).toEqual({ amount: 0, currency: 'USD' });
    });

    it('cross-currency arithmetic throws CurrencyMismatchError', () => {
      expect(() => addMoney(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
      expect(() => subtractMoney(money(100, 'USD'), money(50, 'GBP'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('Allocation (primitives/split-allocation)', () => {
    it('allocates evenly with no remainder', () => {
      const result = allocate(300, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'equal');
      expect(result.parts.map(p => p.amount)).toEqual([100, 100, 100]);
    });

    it('distributes remainder using largest-remainder method', () => {
      const result = allocate(100, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'equal');
      const total = result.parts.reduce((sum, p) => sum + p.amount, 0);
      expect(total).toBe(100);
      expect([...result.parts.map(p => p.amount)].sort()).toEqual([33, 33, 34]);
    });

    it('allocates proportionally to weights', () => {
      const result = allocate(
        10_000,
        [
          { id: 'a', weight: 70 },
          { id: 'b', weight: 20 },
          { id: 'c', weight: 10 },
        ],
        'by-weight',
      );
      expect(result.parts.map(p => p.amount)).toEqual([7000, 2000, 1000]);
    });

    it('preserves total with uneven input', () => {
      const result = allocate(
        9999,
        Array.from({ length: 7 }, (_, i) => ({ id: `s${i}` })),
        'equal',
      );
      const total = result.parts.reduce((sum, p) => sum + p.amount, 0);
      expect(total).toBe(9999);
    });
  });

  describe('Predicates and comparison', () => {
    it('isZero/isPositive/isNegative', () => {
      expect(isZeroMoney(money(0, 'USD'))).toBe(true);
      expect(isPositiveMoney(money(100, 'USD'))).toBe(true);
      expect(isNegativeMoney(money(-50, 'USD'))).toBe(true);
      expect(isZeroMoney(money(100, 'USD'))).toBe(false);
    });

    it('equalsMoney checks amount and currency', () => {
      expect(equalsMoney(money(100, 'USD'), money(100, 'USD'))).toBe(true);
      expect(equalsMoney(money(100, 'USD'), money(200, 'USD'))).toBe(false);
      expect(equalsMoney(money(100, 'USD'), money(100, 'EUR'))).toBe(false);
    });

    it('compareMoney returns -1 / 0 / 1', () => {
      expect(compareMoney(money(100, 'USD'), money(200, 'USD'))).toBe(-1);
      expect(compareMoney(money(200, 'USD'), money(100, 'USD'))).toBe(1);
      expect(compareMoney(money(100, 'USD'), money(100, 'USD'))).toBe(0);
    });

    it('compareMoney throws on cross-currency', () => {
      expect(() => compareMoney(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('Legacy minor<->major helpers', () => {
    it('toSmallestUnit converts major to minor', () => {
      expect(toSmallestUnit(19.99, 'USD')).toBe(1999);
      expect(toSmallestUnit(500, 'JPY')).toBe(500);
    });

    it('fromSmallestUnit converts minor to major', () => {
      expect(fromSmallestUnit(1999, 'USD')).toBe(19.99);
      expect(fromSmallestUnit(500, 'JPY')).toBe(500);
    });
  });
});
