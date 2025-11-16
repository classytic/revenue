/**
 * Subscription Service Integration Tests
 * @classytic/revenue
 *
 * Tests critical flows: renewal error handling
 */

import { SubscriptionService } from '../../revenue/services/subscription.service.js';
import { Container } from '../../revenue/core/container.js';
import {
  PaymentIntentCreationError,
  SubscriptionNotFoundError,
} from '../../revenue/core/errors.js';

// Simple test runner
function test(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`✅ ${name}`);
    } catch (error) {
      console.error(`❌ ${name}`);
      console.error(`   ${error.message}`);
      if (error.stack) {
        console.error(`   ${error.stack.split('\n')[1]}`);
      }
      process.exit(1);
    }
  };
}

async function assertThrows(fn, ErrorClass, message) {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    if (!(error instanceof ErrorClass)) {
      throw new Error(`${message}: expected ${ErrorClass.name}, got ${error.constructor.name}`);
    }
  }
  if (!threw) {
    throw new Error(`${message}: expected to throw ${ErrorClass.name}`);
  }
}

// ============================================================
// MOCKS
// ============================================================

class MockSubscription {
  constructor(data) {
    Object.assign(this, {
      _id: 'sub_' + Math.random().toString(36).substring(7),
      organizationId: 'org_123',
      customerId: 'cust_123',
      amount: 1500,
      currency: 'BDT',
      planKey: 'monthly',
      status: 'active',
      metadata: {},
      ...data,
    });
  }

  async save() {
    return this;
  }

  static async findById(id) {
    if (id === 'sub_notfound') return null;
    return new MockSubscription({ _id: id });
  }
}

class MockTransaction {
  static async create(data) {
    return {
      _id: 'txn_' + Math.random().toString(36).substring(7),
      ...data,
    };
  }
}

function createMockProvider(overrides = {}) {
  return {
    createIntent: async (params) => ({
      id: 'pi_' + Math.random().toString(36).substring(7),
      status: 'pending',
      amount: params.amount,
      currency: params.currency,
      provider: 'test',
    }),
    getCapabilities: () => ({
      supportsRefunds: true,
      supportsWebhooks: true,
    }),
    ...overrides,
  };
}

function createContainer(provider) {
  const container = new Container();
  container.singleton('models', {
    Transaction: MockTransaction,
    Subscription: MockSubscription,
  });
  container.singleton('providers', { test: provider });
  container.singleton('hooks', {});
  container.singleton('config', {
    commissionRates: {},
    gatewayFeeRates: {},
    categoryMappings: {},
  });
  container.singleton('logger', { warn: () => {}, error: () => {}, info: () => {} });
  return container;
}

// ============================================================
// TESTS
// ============================================================

console.log('\n🧪 Testing Subscription Service\n');

// Test: renew() - provider failure wrapped in PaymentIntentCreationError
await test('renew() wraps provider failures in PaymentIntentCreationError', async () => {
  const provider = createMockProvider({
    createIntent: async () => {
      throw new Error('Provider API down');
    },
  });

  const container = createContainer(provider);
  const service = new SubscriptionService(container);

  await assertThrows(
    () => service.renew('sub_123', { gateway: 'test' }),
    PaymentIntentCreationError,
    'Should wrap provider error in PaymentIntentCreationError'
  );
})();

// Test: renew() - network timeout handled
await test('renew() handles provider timeout', async () => {
  const provider = createMockProvider({
    createIntent: async () => {
      const error = new Error('ETIMEDOUT');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });

  const container = createContainer(provider);
  const service = new SubscriptionService(container);

  await assertThrows(
    () => service.renew('sub_123', { gateway: 'test' }),
    PaymentIntentCreationError,
    'Should handle timeout errors'
  );
})();

// Test: renew() - subscription not found
await test('renew() throws when subscription not found', async () => {
  const provider = createMockProvider();
  const container = createContainer(provider);
  const service = new SubscriptionService(container);

  await assertThrows(
    () => service.renew('sub_notfound', { gateway: 'test' }),
    SubscriptionNotFoundError,
    'Should throw SubscriptionNotFoundError'
  );
})();

// Test: renew() - success case creates transaction
await test('renew() creates transaction on success', async () => {
  const provider = createMockProvider();
  const container = createContainer(provider);
  const service = new SubscriptionService(container);

  const result = await service.renew('sub_123', { gateway: 'test' });

  if (!result.transaction) {
    throw new Error('Should return transaction');
  }
  if (!result.paymentIntent) {
    throw new Error('Should return paymentIntent');
  }
  if (!result.subscription) {
    throw new Error('Should return subscription');
  }
})();

console.log('\n✅ All subscription service tests passed!\n');
