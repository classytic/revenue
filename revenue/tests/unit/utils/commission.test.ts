/**
 * Commission Calculation Unit Tests
 * @classytic/revenue
 *
 * Tests for commission, tax, and split calculations
 * Focuses on edge cases and integer math validation
 */

import { strict as assert } from 'assert';
import { calculateCommission, reverseCommission } from '../../../src/shared/utils/calculators/commission.js';
import { calculateTax, reverseTax } from '../../../src/shared/utils/calculators/tax.js';
import { calculateSplits, reverseSplits } from '../../../src/shared/utils/calculators/commission-split.js';
import { ValidationError } from '../../../src/core/errors.js';

// ============ COMMISSION CALCULATION TESTS ============

console.log('\n=== COMMISSION CALCULATION TESTS ===\n');

// Test 1: Integer-only math (no fractional cents)
try {
  const result = calculateCommission(12345, 0.10, 0.029);

  assert.ok(Number.isInteger(result.grossAmount), 'grossAmount must be integer');
  assert.ok(Number.isInteger(result.gatewayFeeAmount), 'gatewayFeeAmount must be integer');
  assert.ok(Number.isInteger(result.netAmount), 'netAmount must be integer');

  // Expected: gross = 12345 * 0.10 = 1234.5 → Math.round = 1235
  // Expected: gatewayFee = 12345 * 0.029 = 358.005 → Math.round = 358
  // Expected: net = 1235 - 358 = 877
  assert.strictEqual(result.grossAmount, 1235);
  assert.strictEqual(result.gatewayFeeAmount, 358);
  assert.strictEqual(result.netAmount, 877);

  console.log('✓ Integer-only math (no fractional cents)');
} catch (error) {
  console.error('✗ Integer-only math test failed');
  throw error;
}

// Test 2: Edge case - very small amounts
try {
  const result = calculateCommission(1, 0.10, 0.029);

  assert.ok(Number.isInteger(result.grossAmount));
  assert.ok(Number.isInteger(result.gatewayFeeAmount));
  assert.ok(Number.isInteger(result.netAmount));

  // Math.round(0.1) = 0
  // Math.round(0.029) = 0
  // net = 0 - 0 = 0
  assert.strictEqual(result.grossAmount, 0);
  assert.strictEqual(result.gatewayFeeAmount, 0);
  assert.strictEqual(result.netAmount, 0);

  console.log('✓ Very small amounts (rounds to zero)');
} catch (error) {
  console.error('✗ Very small amounts test failed');
  throw error;
}

// Test 3: Edge case - zero amount
try {
  const result = calculateCommission(0, 0.10, 0.029);

  assert.strictEqual(result.grossAmount, 0);
  assert.strictEqual(result.gatewayFeeAmount, 0);
  assert.strictEqual(result.netAmount, 0);

  console.log('✓ Zero amount');
} catch (error) {
  console.error('✗ Zero amount test failed');
  throw error;
}

// Test 4: Large amounts
try {
  const result = calculateCommission(1000000, 0.15, 0.029);

  assert.ok(Number.isInteger(result.grossAmount));
  assert.ok(Number.isInteger(result.gatewayFeeAmount));
  assert.ok(Number.isInteger(result.netAmount));

  // gross = 1000000 * 0.15 = 150000
  // gatewayFee = 1000000 * 0.029 = 29000
  // net = 150000 - 29000 = 121000
  assert.strictEqual(result.grossAmount, 150000);
  assert.strictEqual(result.gatewayFeeAmount, 29000);
  assert.strictEqual(result.netAmount, 121000);

  console.log('✓ Large amounts');
} catch (error) {
  console.error('✗ Large amounts test failed');
  throw error;
}

// Test 5: Net amount cannot be negative
try {
  const result = calculateCommission(100, 0.01, 0.05);

  // gross = Math.round(100 * 0.01) = 1
  // gatewayFee = Math.round(100 * 0.05) = 5
  // net = Math.max(0, 1 - 5) = 0 (not negative)
  assert.strictEqual(result.netAmount, 0);
  assert.ok(result.netAmount >= 0, 'netAmount must not be negative');

  console.log('✓ Net amount cannot be negative');
} catch (error) {
  console.error('✗ Net amount non-negative test failed');
  throw error;
}

// ============ REVERSE COMMISSION TESTS ============

console.log('\n=== REVERSE COMMISSION TESTS ===\n');

