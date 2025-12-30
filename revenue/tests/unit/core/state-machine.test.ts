/**
 * State Machine Unit Tests
 * @classytic/revenue
 *
 * Tests for centralized state transition validation
 */

import { strict as assert } from 'assert';
import {
  StateMachine,
  TRANSACTION_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
  HOLD_STATE_MACHINE,
  SPLIT_STATE_MACHINE,
} from '../../../src/core/state-machine/index.js';
import { InvalidStateTransitionError } from '../../../src/core/errors.js';
import { TRANSACTION_STATUS } from '../../../src/enums/transaction.enums.js';
import { SUBSCRIPTION_STATUS } from '../../../src/enums/subscription.enums.js';
import { SETTLEMENT_STATUS } from '../../../src/enums/settlement.enums.js';
import { HOLD_STATUS } from '../../../src/enums/escrow.enums.js';
import { SPLIT_STATUS } from '../../../src/enums/split.enums.js';

// Test utilities
function testValidTransition(
  machine: StateMachine<any>,
  from: string,
  to: string,
  description: string
): void {
  try {
    machine.validate(from, to, 'test_id');
    console.log(`✓ ${description}`);
  } catch (error) {
    console.error(`✗ ${description}`);
    throw error;
  }
}

function testInvalidTransition(
  machine: StateMachine<any>,
  from: string,
  to: string,
  description: string
): void {
  try {
    machine.validate(from, to, 'test_id');
    console.error(`✗ ${description} - Expected error but transition was allowed`);
    throw new Error(`Invalid transition ${from} → ${to} should have been rejected`);
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      console.log(`✓ ${description}`);
    } else {
      throw error;
    }
  }
}

// ============ TRANSACTION STATE MACHINE TESTS ============

console.log('\n=== TRANSACTION STATE MACHINE TESTS ===\n');

// Valid transitions
testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.PENDING,
  TRANSACTION_STATUS.PAYMENT_INITIATED,
  'PENDING → PAYMENT_INITIATED'
);

testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.PENDING,
  TRANSACTION_STATUS.PROCESSING,
  'PENDING → PROCESSING'
);

testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.PROCESSING,
  TRANSACTION_STATUS.VERIFIED,
  'PROCESSING → VERIFIED'
);

testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.VERIFIED,
  TRANSACTION_STATUS.COMPLETED,
  'VERIFIED → COMPLETED'
);

testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.COMPLETED,
  TRANSACTION_STATUS.REFUNDED,
  'COMPLETED → REFUNDED'
);

testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.COMPLETED,
  TRANSACTION_STATUS.PARTIALLY_REFUNDED,
  'COMPLETED → PARTIALLY_REFUNDED'
);

testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.PARTIALLY_REFUNDED,
  TRANSACTION_STATUS.REFUNDED,
  'PARTIALLY_REFUNDED → REFUNDED'
);

testValidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.PROCESSING,
  TRANSACTION_STATUS.FAILED,
  'PROCESSING → FAILED'
);

// Invalid transitions
testInvalidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.COMPLETED,
  TRANSACTION_STATUS.PENDING,
  'COMPLETED ↛ PENDING (reverse not allowed)'
);

testInvalidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.REFUNDED,
  TRANSACTION_STATUS.COMPLETED,
  'REFUNDED ↛ COMPLETED (terminal state)'
);

testInvalidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.FAILED,
  TRANSACTION_STATUS.VERIFIED,
  'FAILED ↛ VERIFIED (terminal state)'
);

testInvalidTransition(
  TRANSACTION_STATE_MACHINE,
  TRANSACTION_STATUS.PENDING,
  TRANSACTION_STATUS.COMPLETED,
  'PENDING ↛ COMPLETED (skip states not allowed)'
);

// Test helper methods
const transactionAllowed = TRANSACTION_STATE_MACHINE.getAllowedTransitions(TRANSACTION_STATUS.PENDING);
assert.ok(transactionAllowed.includes(TRANSACTION_STATUS.PROCESSING), 'getAllowedTransitions should include PROCESSING from PENDING');

assert.ok(
  TRANSACTION_STATE_MACHINE.canTransition(TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING),
  'canTransition should return true for valid transition'
);

assert.ok(
  !TRANSACTION_STATE_MACHINE.canTransition(TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.PENDING),
  'canTransition should return false for invalid transition'
);

