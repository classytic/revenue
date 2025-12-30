/**
 * Manual Smoke Test
 * @classytic/revenue
 *
 * Verifies key features work end-to-end
 */

console.log('\n=== SMOKE TEST: @classytic/revenue ===\n');

// Test 1: Import all main exports
console.log('✓ Test 1: Import main exports');
import {
  // Core
  Result,

  // State Machines
  StateMachine,
  TRANSACTION_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
  HOLD_STATE_MACHINE,
  SPLIT_STATE_MACHINE,

  // Errors
  ValidationError,
  InvalidStateTransitionError,

  // Audit
  appendAuditEvent,
  getAuditTrail,

  // Formatters
  Money,
  toSmallestUnit,
  fromSmallestUnit,
} from '../../src/index.js';

// Import from submodules
import { Container } from '../../src/core/container.js';
import {
  calculateCommission,
  reverseCommission,
} from '../../src/shared/utils/calculators/commission.js';
import {
  calculateTax,
  reverseTax,
} from '../../src/shared/utils/calculators/tax.js';
import {
  calculateSplits,
  reverseSplits,
} from '../../src/shared/utils/calculators/commission-split.js';
import {
  retry,
  CircuitBreaker,
} from '../../src/shared/utils/resilience/retry.js';

import { TRANSACTION_STATUS } from '../../src/enums/transaction.enums.js';
import { SUBSCRIPTION_STATUS } from '../../src/enums/subscription.enums.js';

// Test 2: State machine basic functionality
console.log('✓ Test 2: State machine validates transitions');
try {
  TRANSACTION_STATE_MACHINE.validate(
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PROCESSING,
    'test_tx'
  );

  const allowed = TRANSACTION_STATE_MACHINE.getAllowedTransitions(TRANSACTION_STATUS.PENDING);
  if (!allowed.includes(TRANSACTION_STATUS.PROCESSING)) {
    throw new Error('State machine not working correctly');
  }

  console.log('  ✓ Valid transitions work');
} catch (error) {
  console.error('  ✗ State machine validation failed:', error);
  process.exit(1);
}

// Test 3: State machine rejects invalid transitions
console.log('✓ Test 3: State machine rejects invalid transitions');
try {
  TRANSACTION_STATE_MACHINE.validate(
    TRANSACTION_STATUS.COMPLETED,
    TRANSACTION_STATUS.PENDING,
    'test_tx'
  );
  console.error('  ✗ Should have thrown InvalidStateTransitionError');
  process.exit(1);
} catch (error) {
  if (error instanceof InvalidStateTransitionError) {
    console.log('  ✓ Invalid transitions rejected');
  } else {
    console.error('  ✗ Wrong error type:', error);
    process.exit(1);
  }
}

// Test 4: Commission calculation
console.log('✓ Test 4: Commission calculation works');
const commission = calculateCommission(10000, 0.10, 0.029);
if (!commission || commission.grossAmount !== 1000 || commission.gatewayFeeAmount !== 290) {
  console.error('  ✗ Commission calculation incorrect');
  process.exit(1);
}
console.log('  ✓ calculateCommission: $100.00 with $2.90 gateway fee');

// Test 5: Commission reversal
console.log('✓ Test 5: Commission reversal works');
const reversed = reverseCommission(commission, 10000, 5000);
if (!reversed || reversed.grossAmount !== 500) {
  console.error('  ✗ Commission reversal incorrect');
  process.exit(1);
}
console.log('  ✓ reverseCommission: 50% refund = $5.00');

// Test 6: Tax calculation
console.log('✓ Test 6: Tax calculation works');
const tax = calculateTax(10000, 'subscription', {
  isRegistered: true,
  defaultRate: 0.15,
  pricesIncludeTax: false,
});
if (tax.taxAmount !== 1500 || tax.totalAmount !== 11500) {
  console.error('  ✗ Tax calculation incorrect');
  process.exit(1);
}
console.log('  ✓ calculateTax: 15% on $100.00 = $15.00');

// Test 7: Split calculation
console.log('✓ Test 7: Split calculation works');
const splits = calculateSplits(10000, [
  { recipientId: 'platform', recipientType: 'platform', rate: 0.10 },
  { recipientId: 'affiliate', recipientType: 'user', rate: 0.05 },
]);
if (splits.length !== 2 || splits[0].grossAmount !== 1000 || splits[1].grossAmount !== 500) {
  console.error('  ✗ Split calculation incorrect');
  process.exit(1);
}
console.log('  ✓ calculateSplits: 10% + 5% = $10.00 + $5.00');

// Test 8: Money formatting
console.log('✓ Test 8: Money formatting works');
const money = new Money(12345, 'USD');
if (money.format() !== '$123.45') {
  console.error('  ✗ Money formatting incorrect:', money.format());
  process.exit(1);
}
console.log('  ✓ Money.format(): 12345 cents = $123.45');

// Test 9: Audit trail
console.log('✓ Test 9: Audit trail works');
const document = { _id: 'test', status: TRANSACTION_STATUS.PENDING, metadata: {} };
const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
  TRANSACTION_STATUS.PENDING,
  TRANSACTION_STATUS.PROCESSING,
  'test',
  { changedBy: 'admin' }
);
const updated = appendAuditEvent(document, auditEvent);
const history = getAuditTrail(updated);
if (history.length !== 1 || history[0].fromState !== TRANSACTION_STATUS.PENDING) {
  console.error('  ✗ Audit trail incorrect');
  process.exit(1);
}
console.log('  ✓ Audit trail: State change recorded');

