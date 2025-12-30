/**
 * Tax Types
 * @classytic/revenue
 *
 * Type definitions for tax calculation
 */

/**
 * Tax Configuration
 * Apps provide this configuration based on their jurisdiction
 *
 * Philosophy: Apps know their tax rules, library does the math
 *
 * @example
 * ```typescript
 * // Australia - 10% GST
 * const taxConfig: TaxConfig = {
 *   isRegistered: true,
 *   defaultRate: 0.10,
 *   pricesIncludeTax: false,
 *   exemptCategories: ['education', 'medical'],
 * };
 * ```
 */
export interface TaxConfig {
  /** Is the organization registered for tax collection? */
  isRegistered: boolean;

  /** Default tax rate (0-1, e.g., 0.15 = 15%) */
  defaultRate: number;

  /** Do displayed prices include tax? */
  pricesIncludeTax: boolean;

  /** Categories exempt from tax (e.g., groceries, education) */
  exemptCategories?: string[];
}

/**
 * Tax Calculation Result
 * Returned by calculateTax() utility
 */
export interface TaxCalculation {
  /** Is tax applicable for this transaction? */
  isApplicable: boolean;

  /** Tax rate used (0-1) */
  rate: number;

  /** Base amount (before tax) */
  baseAmount: number;

  /** Tax amount */
  taxAmount: number;

  /** Total amount (base + tax) */
  totalAmount: number;

  /** Were prices tax-inclusive? */
  pricesIncludeTax: boolean;

  /** Tax type */
  type?: TaxType;
}

/**
 * Tax Type
 * Indicates whether tax is collected or paid
 */
export type TaxType = 'collected' | 'paid' | 'exempt';

/**
 * Type guard for TaxType
 */
export function isTaxType(value: unknown): value is TaxType {
  return value === 'collected' || value === 'paid' || value === 'exempt';
}
