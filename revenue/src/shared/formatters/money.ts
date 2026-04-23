/**
 * Money — re-export from `@classytic/primitives/money`.
 *
 * Per PACKAGE_RULES P1/P12: `Money`, arithmetic, and currency metadata all
 * live in primitives. Revenue does NOT redefine them. This file re-exports
 * the canonical surface so hosts can still do
 * `import { Money, money, addMoney } from '@classytic/revenue'` without
 * adding primitives as a direct dependency.
 *
 * `toSmallestUnit` / `fromSmallestUnit` are thin wrappers over
 * `fromMajor` / `toMajor` kept for downstream compatibility (be-prod's
 * `operational-transactions.ts` imports them).
 */
import {
  fromMajor,
  toMajor,
  money as makeMoney,
  type Money as PrimitiveMoney,
} from '@classytic/primitives/money';

export type {
  Money,
  Money as MoneyValue,
} from '@classytic/primitives/money';

export {
  money,
  fromMajor,
  toMajor,
  addMoney,
  subtractMoney,
  multiplyMoney,
  sumMoney,
  equalsMoney,
  compareMoney,
  isZeroMoney,
  isPositiveMoney,
  isNegativeMoney,
  negateMoney,
  absMoney,
  isMoney,
  CurrencyMismatchError,
} from '@classytic/primitives/money';

export {
  CURRENCIES,
  MINOR_UNIT_FACTOR,
  minorUnitFactor,
  toCurrencyCode,
  isCurrencyCode,
  type CurrencyCode,
} from '@classytic/primitives/currency';

/**
 * Convert a major-unit amount (e.g. 19.99 dollars) into the currency's
 * minor unit integer (e.g. 1999 cents). Wrapper over primitives' `fromMajor`.
 */
export function toSmallestUnit(amount: number, currency = 'USD'): number {
  return fromMajor(amount, currency).amount;
}

/**
 * Convert a minor-unit integer (e.g. 1999 cents) back to its major-unit
 * representation (e.g. 19.99). Wrapper over primitives' `toMajor`.
 */
export function fromSmallestUnit(amount: number, currency = 'USD'): number {
  return toMajor(makeMoney(amount, currency));
}

export type { PrimitiveMoney };