// Test 10: All state machines exist
console.log('✓ Test 10: All state machines exported');
const stateMachines = [
  TRANSACTION_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
  HOLD_STATE_MACHINE,
  SPLIT_STATE_MACHINE,
];
if (stateMachines.some(sm => !sm)) {
  console.error('  ✗ Missing state machines');
  process.exit(1);
}
console.log('  ✓ All 5 state machines available');

// Test 11: Result type works
console.log('✓ Test 11: Result type works');
const successResult = Result.ok({ value: 'test' });
const failResult = Result.err(new Error('test error'));
if (!successResult.ok || failResult.ok) {
  console.error('  ✗ Result type incorrect');
  process.exit(1);
}
console.log('  ✓ Result.ok() and Result.err() work');

// Test 12: Retry utility works
console.log('✓ Test 12: Retry utility works');
let attempts = 0;
const retryTest = async () => {
  return retry(
    async () => {
      attempts++;
      if (attempts < 2) throw new Error('Retry me');
      return 'success';
    },
    {
      maxAttempts: 3,
      baseDelay: 10,
      retryIf: () => true, // Retry all errors for testing
    }
  );
};
const retryResult = await retryTest();
if (retryResult !== 'success' || attempts !== 2) {
  console.error('  ✗ Retry utility incorrect');
  process.exit(1);
}
console.log('  ✓ retry() works with 2 attempts');

// Test 13: Circuit breaker works
console.log('✓ Test 13: Circuit breaker works');
const breaker = new CircuitBreaker({
  failureThreshold: 2,
  resetTimeout: 100,
});
try {
  await breaker.execute(async () => 'success');
  console.log('  ✓ CircuitBreaker.execute() works');
} catch (error) {
  console.error('  ✗ Circuit breaker failed:', error);
  process.exit(1);
}

// Test 14: Container works
console.log('✓ Test 14: Container works');
const container = new Container();
container.register('testService', { value: 'test' });
const service = container.get('testService');
if (service.value !== 'test') {
  console.error('  ✗ Container incorrect');
  process.exit(1);
}
console.log('  ✓ Container.register() and get() work');

// Test 15: Subscription state machine
console.log('✓ Test 15: Subscription state machine works');
try {
  SUBSCRIPTION_STATE_MACHINE.validate(
    SUBSCRIPTION_STATUS.PENDING,
    SUBSCRIPTION_STATUS.ACTIVE,
    'sub_test'
  );
  console.log('  ✓ Subscription transitions work');
} catch (error) {
  console.error('  ✗ Subscription state machine failed:', error);
  process.exit(1);
}

// Test 16: Edge case validations
console.log('✓ Test 16: Edge case validations work');
try {
  reverseCommission(commission, 0, 100); // Should throw
  console.error('  ✗ Should have thrown ValidationError');
  process.exit(1);
} catch (error) {
  if (error instanceof ValidationError) {
    console.log('  ✓ Edge case validation works');
  } else {
    console.error('  ✗ Wrong error type:', error);
    process.exit(1);
  }
}

// Test 17: Integer-only math
console.log('✓ Test 17: Integer-only math (no fractional cents)');
const testCommission = calculateCommission(12345, 0.137, 0.0279);
if (!testCommission) {
  console.error('  ✗ Commission is null');
  process.exit(1);
}
if (
  !Number.isInteger(testCommission.grossAmount) ||
  !Number.isInteger(testCommission.gatewayFeeAmount) ||
  !Number.isInteger(testCommission.netAmount)
) {
  console.error('  ✗ Fractional cents detected!');
  process.exit(1);
}
console.log('  ✓ All amounts are integers');

// Test 18: Tax reversal
console.log('✓ Test 18: Tax reversal works');
const taxReversed = reverseTax(
  {
    isApplicable: true,
    rate: 0.15,
    baseAmount: 10000,
    taxAmount: 1500,
    totalAmount: 11500,
    pricesIncludeTax: false,
    type: 'collected' as const,
  },
  11500,
  5750
);
if (taxReversed.taxAmount !== 750) {
  console.error('  ✗ Tax reversal incorrect');
  process.exit(1);
}
console.log('  ✓ reverseTax: 50% refund = $7.50 tax');

// Test 19: Split reversal
console.log('✓ Test 19: Split reversal works');
const splitReversed = reverseSplits(splits, 10000, 5000);
if (splitReversed.length !== 2 || splitReversed[0].grossAmount !== 500) {
  console.error('  ✗ Split reversal incorrect');
  process.exit(1);
}
console.log('  ✓ reverseSplits: 50% refund works');

// Test 20: Terminal states
console.log('✓ Test 20: Terminal states work');
if (!TRANSACTION_STATE_MACHINE.isTerminalState(TRANSACTION_STATUS.REFUNDED)) {
  console.error('  ✗ REFUNDED should be terminal');
  process.exit(1);
}
if (TRANSACTION_STATE_MACHINE.isTerminalState(TRANSACTION_STATUS.PENDING)) {
  console.error('  ✗ PENDING should not be terminal');
  process.exit(1);
}
console.log('  ✓ isTerminalState() works correctly');

console.log('\n=== ALL 20 SMOKE TESTS PASSED ===\n');
console.log('✅ Package is working correctly!\n');
