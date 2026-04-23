export interface TaxConfig {
  isRegistered: boolean;
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

export function calculateTax(
  amount: number,
  category: string,
  config: TaxConfig | null,
): TaxCalculation {
  if (!config?.isRegistered || config.exemptCategories?.includes(category)) {
    return { isApplicable: false, rate: 0, baseAmount: amount, taxAmount: 0, totalAmount: amount, pricesIncludeTax: false };
  }

  const rate = config.defaultRate;
  const [baseAmount, taxAmount, totalAmount] = config.pricesIncludeTax
    ? [Math.round(amount / (1 + rate)), Math.round(amount - amount / (1 + rate)), amount]
    : [amount, Math.round(amount * rate), Math.round(amount * (1 + rate))];

  return { isApplicable: true, rate, baseAmount, taxAmount, totalAmount, pricesIncludeTax: config.pricesIncludeTax };
}

export function getTaxType(
  transactionFlow: 'inflow' | 'outflow',
  category: string,
  exemptCategories: string[] = [],
): TaxType {
  if (exemptCategories.includes(category)) return 'exempt';
  return transactionFlow === 'inflow' ? 'collected' : 'paid';
}

export function reverseTax(
  originalTax: TaxCalculation & { type?: TaxType },
  originalAmount: number,
  refundAmount: number,
): TaxCalculation & { type?: TaxType } {
  if (!originalTax.isApplicable) {
    return { isApplicable: false, rate: 0, baseAmount: refundAmount, taxAmount: 0, totalAmount: refundAmount, pricesIncludeTax: false };
  }
  if (!originalAmount || originalAmount <= 0) throw new Error('Original amount must be greater than 0');
  if (refundAmount < 0) throw new Error('Refund amount cannot be negative');
  if (refundAmount > originalAmount) throw new Error('Refund amount exceeds original amount');

  const refundRatio = refundAmount / originalAmount;
  const reversedType: TaxType | undefined = originalTax.type
    ? originalTax.type === 'collected' ? 'paid' : originalTax.type === 'paid' ? 'collected' : 'exempt'
    : undefined;

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

export function validateTaxCalculation(tax: TaxCalculation): boolean {
  if (!tax.isApplicable) return true;
  const diff = Math.abs(tax.baseAmount + tax.taxAmount - tax.totalAmount);
  return diff <= 1;
}