assert.ok(
  TRANSACTION_STATE_MACHINE.isTerminalState(TRANSACTION_STATUS.REFUNDED),
  'REFUNDED should be a terminal state'
);

assert.ok(
  !TRANSACTION_STATE_MACHINE.isTerminalState(TRANSACTION_STATUS.PENDING),
  'PENDING should not be a terminal state'
);

console.log('✓ Helper methods work correctly');

// ============ SUBSCRIPTION STATE MACHINE TESTS ============

console.log('\n=== SUBSCRIPTION STATE MACHINE TESTS ===\n');

// Valid transitions
testValidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.PENDING,
  SUBSCRIPTION_STATUS.ACTIVE,
  'PENDING → ACTIVE'
);

testValidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PAUSED,
  'ACTIVE → PAUSED'
);

testValidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.PAUSED,
  SUBSCRIPTION_STATUS.ACTIVE,
  'PAUSED → ACTIVE (resume)'
);

testValidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.CANCELLED,
  'ACTIVE → CANCELLED'
);

testValidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.EXPIRED,
  'ACTIVE → EXPIRED'
);

testValidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PENDING_RENEWAL,
  'ACTIVE → PENDING_RENEWAL'
);

testValidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.PENDING_RENEWAL,
  SUBSCRIPTION_STATUS.ACTIVE,
  'PENDING_RENEWAL → ACTIVE (renewal success)'
);

// Invalid transitions
testInvalidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.CANCELLED,
  SUBSCRIPTION_STATUS.ACTIVE,
  'CANCELLED ↛ ACTIVE (terminal state)'
);

testInvalidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.EXPIRED,
  SUBSCRIPTION_STATUS.PAUSED,
  'EXPIRED ↛ PAUSED (terminal state)'
);

testInvalidTransition(
  SUBSCRIPTION_STATE_MACHINE,
  SUBSCRIPTION_STATUS.PENDING,
  SUBSCRIPTION_STATUS.PAUSED,
  'PENDING ↛ PAUSED (must activate first)'
);

// ============ SETTLEMENT STATE MACHINE TESTS ============

console.log('\n=== SETTLEMENT STATE MACHINE TESTS ===\n');

// Valid transitions
testValidTransition(
  SETTLEMENT_STATE_MACHINE,
  SETTLEMENT_STATUS.PENDING,
  SETTLEMENT_STATUS.PROCESSING,
  'PENDING → PROCESSING'
);

testValidTransition(
  SETTLEMENT_STATE_MACHINE,
  SETTLEMENT_STATUS.PROCESSING,
  SETTLEMENT_STATUS.COMPLETED,
  'PROCESSING → COMPLETED'
);

testValidTransition(
  SETTLEMENT_STATE_MACHINE,
  SETTLEMENT_STATUS.PROCESSING,
  SETTLEMENT_STATUS.FAILED,
  'PROCESSING → FAILED'
);

testValidTransition(
  SETTLEMENT_STATE_MACHINE,
  SETTLEMENT_STATUS.FAILED,
  SETTLEMENT_STATUS.PENDING,
  'FAILED → PENDING (retry allowed)'
);

testValidTransition(
  SETTLEMENT_STATE_MACHINE,
  SETTLEMENT_STATUS.PENDING,
  SETTLEMENT_STATUS.CANCELLED,
  'PENDING → CANCELLED'
);

// Invalid transitions
testInvalidTransition(
  SETTLEMENT_STATE_MACHINE,
  SETTLEMENT_STATUS.COMPLETED,
  SETTLEMENT_STATUS.PENDING,
  'COMPLETED ↛ PENDING (terminal state)'
);

testInvalidTransition(
  SETTLEMENT_STATE_MACHINE,
  SETTLEMENT_STATUS.PENDING,
  SETTLEMENT_STATUS.COMPLETED,
  'PENDING ↛ COMPLETED (must process first)'
);

// ============ HOLD STATE MACHINE TESTS ============

console.log('\n=== ESCROW HOLD STATE MACHINE TESTS ===\n');

// Valid transitions
testValidTransition(
  HOLD_STATE_MACHINE,
  HOLD_STATUS.HELD,
  HOLD_STATUS.RELEASED,
  'HELD → RELEASED'
);

testValidTransition(
  HOLD_STATE_MACHINE,
  HOLD_STATUS.HELD,
  HOLD_STATUS.PARTIALLY_RELEASED,
  'HELD → PARTIALLY_RELEASED'
);

