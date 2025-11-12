/**
 * Commission Utilities Tests
 * @classytic/revenue
 */

import { calculateCommission, reverseCommission } from '../../revenue/utils/commission.js';

// Simple test runner
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(`   ${error.message}`);
    process.exit(1);
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertNull(actual, message) {
  if (actual !== null) {
    throw new Error(`${message}: expected null, got ${actual}`);
  }
}

// ============================================================
// TESTS
// ============================================================

console.log('\n🧪 Testing Commission Utilities\n');

// Test: Basic calculation
test('calculateCommission - basic 10% commission', () => {
  const result = calculateCommission(1000, 0.10, 0.018);
  assertEquals(result.rate, 0.10, 'Rate');
  assertEquals(result.grossAmount, 100, 'Gross amount');
  assertEquals(result.gatewayFeeAmount, 18, 'Gateway fee');
  assertEquals(result.netAmount, 82, 'Net amount');
  assertEquals(result.status, 'pending', 'Status');
});

// Test: Zero commission rate
test('calculateCommission - zero rate returns null', () => {
  const result = calculateCommission(1000, 0, 0.018);
  assertNull(result, 'Zero rate should return null');
});

// Test: No gateway fee
test('calculateCommission - no gateway fee', () => {
  const result = calculateCommission(1000, 0.10, 0);
  assertEquals(result.netAmount, 100, 'Net equals gross when no gateway fee');
});

// Test: High gateway fee
test('calculateCommission - gateway fee higher than commission', () => {
  const result = calculateCommission(1000, 0.02, 0.029); // 2% commission, 2.9% gateway
  assertEquals(result.grossAmount, 20, 'Gross');
  assertEquals(result.gatewayFeeAmount, 29, 'Gateway fee');
  assertEquals(result.netAmount, 0, 'Net should be 0 (max protection)');
});

// Test: Proportional refund
test('reverseCommission - 50% refund', () => {
  const original = {
    rate: 0.10,
    grossAmount: 100,
    gatewayFeeRate: 0.018,
    gatewayFeeAmount: 18,
    netAmount: 82,
    status: 'pending',
  };
  
  const reversed = reverseCommission(original, 1000, 500);
  assertEquals(reversed.grossAmount, 50, '50% of gross');
  assertEquals(reversed.gatewayFeeAmount, 9, '50% of gateway fee');
  assertEquals(reversed.netAmount, 41, '50% of net');
  assertEquals(reversed.status, 'waived', 'Status should be waived');
});

// Test: Full refund
test('reverseCommission - 100% refund', () => {
  const original = {
    rate: 0.10,
    grossAmount: 100,
    gatewayFeeRate: 0.018,
    gatewayFeeAmount: 18,
    netAmount: 82,
  };
  
  const reversed = reverseCommission(original, 1000, 1000);
  assertEquals(reversed.netAmount, 82, 'Full reversal');
});

// Test: Null commission
test('reverseCommission - null commission returns null', () => {
  const reversed = reverseCommission(null, 1000, 500);
  assertNull(reversed, 'Null commission should return null');
});

// Test: Rounding
test('calculateCommission - proper rounding', () => {
  const result = calculateCommission(1003, 0.099, 0.0179);
  // Gross: 99.297 → 99.30
  // Gateway: 17.9537 → 17.95
  // Net: 81.35
  assertEquals(result.grossAmount, 99.30, 'Gross rounded to 2 decimals');
  assertEquals(result.gatewayFeeAmount, 17.95, 'Gateway fee rounded');
  assertEquals(result.netAmount, 81.35, 'Net rounded');
});

console.log('\n✅ All commission tests passed!\n');

