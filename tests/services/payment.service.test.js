/**
 * Payment Service Integration Tests
 * @classytic/revenue
 *
 * Tests critical flows: verify, refund, webhook
 */

import { PaymentService } from '../../revenue/services/payment.service.js';
import { Container } from '../../revenue/core/container.js';
import {
  ValidationError,
  ProviderCapabilityError,
  TransactionNotFoundError,
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

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
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

class MockTransaction {
  constructor(data) {
    Object.assign(this, {
      _id: 'txn_' + Math.random().toString(36).substring(7),
      amount: 1000,
      currency: 'BDT',
      status: 'pending',
      gateway: { paymentIntentId: 'pi_123', type: 'test' },
      metadata: {},
      ...data,
    });
  }

  async save() {
    return this;
  }

  static async findById(id) {
    return new MockTransaction({ _id: id });
  }

  static async findOne(query) {
    if (query['gateway.paymentIntentId']) {
      return new MockTransaction({
        gateway: { paymentIntentId: query['gateway.paymentIntentId'], type: 'test' },
      });
    }
    return null;
  }

  static async create(data) {
    return new MockTransaction(data);
  }
}

function createMockProvider(overrides = {}) {
  return {
    verifyPayment: async (id) => ({
      status: 'succeeded',
      amount: 1000,
      currency: 'BDT',
      paidAt: new Date(),
      metadata: {},
    }),
    refund: async (id, amount) => ({
      status: 'refunded',
      amount,
      refundedAt: new Date(),
    }),
    handleWebhook: async (payload, headers) => ({
      type: 'payment.succeeded',
      data: { paymentIntentId: 'pi_123' },
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
  container.singleton('models', { Transaction: MockTransaction });
  container.singleton('providers', { test: provider });
  container.singleton('hooks', {});
  container.singleton('config', { commissionRates: {}, gatewayFeeRates: {} });
  container.singleton('logger', { warn: () => {}, error: () => {}, info: () => {} });
  return container;
}

// ============================================================
// TESTS
// ============================================================

console.log('\n🧪 Testing Payment Service\n');

// Test: verify() - triggers payment.failed hook on error
await test('verify() triggers payment.failed hook on provider error', async () => {
  let hookTriggered = false;
  let hookData = null;

  const provider = createMockProvider({
    verifyPayment: async () => {
      throw new Error('Provider verification failed');
    },
  });

  const container = createContainer(provider);
  
  // Override hooks to capture event
  container.singleton('hooks', {
    'payment.failed': [
      async (data) => {
        hookTriggered = true;
        hookData = data;
      },
    ],
  });

  const service = new PaymentService(container);
  const transaction = new MockTransaction({ amount: 1000 });

  try {
    await service.verify(transaction._id);
  } catch (error) {
    // Expected to throw
  }

  if (!hookTriggered) {
    throw new Error('payment.failed hook was not triggered');
  }

  if (!hookData.transaction || !hookData.error) {
    throw new Error('payment.failed hook missing required data');
  }

  assertEquals(hookData.provider, 'test', 'Hook should include provider name');
})();

// Test: verify() - amount mismatch
await test('verify() rejects amount mismatch', async () => {
  const provider = createMockProvider({
    verifyPayment: async () => ({
      status: 'succeeded',
      amount: 500, // Tampered!
      currency: 'BDT',
    }),
  });

  const container = createContainer(provider);
  const service = new PaymentService(container);

  const transaction = new MockTransaction({ amount: 1000 });

  await assertThrows(
    () => service.verify(transaction._id),
    ValidationError,
    'Should reject amount mismatch'
  );
})();

// Test: verify() - currency mismatch
await test('verify() rejects currency mismatch', async () => {
  const provider = createMockProvider({
    verifyPayment: async () => ({
      status: 'succeeded',
      amount: 1000,
      currency: 'USD', // Wrong currency!
    }),
  });

  const container = createContainer(provider);
  const service = new PaymentService(container);

  const transaction = new MockTransaction({ amount: 1000, currency: 'BDT' });

  await assertThrows(
    () => service.verify(transaction._id),
    ValidationError,
    'Should reject currency mismatch'
  );
})();

// Test: verify() - returns actual status
await test('verify() returns actual status from provider', async () => {
  const provider = createMockProvider({
    verifyPayment: async () => ({
      status: 'processing', // Not succeeded!
      amount: 1000,
      currency: 'BDT',
    }),
  });

  const container = createContainer(provider);
  const service = new PaymentService(container);

  const transaction = new MockTransaction({ amount: 1000, currency: 'BDT' });
  const result = await service.verify(transaction._id);

  assertEquals(result.status, 'processing', 'Should return processing status');
})();

// Test: refund() - over-refund guard
await test('refund() rejects over-refund', async () => {
  const provider = createMockProvider();
  const container = createContainer(provider);
  const service = new PaymentService(container);

  // Mock transaction with partial refund
  const mockTxn = new MockTransaction({
    _id: 'txn_123',
    amount: 1000,
    status: 'verified',
    refundedAmount: 600,
    gateway: { type: 'test', paymentIntentId: 'pi_123' },
  });

  MockTransaction.findOne = async () => null;
  MockTransaction.findById = async () => mockTxn;

  await assertThrows(
    () => service.refund('txn_123', 500), // 600 + 500 > 1000
    ValidationError,
    'Should reject over-refund'
  );
})();

// Test: refund() - negative amount
await test('refund() rejects negative amount', async () => {
  const provider = createMockProvider();
  const container = createContainer(provider);
  const service = new PaymentService(container);

  const mockTxn = new MockTransaction({
    _id: 'txn_123',
    amount: 1000,
    status: 'verified',
    gateway: { type: 'test', paymentIntentId: 'pi_123' },
  });

  MockTransaction.findOne = async () => null;
  MockTransaction.findById = async () => mockTxn;

  await assertThrows(
    () => service.refund('txn_123', -100),
    ValidationError,
    'Should reject negative refund amount'
  );
})();

// Test: refund() - respects refundable balance
await test('refund() calculates refundable balance correctly', async () => {
  const provider = createMockProvider();
  const container = createContainer(provider);
  const service = new PaymentService(container);

  const mockTxn = new MockTransaction({
    _id: 'txn_123',
    amount: 1000,
    status: 'verified',
    refundedAmount: 300,
    gateway: { type: 'test', paymentIntentId: 'pi_123' },
  });

  MockTransaction.findOne = async () => null;
  MockTransaction.findById = async () => mockTxn;

  // Should allow 700 (1000 - 300)
  const result = await service.refund('txn_123', 700);
  assertEquals(result.status, 'partially_refunded', 'Should allow refund up to balance');
})();

// Test: handleWebhook() - capability check
await test('handleWebhook() checks webhook capability', async () => {
  const provider = createMockProvider({
    getCapabilities: () => ({
      supportsRefunds: true,
      supportsWebhooks: false, // No webhook support!
    }),
  });

  const container = createContainer(provider);
  const service = new PaymentService(container);

  await assertThrows(
    () => service.handleWebhook('test', {}, {}),
    ProviderCapabilityError,
    'Should reject provider without webhook support'
  );
})();

// Test: handleWebhook() - payload validation
await test('handleWebhook() validates payload structure', async () => {
  const provider = createMockProvider({
    handleWebhook: async () => ({
      type: 'payment.succeeded',
      data: {}, // Missing paymentIntentId!
    }),
  });

  const container = createContainer(provider);
  const service = new PaymentService(container);

  await assertThrows(
    () => service.handleWebhook('test', {}, {}),
    ValidationError,
    'Should reject malformed webhook payload'
  );
})();

// Test: handleWebhook() - missing transaction
await test('handleWebhook() handles missing transaction gracefully', async () => {
  const provider = createMockProvider();
  const container = createContainer(provider);
  const service = new PaymentService(container);

  // Mock findOne to return null
  MockTransaction.findOne = async () => null;

  await assertThrows(
    () => service.handleWebhook('test', {}, {}),
    TransactionNotFoundError,
    'Should throw when transaction not found'
  );
})();

console.log('\n✅ All payment service tests passed!\n');
