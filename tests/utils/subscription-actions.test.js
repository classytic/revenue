/**
 * Subscription Action Utilities Tests
 * @classytic/revenue
 */

import {
  isSubscriptionActive,
  canRenewSubscription,
  canCancelSubscription,
  canPauseSubscription,
  canResumeSubscription,
} from '../../revenue/utils/subscription/actions.js';

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

function assertTrue(actual, message) {
  if (!actual) {
    throw new Error(`${message}: expected true, got false`);
  }
}

function assertFalse(actual, message) {
  if (actual) {
    throw new Error(`${message}: expected false, got true`);
  }
}

console.log('\n🧪 Testing Subscription Action Utilities\n');

// Test: Active subscription
test('isSubscriptionActive - active subscription', () => {
  const sub = {
    isActive: true,
    endDate: new Date(Date.now() + 86400000), // Tomorrow
  };
  assertTrue(isSubscriptionActive(sub), 'Should be active');
});

// Test: Inactive subscription
test('isSubscriptionActive - inactive subscription', () => {
  const sub = {
    isActive: false,
    endDate: new Date(Date.now() + 86400000),
  };
  assertFalse(isSubscriptionActive(sub), 'Should be inactive');
});

// Test: Expired subscription
test('isSubscriptionActive - expired subscription', () => {
  const sub = {
    isActive: true,
    endDate: new Date(Date.now() - 86400000), // Yesterday
  };
  assertFalse(isSubscriptionActive(sub), 'Should be inactive when expired');
});

// Test: Can renew active
test('canRenewSubscription - can renew active subscription', () => {
  const entity = {
    subscription: {
      isActive: true,
      endDate: new Date(Date.now() + 86400000),
    },
  };
  assertTrue(canRenewSubscription(entity), 'Should be able to renew');
});

// Test: Cannot renew inactive
test('canRenewSubscription - cannot renew inactive', () => {
  const entity = {
    subscription: {
      isActive: false,
    },
  };
  assertFalse(canRenewSubscription(entity), 'Should not renew inactive');
});

// Test: Can cancel
test('canCancelSubscription - can cancel active', () => {
  const entity = {
    subscription: {
      isActive: true,
      endDate: new Date(Date.now() + 86400000),
    },
  };
  assertTrue(canCancelSubscription(entity), 'Should be able to cancel');
});

// Test: Cannot cancel already canceled
test('canCancelSubscription - already canceled', () => {
  const entity = {
    subscription: {
      isActive: true,
      canceledAt: new Date(),
    },
  };
  assertFalse(canCancelSubscription(entity), 'Already canceled');
});

// Test: Can pause active
test('canPauseSubscription - can pause active', () => {
  const entity = {
    status: 'active',
    subscription: {
      isActive: true,
      endDate: new Date(Date.now() + 86400000),
    },
  };
  assertTrue(canPauseSubscription(entity), 'Can pause active');
});

// Test: Cannot pause already paused
test('canPauseSubscription - already paused', () => {
  const entity = {
    status: 'paused',
    subscription: {
      isActive: false,
    },
  };
  assertFalse(canPauseSubscription(entity), 'Already paused');
});

// Test: Cannot pause cancelled
test('canPauseSubscription - cancelled subscription', () => {
  const entity = {
    status: 'cancelled',
    subscription: {
      isActive: false,
    },
  };
  assertFalse(canPauseSubscription(entity), 'Cannot pause cancelled');
});

// Test: Can resume paused
test('canResumeSubscription - can resume paused', () => {
  const entity = {
    status: 'paused',
    subscription: {
      isActive: false,
    },
  };
  assertTrue(canResumeSubscription(entity), 'Can resume paused');
});

// Test: Cannot resume active
test('canResumeSubscription - cannot resume active', () => {
  const entity = {
    status: 'active',
    subscription: {
      isActive: true,
    },
  };
  assertFalse(canResumeSubscription(entity), 'Cannot resume active');
});

console.log('\n✅ All subscription action tests passed!\n');