// Test 6: Valid partial refund
try {
  const original = { rate: 0.10, grossAmount: 1000, gatewayFeeRate: 0.01, gatewayFeeAmount: 100, netAmount: 900, status: 'pending' as const };
  const result = reverseCommission(original, 10000, 5000);

  // Refunding 5000 of 10000 (50%)
  // grossAmount = Math.round(1000 * (5000 / 10000)) = 500
  // gatewayFeeAmount = Math.round(100 * (5000 / 10000)) = 50
  // netAmount = Math.round(900 * (5000 / 10000)) = 450
  assert.ok(result !== null);
  assert.strictEqual(result.grossAmount, 500);
  assert.strictEqual(result.gatewayFeeAmount, 50);
  assert.strictEqual(result.netAmount, 450);
  assert.strictEqual(result.status, 'waived');

  console.log('✓ Valid partial refund (50%)');
} catch (error) {
  console.error('✗ Valid partial refund test failed');
  throw error;
}

// Test 7: Full refund
try {
  const original = { rate: 0.10, grossAmount: 1000, gatewayFeeRate: 0.01, gatewayFeeAmount: 100, netAmount: 900, status: 'pending' as const };
  const result = reverseCommission(original, 10000, 10000);

  assert.ok(result !== null);
  assert.strictEqual(result.grossAmount, 1000);
  assert.strictEqual(result.gatewayFeeAmount, 100);
  assert.strictEqual(result.netAmount, 900);

  console.log('✓ Full refund (100%)');
} catch (error) {
  console.error('✗ Full refund test failed');
  throw error;
}

// Test 8: Edge case - zero originalAmount (should throw)
try {
  reverseCommission({ grossAmount: 100, gatewayFeeAmount: 10, netAmount: 90 }, 0, 50);
  console.error('✗ Zero originalAmount should throw ValidationError');
  throw new Error('Should have thrown ValidationError');
} catch (error) {
  if (error instanceof ValidationError) {
    assert.ok(error.message.includes('Original amount must be greater than 0'));
    console.log('✓ Zero originalAmount throws ValidationError');
  } else {
    throw error;
  }
}

// Test 9: Edge case - negative refundAmount (should throw)
try {
  reverseCommission({ grossAmount: 100, gatewayFeeAmount: 10, netAmount: 90 }, 1000, -50);
  console.error('✗ Negative refundAmount should throw ValidationError');
  throw new Error('Should have thrown ValidationError');
} catch (error) {
  if (error instanceof ValidationError) {
    assert.ok(error.message.includes('Refund amount cannot be negative'));
    console.log('✓ Negative refundAmount throws ValidationError');
  } else {
    throw error;
  }
}

// Test 10: Edge case - refund > original (should throw)
try {
  reverseCommission({ grossAmount: 100, gatewayFeeAmount: 10, netAmount: 90 }, 1000, 1500);
  console.error('✗ Refund > original should throw ValidationError');
  throw new Error('Should have thrown ValidationError');
} catch (error) {
  if (error instanceof ValidationError) {
    assert.ok(error.message.includes('exceeds original amount'));
    console.log('✓ Refund > original throws ValidationError');
  } else {
    throw error;
  }
}

// ============ TAX CALCULATION TESTS ============

console.log('\n=== TAX CALCULATION TESTS ===\n');

// Test 11: Simple tax calculation
try {
  const result = calculateTax(10000, 'subscription', {
    isRegistered: true,
    defaultRate: 0.15,
    pricesIncludeTax: false,
  });

  assert.ok(Number.isInteger(result.taxAmount));
  assert.strictEqual(result.taxAmount, 1500); // 10000 * 0.15
  assert.strictEqual(result.isApplicable, true);
  assert.strictEqual(result.rate, 0.15);

  console.log('✓ Simple tax calculation');
} catch (error) {
  console.error('✗ Simple tax calculation test failed');
  throw error;
}

// Test 12: Zero tax rate
try {
  const result = calculateTax(10000, 'education', {
    isRegistered: true,
    defaultRate: 0.15,
    pricesIncludeTax: false,
    exemptCategories: ['education'],
  });

  assert.strictEqual(result.taxAmount, 0);
  assert.strictEqual(result.isApplicable, false);

  console.log('✓ Zero tax rate');
} catch (error) {
  console.error('✗ Zero tax rate test failed');
  throw error;
}

// Test 13: Reverse tax - partial refund
try {
  const originalTax = {
    isApplicable: true,
    rate: 0.10,
    baseAmount: 10000,
    taxAmount: 1000,
    totalAmount: 11000,
    pricesIncludeTax: false,
    type: 'collected' as const,
  };
  const result = reverseTax(originalTax, 11000, 5500);

  // Refunding 50%: Math.round(1000 * (5500/11000)) = 500
  assert.strictEqual(result.taxAmount, 500);

  console.log('✓ Reverse tax - partial refund');
} catch (error) {
  console.error('✗ Reverse tax partial refund test failed');
  throw error;
}

