/**
 * Audit Trail Integration Tests
 * @classytic/revenue
 *
 * Tests for state change audit tracking
 */

import { strict as assert } from 'assert';
import {
  TRANSACTION_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
} from '../../src/core/state-machine/index.js';
import { appendAuditEvent, getAuditTrail } from '../../src/infrastructure/audit/index.js';
import { TRANSACTION_STATUS } from '../../src/enums/transaction.enums.js';
import { SUBSCRIPTION_STATUS } from '../../src/enums/subscription.enums.js';
import { SETTLEMENT_STATUS } from '../../src/enums/settlement.enums.js';

console.log('\n=== AUDIT TRAIL INTEGRATION TESTS ===\n');

// Test 1: validateAndCreateAuditEvent creates correct event
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

// Test 2: Append audit event to document metadata
try {
  const document = {
    _id: 'tx_123',
    status: TRANSACTION_STATUS.PENDING,
    amount: 10000,
    metadata: {}
  };

  const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PROCESSING,
    'tx_123',
    { changedBy: 'admin_user' }
  );

  const updated = appendAuditEvent(document, auditEvent);

  assert.ok(updated.metadata.stateHistory);
  assert.strictEqual(updated.metadata.stateHistory.length, 1);
  assert.strictEqual(updated.metadata.stateHistory[0].fromState, TRANSACTION_STATUS.PENDING);
  assert.strictEqual(updated.metadata.stateHistory[0].toState, TRANSACTION_STATUS.PROCESSING);

  console.log('✓ Append audit event to document metadata');
} catch (error) {
  console.error('✗ Append audit event failed');
  throw error;
}

// Test 3: Multiple state transitions build audit trail
try {
  let document = {
    _id: 'tx_456',
    status: TRANSACTION_STATUS.PENDING,
    amount: 10000,
    metadata: {}
  };

  // Transition 1: pending → processing
  const event1 = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PROCESSING,
    'tx_456',
    { changedBy: 'system' }
  );
  document = appendAuditEvent(document, event1);
  document.status = TRANSACTION_STATUS.PROCESSING;

  // Transition 2: processing → verified
  const event2 = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PROCESSING,
    TRANSACTION_STATUS.VERIFIED,
    'tx_456',
    { changedBy: 'admin_user', reason: 'Payment verified' }
  );
  document = appendAuditEvent(document, event2);
  document.status = TRANSACTION_STATUS.VERIFIED;

  // Transition 3: verified → completed
  const event3 = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.VERIFIED,
    TRANSACTION_STATUS.COMPLETED,
    'tx_456',
    { changedBy: 'system' }
  );
  document = appendAuditEvent(document, event3);
  document.status = TRANSACTION_STATUS.COMPLETED;

  const history = getAuditTrail(document);
  assert.strictEqual(history.length, 3);
  assert.strictEqual(history[0].fromState, TRANSACTION_STATUS.PENDING);
  assert.strictEqual(history[0].toState, TRANSACTION_STATUS.PROCESSING);
  assert.strictEqual(history[1].fromState, TRANSACTION_STATUS.PROCESSING);
  assert.strictEqual(history[1].toState, TRANSACTION_STATUS.VERIFIED);
  assert.strictEqual(history[2].fromState, TRANSACTION_STATUS.VERIFIED);
  assert.strictEqual(history[2].toState, TRANSACTION_STATUS.COMPLETED);

  console.log('✓ Multiple state transitions build audit trail');
} catch (error) {
  console.error('✗ Multiple transitions failed');
  throw error;
}

// Test 4: Get audit trail from document without history
try {
  const document = {
    _id: 'tx_789',
    status: TRANSACTION_STATUS.PENDING,
    amount: 10000
  };

  const history = getAuditTrail(document);
  assert.strictEqual(history.length, 0);

  console.log('✓ Get audit trail from document without history');
} catch (error) {
  console.error('✗ Get audit trail from empty document failed');
  throw error;
}

// Test 5: Subscription state machine audit
try {
  const auditEvent = SUBSCRIPTION_STATE_MACHINE.validateAndCreateAuditEvent(
    SUBSCRIPTION_STATUS.PENDING,
    SUBSCRIPTION_STATUS.ACTIVE,
    'sub_123',
    {
      changedBy: 'system',
      reason: 'Subscription activated'
    }
  );

  assert.strictEqual(auditEvent.resourceType, 'subscription');
  assert.strictEqual(auditEvent.resourceId, 'sub_123');
  assert.strictEqual(auditEvent.fromState, SUBSCRIPTION_STATUS.PENDING);
  assert.strictEqual(auditEvent.toState, SUBSCRIPTION_STATUS.ACTIVE);

  console.log('✓ Subscription state machine audit');
} catch (error) {
  console.error('✗ Subscription audit failed');
  throw error;
}

