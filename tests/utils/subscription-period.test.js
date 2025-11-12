/**
 * Subscription Period Utilities Tests
 * @classytic/revenue
 */

import {
  addDuration,
  calculatePeriodRange,
  calculateProratedAmount,
  resolveIntervalToDuration,
} from '../../revenue/utils/subscription/period.js';

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

function assertDateEquals(actual, expected, message) {
  if (actual.getTime() !== expected.getTime()) {
    throw new Error(`${message}: expected ${expected.toISOString()}, got ${actual.toISOString()}`);
  }
}

console.log('\n🧪 Testing Subscription Period Utilities\n');

// Test: Add days
test('addDuration - add 30 days', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const result = addDuration(start, 30, 'days');
  assertDateEquals(result, new Date('2025-01-31T00:00:00Z'), 'Add 30 days');
});

// Test: Add months
test('addDuration - add 3 months', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const result = addDuration(start, 3, 'months');
  assertDateEquals(result, new Date('2025-04-01T00:00:00Z'), 'Add 3 months');
});

// Test: Add years
test('addDuration - add 1 year', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const result = addDuration(start, 1, 'years');
  assertDateEquals(result, new Date('2026-01-01T00:00:00Z'), 'Add 1 year');
});

// Test: Add weeks
test('addDuration - add 2 weeks', () => {
  const start = new Date('2025-01-01T00:00:00Z');
  const result = addDuration(start, 2, 'weeks');
  assertDateEquals(result, new Date('2025-01-15T00:00:00Z'), 'Add 14 days');
});

// Test: Calculate period range
test('calculatePeriodRange - basic 30 days', () => {
  const now = new Date('2025-01-01T00:00:00Z');
  const { startDate, endDate } = calculatePeriodRange({
    duration: 30,
    unit: 'days',
    now,
  });
  assertDateEquals(startDate, new Date('2025-01-01T00:00:00Z'), 'Start date');
  assertDateEquals(endDate, new Date('2025-01-31T00:00:00Z'), 'End date');
});

// Test: Prorated amount - 50% used
test('calculateProratedAmount - 50% remaining', () => {
  const result = calculateProratedAmount({
    amountPaid: 1000,
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31'),
    asOfDate: new Date('2025-01-16'), // Halfway through
  });
  
  // 15 days remaining out of 30 = 50%
  assertEquals(Math.round(result), 500, 'Should be ~500 for 50% remaining');
});

// Test: Prorated amount - 0% remaining (expired)
test('calculateProratedAmount - expired subscription', () => {
  const result = calculateProratedAmount({
    amountPaid: 1000,
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31'),
    asOfDate: new Date('2025-02-15'), // After end date
  });
  
  assertEquals(result, 0, 'Should be 0 for expired subscription');
});

// Test: Prorated amount - 100% remaining (just started)
test('calculateProratedAmount - just started', () => {
  const result = calculateProratedAmount({
    amountPaid: 1000,
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31'),
    asOfDate: new Date('2025-01-01'), // Same as start
  });
  
  assertEquals(result, 1000, 'Should be full amount when just started');
});

// Test: Resolve interval - month
test('resolveIntervalToDuration - month', () => {
  const result = resolveIntervalToDuration('month', 1);
  assertEquals(result.duration, 1, 'Duration');
  assertEquals(result.unit, 'months', 'Unit');
});

// Test: Resolve interval - quarter
test('resolveIntervalToDuration - quarter', () => {
  const result = resolveIntervalToDuration('quarter', 2);
  assertEquals(result.duration, 6, 'Quarter = 3 months, so 2 quarters = 6 months');
  assertEquals(result.unit, 'months', 'Unit');
});

// Test: Resolve interval - year
test('resolveIntervalToDuration - year', () => {
  const result = resolveIntervalToDuration('year', 1);
  assertEquals(result.duration, 1, 'Duration');
  assertEquals(result.unit, 'years', 'Unit');
});

console.log('\n✅ All subscription period tests passed!\n');

