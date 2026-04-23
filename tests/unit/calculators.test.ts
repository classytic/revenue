import { describe, expect, it } from 'vitest';
import { calculateCommission, reverseCommission } from '../../revenue/src/shared/calculators/commission.js';
import { calculateTax, getTaxType, reverseTax, validateTaxCalculation, type TaxConfig } from '../../revenue/src/shared/calculators/tax.js';
import { calculateSplits, calculateOrganizationPayout } from '../../revenue/src/shared/calculators/splits.js';

// ── Commission ──

describe('calculateCommission', () => {
  it('returns null when rate is 0', () => {
    expect(calculateCommission(10000, 0)).toBeNull();
  });

  it('returns null when rate is negative', () => {
    expect(calculateCommission(10000, -0.1)).toBeNull();
  });

  it('calculates correctly with no gateway fee', () => {
    const result = calculateCommission(10000, 0.1);
    expect(result).toEqual({
      rate: 0.1,
      grossAmount: 1000,
      gatewayFeeRate: 0,
      gatewayFeeAmount: 0,
      netAmount: 1000,
      status: 'pending',
    });
  });

  it('calculates correctly with gateway fee', () => {
    const result = calculateCommission(10000, 0.15, 0.03);
    expect(result!.grossAmount).toBe(1500);
    expect(result!.gatewayFeeAmount).toBe(300);
    expect(result!.netAmount).toBe(1200);
  });

  it('rounds to nearest integer (smallest currency unit)', () => {
    const result = calculateCommission(9999, 0.1);
    expect(result!.grossAmount).toBe(1000); // Math.round(999.9)
  });

  it('netAmount cannot go below 0 when fee exceeds commission', () => {
    const result = calculateCommission(10000, 0.01, 0.05);
    expect(result!.netAmount).toBe(0);
  });

  it('throws on negative amount', () => {
    expect(() => calculateCommission(-100, 0.1)).toThrow('cannot be negative');
  });

  it('throws on rate > 1', () => {
    expect(() => calculateCommission(10000, 1.5)).toThrow('between 0 and 1');
  });

  it('throws on gateway fee rate > 1', () => {
    expect(() => calculateCommission(10000, 0.1, 1.5)).toThrow('between 0 and 1');
  });

  it('handles zero amount', () => {
    const result = calculateCommission(0, 0.1);
    expect(result!.grossAmount).toBe(0);
    expect(result!.netAmount).toBe(0);
  });
});

describe('reverseCommission', () => {
  const original = {
    rate: 0.1, grossAmount: 1000, gatewayFeeRate: 0.03,
    gatewayFeeAmount: 300, netAmount: 700, status: 'pending' as const,
  };

  it('returns null when no original commission', () => {
    expect(reverseCommission(null, 10000, 5000)).toBeNull();
    expect(reverseCommission(undefined, 10000, 5000)).toBeNull();
  });

  it('returns null when netAmount is 0', () => {
    expect(reverseCommission({ ...original, netAmount: 0 }, 10000, 5000)).toBeNull();
  });

  it('calculates full reversal', () => {
    const result = reverseCommission(original, 10000, 10000)!;
    expect(result.grossAmount).toBe(1000);
    expect(result.gatewayFeeAmount).toBe(300);
    expect(result.netAmount).toBe(700);
    expect(result.status).toBe('waived');
  });

  it('calculates partial reversal proportionally', () => {
    const result = reverseCommission(original, 10000, 5000)!;
    expect(result.grossAmount).toBe(500);
    expect(result.gatewayFeeAmount).toBe(150);
    expect(result.netAmount).toBe(350);
  });

  it('throws when refund exceeds original', () => {
    expect(() => reverseCommission(original, 10000, 15000)).toThrow('exceeds original');
  });

  it('throws on negative refund', () => {
    expect(() => reverseCommission(original, 10000, -1)).toThrow('cannot be negative');
  });

  it('throws on zero original amount', () => {
    expect(() => reverseCommission(original, 0, 0)).toThrow('greater than 0');
  });
});

// ── Tax ──

describe('calculateTax', () => {
  const config: TaxConfig = { isRegistered: true, defaultRate: 0.15, pricesIncludeTax: false };

  it('returns zero tax when not registered', () => {
    const result = calculateTax(10000, 'product', { ...config, isRegistered: false });
    expect(result.isApplicable).toBe(false);
    expect(result.taxAmount).toBe(0);
    expect(result.totalAmount).toBe(10000);
  });

  it('returns zero tax when config is null', () => {
    const result = calculateTax(10000, 'product', null);
    expect(result.isApplicable).toBe(false);
  });

  it('returns zero tax for exempt category', () => {
    const result = calculateTax(10000, 'food', { ...config, exemptCategories: ['food'] });
    expect(result.isApplicable).toBe(false);
  });

  it('calculates exclusive tax (added on top)', () => {
    const result = calculateTax(10000, 'product', config);
    expect(result.isApplicable).toBe(true);
    expect(result.baseAmount).toBe(10000);
    expect(result.taxAmount).toBe(1500);
    expect(result.totalAmount).toBe(11500);
  });

  it('calculates inclusive tax (extracted from total)', () => {
    const result = calculateTax(11500, 'product', { ...config, pricesIncludeTax: true });
    expect(result.isApplicable).toBe(true);
    expect(result.totalAmount).toBe(11500);
    expect(result.baseAmount).toBe(10000);
    expect(result.taxAmount).toBe(1500);
  });
});

describe('getTaxType', () => {
  it('returns collected for inflow', () => {
    expect(getTaxType('inflow', 'product')).toBe('collected');
  });

  it('returns paid for outflow', () => {
    expect(getTaxType('outflow', 'product')).toBe('paid');
  });

  it('returns exempt for exempt category', () => {
    expect(getTaxType('inflow', 'food', ['food'])).toBe('exempt');
  });
});