// Test 14: Reverse tax - edge case validations
try {
  const originalTax = {
    isApplicable: true,
    rate: 0.10,
    baseAmount: 10000,
    taxAmount: 100,
    totalAmount: 10100,
    pricesIncludeTax: false,
    type: 'collected' as const,
  };
  reverseTax(originalTax, 0, 50);
  console.error('✗ Reverse tax with zero original should throw');
  throw new Error('Should have thrown ValidationError');
} catch (error) {
  if (error instanceof ValidationError) {
    console.log('✓ Reverse tax validates zero originalAmount');
  } else {
    throw error;
  }
}

// ============ SPLIT CALCULATION TESTS ============

console.log('\n=== SPLIT CALCULATION TESTS ===\n');

// Test 15: Simple split calculation
try {
  const splits = [
    { recipientId: 'platform', recipientType: 'platform', rate: 0.10, type: 'platform_fee' as const },
    { recipientId: 'affiliate', recipientType: 'user', rate: 0.05, type: 'affiliate_commission' as const },
  ];

  const result = calculateSplits(10000, splits);

  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].grossAmount, 1000); // 10% of 10000
  assert.strictEqual(result[1].grossAmount, 500);  // 5% of 10000

  const totalSplitAmount = result.reduce((sum, split) => sum + split.grossAmount, 0);
  assert.strictEqual(totalSplitAmount, 1500);

  const organizationReceives = 10000 - totalSplitAmount;
  assert.strictEqual(organizationReceives, 8500); // 10000 - 1500

  console.log('✓ Simple split calculation');
} catch (error) {
  console.error('✗ Simple split calculation test failed');
  throw error;
}

// Test 16: Reverse splits - partial refund
try {
  const originalSplits = [
    {
      recipientId: 'platform',
      recipientType: 'platform',
      rate: 0.10,
      grossAmount: 1000,
      gatewayFeeRate: 0,
      gatewayFeeAmount: 0,
      netAmount: 1000,
      type: 'platform_fee' as const,
      status: 'pending' as const,
      metadata: {}
    },
  ];

  const result = reverseSplits(originalSplits, 10000, 5000);

  assert.strictEqual(result.length, 1);
  // Refunding 50%: Math.round(1000 * (5000/10000)) = 500
  assert.strictEqual(result[0].grossAmount, 500);
  assert.strictEqual(result[0].status, 'waived');

  console.log('✓ Reverse splits - partial refund');
} catch (error) {
  console.error('✗ Reverse splits partial refund test failed');
  throw error;
}

// Test 17: Reverse splits - edge case validations
try {
  const originalSplits = [
    {
      recipientId: 'platform',
      recipientType: 'platform',
      rate: 0.10,
      grossAmount: 1000,
      gatewayFeeRate: 0,
      gatewayFeeAmount: 0,
      netAmount: 1000,
      type: 'platform_fee' as const,
      status: 'pending' as const,
      metadata: {}
    },
  ];

  reverseSplits(originalSplits, 0, 500);
  console.error('✗ Reverse splits with zero original should throw');
  throw new Error('Should have thrown ValidationError');
} catch (error) {
  if (error instanceof ValidationError) {
    console.log('✓ Reverse splits validates zero originalAmount');
  } else {
    throw error;
  }
}

// Test 18: Rounding consistency
try {
  // Test that all calculations round consistently
  const amount = 12347; // Prime number for interesting rounding
  const commissionRate = 0.137; // Non-round percentage
  const gatewayRate = 0.0279;

  const commission = calculateCommission(amount, commissionRate, gatewayRate);

  // All amounts must be integers
  assert.ok(Number.isInteger(commission.grossAmount));
  assert.ok(Number.isInteger(commission.gatewayFeeAmount));
  assert.ok(Number.isInteger(commission.netAmount));

  // Verify no fractional cents
  const hasDecimal = (num: number) => num % 1 !== 0;
  assert.ok(!hasDecimal(commission.grossAmount));
  assert.ok(!hasDecimal(commission.gatewayFeeAmount));
  assert.ok(!hasDecimal(commission.netAmount));

  console.log('✓ Rounding consistency with non-round percentages');
} catch (error) {
  console.error('✗ Rounding consistency test failed');
  throw error;
}

console.log('\n=== ALL COMMISSION/TAX/SPLIT TESTS PASSED ===\n');