testValidTransition(
  HOLD_STATE_MACHINE,
  HOLD_STATUS.PARTIALLY_RELEASED,
  HOLD_STATUS.RELEASED,
  'PARTIALLY_RELEASED → RELEASED'
);

testValidTransition(
  HOLD_STATE_MACHINE,
  HOLD_STATUS.HELD,
  HOLD_STATUS.CANCELLED,
  'HELD → CANCELLED'
);

testValidTransition(
  HOLD_STATE_MACHINE,
  HOLD_STATUS.HELD,
  HOLD_STATUS.EXPIRED,
  'HELD → EXPIRED'
);

// Invalid transitions
testInvalidTransition(
  HOLD_STATE_MACHINE,
  HOLD_STATUS.RELEASED,
  HOLD_STATUS.HELD,
  'RELEASED ↛ HELD (terminal state)'
);

testInvalidTransition(
  HOLD_STATE_MACHINE,
  HOLD_STATUS.CANCELLED,
  HOLD_STATUS.RELEASED,
  'CANCELLED ↛ RELEASED (terminal state)'
);

// ============ SPLIT STATE MACHINE TESTS ============

console.log('\n=== SPLIT PAYMENT STATE MACHINE TESTS ===\n');

// Valid transitions
testValidTransition(
  SPLIT_STATE_MACHINE,
  SPLIT_STATUS.PENDING,
  SPLIT_STATUS.DUE,
  'PENDING → DUE'
);

testValidTransition(
  SPLIT_STATE_MACHINE,
  SPLIT_STATUS.PENDING,
  SPLIT_STATUS.PAID,
  'PENDING → PAID'
);

testValidTransition(
  SPLIT_STATE_MACHINE,
  SPLIT_STATUS.DUE,
  SPLIT_STATUS.PAID,
  'DUE → PAID'
);

testValidTransition(
  SPLIT_STATE_MACHINE,
  SPLIT_STATUS.PENDING,
  SPLIT_STATUS.WAIVED,
  'PENDING → WAIVED'
);

testValidTransition(
  SPLIT_STATE_MACHINE,
  SPLIT_STATUS.PENDING,
  SPLIT_STATUS.CANCELLED,
  'PENDING → CANCELLED'
);

// Invalid transitions
testInvalidTransition(
  SPLIT_STATE_MACHINE,
  SPLIT_STATUS.PAID,
  SPLIT_STATUS.PENDING,
  'PAID ↛ PENDING (terminal state)'
);

testInvalidTransition(
  SPLIT_STATE_MACHINE,
  SPLIT_STATUS.WAIVED,
  SPLIT_STATUS.PAID,
  'WAIVED ↛ PAID (terminal state)'
);

// ============ AUDIT EVENT CREATION TESTS ============

console.log('\n=== AUDIT EVENT CREATION TESTS ===\n');

try {
  const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PROCESSING,
    'tx_123',
    {
      changedBy: 'admin_user',
      reason: 'Test transition',
      metadata: { test: true }
    }
  );

  assert.strictEqual(auditEvent.resourceType, 'transaction');
  assert.strictEqual(auditEvent.resourceId, 'tx_123');
  assert.strictEqual(auditEvent.fromState, TRANSACTION_STATUS.PENDING);
  assert.strictEqual(auditEvent.toState, TRANSACTION_STATUS.PROCESSING);
  assert.strictEqual(auditEvent.changedBy, 'admin_user');
  assert.strictEqual(auditEvent.reason, 'Test transition');
  assert.ok(auditEvent.changedAt instanceof Date);
  assert.deepStrictEqual(auditEvent.metadata, { test: true });

  console.log('✓ validateAndCreateAuditEvent creates correct audit event');
} catch (error) {
  console.error('✗ validateAndCreateAuditEvent failed');
  throw error;
}

// Test audit event creation for invalid transition
try {
  TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.COMPLETED,
    TRANSACTION_STATUS.PENDING,
    'tx_123'
  );
  console.error('✗ validateAndCreateAuditEvent should throw for invalid transition');
  throw new Error('Should have thrown InvalidStateTransitionError');
} catch (error) {
  if (error instanceof InvalidStateTransitionError) {
    console.log('✓ validateAndCreateAuditEvent throws for invalid transitions');
  } else {
    throw error;
  }
}

console.log('\n=== ALL STATE MACHINE TESTS PASSED ===\n');
