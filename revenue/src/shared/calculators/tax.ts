/**
 * Tax on a payment transaction, in integer minor units — through `@classytic/tax-core/math`, the one
 * implementation of a rate applied to an amount (half away from zero on the tax).
 *
 * A transaction for a DOCUMENT that already carries its tax (an order's stored breakdown) records the
 * document's tax (`statedTax` on `createPaymentIntent`); `calculateTax` is only for a payment with no
 * such document, at the deployment's single rate.
 */
import { apportion } from '@classytic/primitives/proration';
import { taxInInclusive, taxOnExclusive } from '@classytic/tax-core/math';
import { ValidationError } from '../../core/errors.js';

export interface TaxConfig {
  isRegistered: boolean;
  /** A FRACTION (0.15), never a percentage. */
  defaultRate: number;
  pricesIncludeTax: boolean;
  exemptCategories?: string[];
}

export interface TaxCalculation {
  isApplicable: boolean;
  rate: number;
  baseAmount: number;
  taxAmount: number;
  totalAmount: number;
  pricesIncludeTax: boolean;
  type?: TaxType;
}

export type TaxType = 'collected' | 'paid' | 'exempt';

/** A rate fraction (0.075) as the percent the exact math takes (7.5), to four decimals. */
const percentOf = (fraction: number) => Math.round(fraction * 1_000_000) / 10_000;

export function calculateTax(
  amount: number,
  category: string,
  config: TaxConfig | null,
): TaxCalculation {
  if (!config?.isRegistered || config.exemptCategories?.includes(category)) {
    return { isApplicable: false, rate: 0, baseAmount: amount, taxAmount: 0, totalAmount: amount, pricesIncludeTax: false };
  }
  const rate = config.defaultRate;
  if (config.pricesIncludeTax) {
    const taxAmount = taxInInclusive(amount, percentOf(rate));
    return { isApplicable: true, rate, baseAmount: amount - taxAmount, taxAmount, totalAmount: amount, pricesIncludeTax: true };
  }
  const taxAmount = taxOnExclusive(amount, percentOf(rate));
  return { isApplicable: true, rate, baseAmount: amount, taxAmount, totalAmount: amount + taxAmount, pricesIncludeTax: false };
}

export function getTaxType(
  transactionFlow: 'inflow' | 'outflow',
  category: string,
  exemptCategories: string[] = [],
): TaxType {
  if (exemptCategories.includes(category)) return 'exempt';
  return transactionFlow === 'inflow' ? 'collected' : 'paid';
}

/**
 * The tax a refund of `refundAmount` reverses: each figure is the original's share, by largest
 * remainder, so a full refund returns exactly the original tax and parts never sum past it.
 */
export function reverseTax(
  originalTax: TaxCalculation & { type?: TaxType },
  originalAmount: number,
  refundAmount: number,
): TaxCalculation & { type?: TaxType } {
  if (!originalTax.isApplicable) {
    return { isApplicable: false, rate: 0, baseAmount: refundAmount, taxAmount: 0, totalAmount: refundAmount, pricesIncludeTax: false };
  }
  if (!originalAmount || originalAmount <= 0) throw new ValidationError('Original amount must be greater than 0');
  if (refundAmount < 0) throw new ValidationError('Refund amount cannot be negative');
  if (refundAmount > originalAmount) throw new ValidationError('Refund amount exceeds original amount');

  const reversedType: TaxType | undefined = originalTax.type
    ? originalTax.type === 'collected' ? 'paid' : originalTax.type === 'paid' ? 'collected' : 'exempt'
    : undefined;
  const taxAmount = apportion(originalTax.taxAmount, refundAmount, originalAmount);
  const totalAmount = apportion(originalTax.totalAmount, refundAmount, originalAmount);
  return {
    isApplicable: true,
    rate: originalTax.rate,
    baseAmount: totalAmount - taxAmount,
    taxAmount,
    totalAmount,
    pricesIncludeTax: originalTax.pricesIncludeTax,
    ...(reversedType ? { type: reversedType } : {}),
  };
}

/** Base + tax = total, exactly. */
export function validateTaxCalculation(tax: TaxCalculation): boolean {
  if (!tax.isApplicable) return true;
  return tax.baseAmount + tax.taxAmount === tax.totalAmount;
}