// Test 6: Settlement state machine audit
try {
  const auditEvent = SETTLEMENT_STATE_MACHINE.validateAndCreateAuditEvent(
    SETTLEMENT_STATUS.PENDING,
    SETTLEMENT_STATUS.PROCESSING,
    'settlement_123',
    {
      changedBy: 'admin_user',
      reason: 'Settlement initiated'
    }
  );

  assert.strictEqual(auditEvent.resourceType, 'settlement');
  assert.strictEqual(auditEvent.resourceId, 'settlement_123');
  assert.strictEqual(auditEvent.fromState, SETTLEMENT_STATUS.PENDING);
  assert.strictEqual(auditEvent.toState, SETTLEMENT_STATUS.PROCESSING);

  console.log('✓ Settlement state machine audit');
} catch (error) {
  console.error('✗ Settlement audit failed');
  throw error;
}

// Test 7: Audit event with metadata
try {
  const document = {
    _id: 'tx_metadata',
    status: TRANSACTION_STATUS.PENDING,
    amount: 10000,
    metadata: {
      customField: 'value',
      anotherField: 123
    }
  };

  const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PROCESSING,
    'tx_metadata',
    {
      changedBy: 'admin_user',
      metadata: { processingMethod: 'manual', priority: 'high' }
    }
  );

  const updated = appendAuditEvent(document, auditEvent);

  // Original metadata should be preserved
  assert.strictEqual(updated.metadata.customField, 'value');
  assert.strictEqual(updated.metadata.anotherField, 123);

  // Audit event metadata should be in the event
  assert.strictEqual(updated.metadata.stateHistory[0].metadata?.processingMethod, 'manual');
  assert.strictEqual(updated.metadata.stateHistory[0].metadata?.priority, 'high');

  console.log('✓ Audit event with metadata preserves document metadata');
} catch (error) {
  console.error('✗ Audit event with metadata failed');
  throw error;
}

// Test 8: Audit trail chronological order
try {
  let document = {
    _id: 'tx_chrono',
    status: TRANSACTION_STATUS.PENDING,
    metadata: {}
  };

  // Wait a tiny bit between transitions to ensure different timestamps
  const event1 = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PROCESSING,
    'tx_chrono'
  );
  document = appendAuditEvent(document, event1);

  // Small delay
  await new Promise(resolve => setTimeout(resolve, 10));

  const event2 = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PROCESSING,
    TRANSACTION_STATUS.VERIFIED,
    'tx_chrono'
  );
  document = appendAuditEvent(document, event2);

  const history = getAuditTrail(document);
  assert.ok(history[0].changedAt <= history[1].changedAt);

  console.log('✓ Audit trail maintains chronological order');
} catch (error) {
  console.error('✗ Chronological order test failed');
  throw error;
}

// Test 9: Audit event without optional fields
try {
  const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PROCESSING,
    'tx_minimal'
  );

  assert.strictEqual(auditEvent.resourceType, 'transaction');
  assert.strictEqual(auditEvent.resourceId, 'tx_minimal');
  assert.strictEqual(auditEvent.fromState, TRANSACTION_STATUS.PENDING);
  assert.strictEqual(auditEvent.toState, TRANSACTION_STATUS.PROCESSING);
  assert.ok(auditEvent.changedAt instanceof Date);
  assert.strictEqual(auditEvent.changedBy, undefined);
  assert.strictEqual(auditEvent.reason, undefined);
  assert.strictEqual(auditEvent.metadata, undefined);

  console.log('✓ Audit event without optional fields');
} catch (error) {
  console.error('✗ Audit event minimal test failed');
  throw error;
}

// Test 10: Invalid transition does not create audit event
try {
  // This should throw InvalidStateTransitionError
  TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
    TRANSACTION_STATUS.COMPLETED,
    TRANSACTION_STATUS.PENDING,
    'tx_invalid'
  );

  console.error('✗ Invalid transition should throw error');
  throw new Error('Should have thrown InvalidStateTransitionError');
} catch (error) {
  if (error.message.includes('Invalid state transition')) {
    console.log('✓ Invalid transition does not create audit event');
  } else {
    throw error;
  }
}

console.log('\n=== ALL AUDIT TRAIL TESTS PASSED ===\n');