describe('reverseTax', () => {
  const originalTax = {
    isApplicable: true, rate: 0.15, baseAmount: 10000,
    taxAmount: 1500, totalAmount: 11500, pricesIncludeTax: false, type: 'collected' as const,
  };

  it('full reversal', () => {
    const result = reverseTax(originalTax, 10000, 10000);
    expect(result.taxAmount).toBe(1500);
    expect(result.type).toBe('paid');
  });

  it('partial reversal is proportional', () => {
    const result = reverseTax(originalTax, 10000, 5000);
    expect(result.taxAmount).toBe(750);
    expect(result.baseAmount).toBe(5000);
  });

  it('flips collected → paid on reverse', () => {
    expect(reverseTax(originalTax, 10000, 10000).type).toBe('paid');
  });

  it('flips paid → collected on reverse', () => {
    const paid = { ...originalTax, type: 'paid' as const };
    expect(reverseTax(paid, 10000, 10000).type).toBe('collected');
  });

  it('keeps exempt as exempt', () => {
    const exempt = { ...originalTax, type: 'exempt' as const };
    expect(reverseTax(exempt, 10000, 10000).type).toBe('exempt');
  });

  it('returns non-applicable for non-applicable original', () => {
    const notApplicable = { isApplicable: false, rate: 0, baseAmount: 10000, taxAmount: 0, totalAmount: 10000, pricesIncludeTax: false };
    const result = reverseTax(notApplicable, 10000, 5000);
    expect(result.isApplicable).toBe(false);
    expect(result.totalAmount).toBe(5000);
  });
});

describe('validateTaxCalculation', () => {
  it('valid when base + tax = total (within rounding)', () => {
    expect(validateTaxCalculation({ isApplicable: true, rate: 0.15, baseAmount: 10000, taxAmount: 1500, totalAmount: 11500, pricesIncludeTax: false })).toBe(true);
  });

  it('valid when not applicable', () => {
    expect(validateTaxCalculation({ isApplicable: false, rate: 0, baseAmount: 0, taxAmount: 0, totalAmount: 0, pricesIncludeTax: false })).toBe(true);
  });

  it('valid with 1-unit rounding difference', () => {
    expect(validateTaxCalculation({ isApplicable: true, rate: 0.15, baseAmount: 10000, taxAmount: 1500, totalAmount: 11501, pricesIncludeTax: false })).toBe(true);
  });

  it('invalid when off by more than 1', () => {
    expect(validateTaxCalculation({ isApplicable: true, rate: 0.15, baseAmount: 10000, taxAmount: 1500, totalAmount: 12000, pricesIncludeTax: false })).toBe(false);
  });
});

// ── Splits ──

describe('calculateSplits', () => {
  it('splits correctly between two recipients', () => {
    const splits = calculateSplits(100000, [
      { type: 'vendor', recipientId: 'v1', recipientType: 'seller', rate: 0.8 },
      { type: 'platform', recipientId: 'p1', recipientType: 'platform', rate: 0.2 },
    ]);
    expect(splits).toHaveLength(2);
    expect(splits[0].grossAmount).toBe(80000);
    expect(splits[1].grossAmount).toBe(20000);
  });

  it('first recipient bears the gateway fee', () => {
    const splits = calculateSplits(100000, [
      { type: 'vendor', recipientId: 'v1', recipientType: 'seller', rate: 0.8 },
      { type: 'platform', recipientId: 'p1', recipientType: 'platform', rate: 0.2 },
    ], 0.03);
    expect(splits[0].gatewayFeeAmount).toBe(3000);
    expect(splits[0].netAmount).toBe(77000);
    expect(splits[1].gatewayFeeAmount).toBe(0);
    expect(splits[1].netAmount).toBe(20000);
  });

  it('throws when total rate exceeds 100%', () => {
    expect(() => calculateSplits(10000, [
      { type: 'a', recipientId: '1', recipientType: 'x', rate: 0.6 },
      { type: 'b', recipientId: '2', recipientType: 'x', rate: 0.5 },
    ])).toThrow('exceed 100%');
  });

  it('handles single recipient', () => {
    const splits = calculateSplits(50000, [
      { type: 'vendor', recipientId: 'v1', recipientType: 'seller', rate: 0.9 },
    ]);
    expect(splits).toHaveLength(1);
    expect(splits[0].grossAmount).toBe(45000);
  });

  it('handles empty rules', () => {
    expect(calculateSplits(10000, [])).toEqual([]);
  });

  it('all splits have status pending', () => {
    const splits = calculateSplits(10000, [{ type: 'v', recipientId: '1', recipientType: 's', rate: 0.5 }]);
    expect(splits[0].status).toBe('pending');
  });
});

describe('calculateOrganizationPayout', () => {
  it('returns remainder after all splits', () => {
    const splits = calculateSplits(100000, [
      { type: 'v', recipientId: 'v1', recipientType: 's', rate: 0.7 },
      { type: 'a', recipientId: 'a1', recipientType: 'a', rate: 0.1 },
    ]);
    expect(calculateOrganizationPayout(100000, splits)).toBe(20000);
  });

  it('returns full amount when no splits', () => {
    expect(calculateOrganizationPayout(50000, [])).toBe(50000);
  });

  it('returns 0 when splits take 100%', () => {
    const splits = calculateSplits(10000, [
      { type: 'v', recipientId: '1', recipientType: 's', rate: 1.0 },
    ]);
    expect(calculateOrganizationPayout(10000, splits)).toBe(0);
  });
});
