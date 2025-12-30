/**
 * Tax Utilities
 * @classytic/revenue
 *
 * Tax calculation utilities
 * Philosophy: Apps provide rates, library does math (like Stripe)
 */

import type { TaxConfig, TaxCalculation, TaxType } from '../../types/tax.js';
import { ValidationError } from '../../../core/errors.js';

/**
 * Calculate tax for a transaction
 *
 * Handles both tax-inclusive and tax-exclusive pricing:
 * - Tax-exclusive: Customer pays baseAmount + tax
 * - Tax-inclusive: Customer pays totalAmount (which includes tax)
 *
 * @param amount - Transaction amount (in smallest currency unit, e.g., cents)
 * @param category - Transaction category (for exemption check)
 * @param config - Tax configuration from app
 * @returns Tax calculation result
 *
 * @example
 * ```typescript
 * // Tax-exclusive pricing (customer pays base + tax)
 * const result = calculateTax(10000, 'subscription', {
 *   isRegistered: true,
 *   defaultRate: 0.15,
 *   pricesIncludeTax: false,
 * });
 * // result = {
 * //   isApplicable: true,
 * //   rate: 0.15,
 * //   baseAmount: 10000,
 * //   taxAmount: 1500,
 * //   totalAmount: 11500,
 * //   pricesIncludeTax: false
 * // }
 *
 * // Tax-inclusive pricing (price already includes tax)
 * const result2 = calculateTax(11500, 'subscription', {
 *   isRegistered: true,
 *   defaultRate: 0.15,
 *   pricesIncludeTax: true,
 * });
 * // result2 = {
 * //   isApplicable: true,
 * //   rate: 0.15,
 * //   baseAmount: 10000,
 * //   taxAmount: 1500,
 * //   totalAmount: 11500,
 * //   pricesIncludeTax: true
 * // }
 * ```
 */
export function calculateTax(
  amount: number,
  category: string,
  config: TaxConfig | null
): TaxCalculation {
  // No tax if not registered or category is exempt
  if (!config?.isRegistered || config.exemptCategories?.includes(category)) {
    return {
      isApplicable: false,
      rate: 0,
      baseAmount: amount,
      taxAmount: 0,
      totalAmount: amount,
      pricesIncludeTax: false,
    };
  }

  const rate = config.defaultRate;

  // Calculate based on pricing model
  // Note: amounts are already in smallest unit (cents), so we round to integers
  const [baseAmount, taxAmount, totalAmount] = config.pricesIncludeTax
    ? [
        // Tax-inclusive: extract tax from total
        Math.round(amount / (1 + rate)),           // baseAmount
        Math.round(amount - amount / (1 + rate)),  // taxAmount
        amount,                                     // totalAmount (already integer)
      ]
    : [
        // Tax-exclusive: add tax to base
        amount,                                     // baseAmount (already integer)
        Math.round(amount * rate),                 // taxAmount
        Math.round(amount * (1 + rate)),          // totalAmount
      ];

  return {
    isApplicable: true,
    rate,
    baseAmount,
    taxAmount,
    totalAmount,
    pricesIncludeTax: config.pricesIncludeTax,
  };
}

/**
 * Get tax type based on transaction flow
 *
 * - Inflow transactions → tax is "collected" (you collect from customer)
 * - Outflow transactions → tax is "paid" (you pay to supplier)
 * - Exempt categories → "exempt"
 *
 * @param transactionFlow - 'inflow' or 'outflow'
 * @param category - Transaction category
 * @param exemptCategories - List of exempt categories
 * @returns Tax type
 *
 * @example
 * ```typescript
 * getTaxType('inflow', 'subscription', []) // 'collected'
 * getTaxType('outflow', 'refund', []) // 'paid'
 * getTaxType('inflow', 'education', ['education']) // 'exempt'
 * ```
 */
export function getTaxType(
  transactionFlow: 'inflow' | 'outflow',
  category: string,
  exemptCategories: string[] = []
): TaxType {
  if (exemptCategories.includes(category)) {
    return 'exempt';
  }

  return transactionFlow === 'inflow' ? 'collected' : 'paid';
}

/**
 * Reverse tax calculation for refunds
 * When refunding a transaction, tax must be reversed proportionally
 *
 * @param originalTax - Tax from original transaction
 * @param originalAmount - Original transaction amount
 * @param refundAmount - Amount being refunded
 * @returns Reversed tax calculation
 *
 * @example
 * ```typescript
 * // Original: $100 + $15 tax = $115
 * const originalTax = {
 *   isApplicable: true,
 *   rate: 0.15,
 *   baseAmount: 10000,
 *   taxAmount: 1500,
 *   totalAmount: 11500,
 *   type: 'collected',
 * };
 *
 * // Refund 50% ($57.50)
 * const refundTax = reverseTax(originalTax, 11500, 5750);
 * // refundTax = {
 * //   isApplicable: true,
 * //   rate: 0.15,
 * //   baseAmount: 5000,
 * //   taxAmount: 750,
 * //   totalAmount: 5750,
 * //   type: 'paid',  // Reversed!
 * // }
 * ```
 */
export function reverseTax(
  originalTax: TaxCalculation & { type?: TaxType },
  originalAmount: number,
  refundAmount: number
): TaxCalculation & { type?: TaxType } {
  if (!originalTax.isApplicable) {
    return {
      isApplicable: false,
      rate: 0,
      baseAmount: refundAmount,
      taxAmount: 0,
      totalAmount: refundAmount,
      pricesIncludeTax: false,
    };
  }

  // Edge case validations
  if (!originalAmount || originalAmount <= 0) {
    throw new ValidationError('Original amount must be greater than 0', { originalAmount });
  }

  if (refundAmount < 0) {
    throw new ValidationError('Refund amount cannot be negative', { refundAmount });
  }

  if (refundAmount > originalAmount) {
    throw new ValidationError(
      `Refund amount (${refundAmount}) exceeds original amount (${originalAmount})`,
      { refundAmount, originalAmount }
    );
  }

  // Calculate refund ratio
  const refundRatio = refundAmount / originalAmount;

  // Reverse tax type: collected → paid, paid → collected
  const reversedType: TaxType | undefined = originalTax.type
    ? originalTax.type === 'collected'
      ? 'paid'
      : originalTax.type === 'paid'
      ? 'collected'
      : 'exempt'
    : undefined;

  // Calculate reversed amounts (all in smallest unit, integers only)
  return {
    isApplicable: true,
    rate: originalTax.rate,
    baseAmount: Math.round(originalTax.baseAmount * refundRatio),
    taxAmount: Math.round(originalTax.taxAmount * refundRatio),
    totalAmount: Math.round(originalTax.totalAmount * refundRatio),
    pricesIncludeTax: originalTax.pricesIncludeTax,
    type: reversedType,
  };
}

/**
 * Validate tax calculation
 * Ensures the math is correct (base + tax = total)
 *
 * @param tax - Tax calculation to validate
 * @returns true if valid
 */
export function validateTaxCalculation(tax: TaxCalculation): boolean {
  if (!tax.isApplicable) return true;

  const calculatedTotal = tax.baseAmount + tax.taxAmount;
  const diff = Math.abs(calculatedTotal - tax.totalAmount);

  // Allow for 1 cent rounding difference
  return diff <= 1;
}
