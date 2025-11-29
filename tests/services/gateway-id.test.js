/**
 * Gateway ID Handling Tests
 * @classytic/revenue
 *
 * Tests for sessionId/paymentIntentId handling across payment flows
 */

import { PaymentService } from '../../revenue/services/payment.service.js';
import { MonetizationService } from '../../revenue/services/monetization.service.js';
import { PaymentIntent } from '../../revenue/providers/base.js';
import { Container } from '../../revenue/core/container.js';
import { TransactionNotFoundError } from '../../revenue/core/errors.js';

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

function assertNull(actual, message) {
  if (actual !== null) {
    throw new Error(`${message}: expected null, got ${actual}`);
  }
}

function assertNotNull(actual, message) {
  if (actual === null || actual === undefined) {
    throw new Error(`${message}: expected non-null value`);
  }
}

// ============================================================
// MOCKS
// ============================================================

let mockTransactionStore = [];

class MockTransaction {
  constructor(data) {
    Object.assign(this, {
      _id: 'txn_' + Math.random().toString(36).substring(7),
      amount: 1000,
      currency: 'BDT',
      status: 'pending',
      gateway: {},
      metadata: {},
      ...data,
    });
  }

  async save() {
    const idx = mockTransactionStore.findIndex(t => t._id === this._id);
    if (idx >= 0) {
      mockTransactionStore[idx] = this;
    }
    return this;
  }

  static async findById(id) {
    return mockTransactionStore.find(t => t._id === id) || null;
  }

  static async findOne(query) {
    if (query['gateway.sessionId']) {
      return mockTransactionStore.find(
        t => t.gateway?.sessionId === query['gateway.sessionId']
      ) || null;
    }
    if (query['gateway.paymentIntentId']) {
      return mockTransactionStore.find(
        t => t.gateway?.paymentIntentId === query['gateway.paymentIntentId']
      ) || null;
    }
    return null;
  }

  static async create(data) {
    const txn = new MockTransaction(data);
    mockTransactionStore.push(txn);
    return txn;
  }

  static reset() {
    mockTransactionStore = [];
  }
}

function createCheckoutProvider() {
  return {
    createIntent: async (params) => new PaymentIntent({
      id: 'cs_test_' + Math.random().toString(36).substring(7),
      sessionId: 'cs_test_' + Math.random().toString(36).substring(7),
      paymentIntentId: null,
      provider: 'stripe-checkout',
      status: 'pending',
      amount: params.amount,
      currency: params.currency,
      paymentUrl: 'https://checkout.stripe.com/test',
      metadata: params.metadata,
    }),
    verifyPayment: async () => ({ status: 'succeeded', amount: 1000, currency: 'BDT' }),
    getStatus: async () => ({ status: 'pending' }),
    handleWebhook: async () => ({
      id: 'evt_123',
      type: 'payment.succeeded',
      data: {
        sessionId: 'cs_test_abc123',
        paymentIntentId: 'pi_from_webhook',
        amount: 1000,
      },
    }),
    getCapabilities: () => ({ supportsWebhooks: true, supportsRefunds: true }),
    refund: async (id, amount) => ({ id: 'rf_123', status: 'succeeded', amount }),
  };
}

function createPaymentIntentsProvider() {
  return {
    createIntent: async (params) => new PaymentIntent({
      id: 'pi_' + Math.random().toString(36).substring(7),
      sessionId: null,
      paymentIntentId: 'pi_' + Math.random().toString(36).substring(7),
      provider: 'stripe-intents',
      status: 'pending',
      amount: params.amount,
      currency: params.currency,
      clientSecret: 'pi_secret_123',
      metadata: params.metadata,
    }),
    verifyPayment: async () => ({ status: 'succeeded', amount: 1000, currency: 'BDT' }),
    getStatus: async () => ({ status: 'pending' }),
    handleWebhook: async () => ({
      id: 'evt_456',
      type: 'payment.succeeded',
      data: { paymentIntentId: 'pi_abc123', amount: 1000 },
    }),
    getCapabilities: () => ({ supportsWebhooks: true, supportsRefunds: true }),
    refund: async (id, amount) => ({ id: 'rf_456', status: 'succeeded', amount }),
  };
}

function createManualProvider() {
  return {
    createIntent: async (params) => new PaymentIntent({
      id: 'manual_' + Math.random().toString(36).substring(7),
      sessionId: null,
      paymentIntentId: null,
      provider: 'manual',
      status: 'pending',
      amount: params.amount,
      currency: params.currency,
      instructions: 'Please pay via bank transfer',
      metadata: params.metadata,
    }),
    verifyPayment: async () => ({ status: 'succeeded', amount: 1000, currency: 'BDT' }),
    getStatus: async () => ({ status: 'pending' }),
    getCapabilities: () => ({
      supportsWebhooks: false,
      supportsRefunds: true,
      requiresManualVerification: true,
    }),
    refund: async (id, amount) => ({ id: 'rf_manual', status: 'succeeded', amount }),
  };
}

function createContainer(providers) {
  const container = new Container();
  container.singleton('models', { Transaction: MockTransaction });
  container.singleton('providers', providers);
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

console.log('\n🧪 Testing Gateway ID Handling\n');

// Test: PaymentIntent class has sessionId and paymentIntentId
await test('PaymentIntent class has sessionId and paymentIntentId fields', async () => {
  const intent = new PaymentIntent({
    id: 'test_123',
    sessionId: 'cs_test_abc',
    paymentIntentId: 'pi_test_xyz',
    provider: 'stripe',
    status: 'pending',
    amount: 1000,
  });

  assertEquals(intent.sessionId, 'cs_test_abc', 'sessionId should be set');
  assertEquals(intent.paymentIntentId, 'pi_test_xyz', 'paymentIntentId should be set');
})();

// Test: PaymentIntent defaults sessionId and paymentIntentId to null
await test('PaymentIntent defaults sessionId and paymentIntentId to null', async () => {
  const intent = new PaymentIntent({
    id: 'test_123',
    provider: 'manual',
    status: 'pending',
    amount: 1000,
  });

  assertNull(intent.sessionId, 'sessionId should default to null');
  assertNull(intent.paymentIntentId, 'paymentIntentId should default to null');
})();

// Test: Stripe Checkout stores sessionId, paymentIntentId is null
await test('Stripe Checkout: stores sessionId, paymentIntentId is null', async () => {
  MockTransaction.reset();
  const provider = createCheckoutProvider();
  const container = createContainer({ 'stripe-checkout': provider });
  const service = new MonetizationService(container);

  const result = await service.create({
    data: { customerId: 'cust_123' },
    planKey: 'monthly',
    amount: 1000,
    gateway: 'stripe-checkout',
  });

  assertNotNull(result.transaction.gateway.sessionId, 'sessionId should be set');
  assertNull(result.transaction.gateway.paymentIntentId, 'paymentIntentId should be null');
  assertEquals(result.transaction.gateway.sessionId.startsWith('cs_test_'), true, 'sessionId should start with cs_test_');
})();

// Test: Stripe Payment Intents stores paymentIntentId, sessionId is null
await test('Stripe Payment Intents: stores paymentIntentId, sessionId is null', async () => {
  MockTransaction.reset();
  const provider = createPaymentIntentsProvider();
  const container = createContainer({ 'stripe-intents': provider });
  const service = new MonetizationService(container);

  const result = await service.create({
    data: { customerId: 'cust_123' },
    planKey: 'monthly',
    amount: 1000,
    gateway: 'stripe-intents',
  });

  assertNull(result.transaction.gateway.sessionId, 'sessionId should be null');
  assertNotNull(result.transaction.gateway.paymentIntentId, 'paymentIntentId should be set');
  assertEquals(result.transaction.gateway.paymentIntentId.startsWith('pi_'), true, 'paymentIntentId should start with pi_');
})();

// Test: Manual provider has neither sessionId nor paymentIntentId
await test('Manual: neither sessionId nor paymentIntentId', async () => {
  MockTransaction.reset();
  const provider = createManualProvider();
  const container = createContainer({ manual: provider });
  const service = new MonetizationService(container);

  const result = await service.create({
    data: { customerId: 'cust_123' },
    planKey: 'monthly',
    amount: 1000,
    gateway: 'manual',
  });

  assertNull(result.transaction.gateway.sessionId, 'sessionId should be null');
  assertNull(result.transaction.gateway.paymentIntentId, 'paymentIntentId should be null');
})();

// Test: Webhook lookup finds transaction by sessionId
await test('Webhook: finds transaction by sessionId', async () => {
  MockTransaction.reset();
  
  const txn = await MockTransaction.create({
    _id: 'txn_session_test',
    amount: 1000,
    status: 'pending',
    gateway: {
      type: 'stripe-checkout',
      sessionId: 'cs_test_abc123',
      paymentIntentId: null,
    },
  });

  const provider = {
    ...createCheckoutProvider(),
    handleWebhook: async () => ({
      id: 'evt_123',
      type: 'payment.succeeded',
      data: {
        sessionId: 'cs_test_abc123',
        paymentIntentId: 'pi_new_from_webhook',
        amount: 1000,
      },
    }),
  };

  const container = createContainer({ 'stripe-checkout': provider });
  const service = new PaymentService(container);

  const result = await service.handleWebhook('stripe-checkout', {}, {});

  assertEquals(result.status, 'processed', 'Webhook should be processed');
  assertEquals(result.transaction.gateway.sessionId, 'cs_test_abc123', 'sessionId should match');
  assertEquals(result.transaction.gateway.paymentIntentId, 'pi_new_from_webhook', 'paymentIntentId should be updated from webhook');
})();

// Test: Webhook lookup falls back to paymentIntentId
await test('Webhook: falls back to paymentIntentId lookup', async () => {
  MockTransaction.reset();
  
  await MockTransaction.create({
    _id: 'txn_pi_test',
    amount: 1000,
    status: 'pending',
    gateway: {
      type: 'stripe-intents',
      sessionId: null,
      paymentIntentId: 'pi_abc123',
    },
  });

  const provider = {
    ...createPaymentIntentsProvider(),
    handleWebhook: async () => ({
      id: 'evt_456',
      type: 'payment.succeeded',
      data: { paymentIntentId: 'pi_abc123', amount: 1000 },
    }),
  };

  const container = createContainer({ 'stripe-intents': provider });
  const service = new PaymentService(container);

  const result = await service.handleWebhook('stripe-intents', {}, {});

  assertEquals(result.status, 'processed', 'Webhook should be processed');
  assertEquals(result.transaction.gateway.paymentIntentId, 'pi_abc123', 'paymentIntentId should match');
})();

// Test: Webhook updates paymentIntentId from webhook data
await test('Webhook: updates missing paymentIntentId from webhook data', async () => {
  MockTransaction.reset();
  
  const txn = await MockTransaction.create({
    _id: 'txn_update_test',
    amount: 1000,
    status: 'pending',
    gateway: {
      type: 'stripe-checkout',
      sessionId: 'cs_test_update',
      paymentIntentId: null,
    },
  });

  const provider = {
    ...createCheckoutProvider(),
    handleWebhook: async () => ({
      id: 'evt_789',
      type: 'payment.succeeded',
      data: {
        sessionId: 'cs_test_update',
        paymentIntentId: 'pi_updated_from_webhook',
        amount: 1000,
      },
    }),
  };

  const container = createContainer({ 'stripe-checkout': provider });
  const service = new PaymentService(container);

  await service.handleWebhook('stripe-checkout', {}, {});

  const updated = await MockTransaction.findById('txn_update_test');
  assertEquals(updated.gateway.paymentIntentId, 'pi_updated_from_webhook', 'paymentIntentId should be updated');
})();

// Test: verify() finds transaction by sessionId
await test('verify() finds transaction by sessionId', async () => {
  MockTransaction.reset();
  
  await MockTransaction.create({
    _id: 'txn_verify_session',
    amount: 1000,
    status: 'pending',
    gateway: {
      type: 'stripe-checkout',
      sessionId: 'cs_test_verify',
      paymentIntentId: null,
    },
  });

  const provider = createCheckoutProvider();
  const container = createContainer({ 'stripe-checkout': provider });
  const service = new PaymentService(container);

  const result = await service.verify('cs_test_verify');
  assertEquals(result.transaction.gateway.sessionId, 'cs_test_verify', 'Should find by sessionId');
})();

// Test: verify() finds transaction by paymentIntentId
await test('verify() finds transaction by paymentIntentId', async () => {
  MockTransaction.reset();
  
  await MockTransaction.create({
    _id: 'txn_verify_pi',
    amount: 1000,
    status: 'pending',
    gateway: {
      type: 'stripe-intents',
      sessionId: null,
      paymentIntentId: 'pi_test_verify',
    },
  });

  const provider = createPaymentIntentsProvider();
  const container = createContainer({ 'stripe-intents': provider });
  const service = new PaymentService(container);

  const result = await service.verify('pi_test_verify');
  assertEquals(result.transaction.gateway.paymentIntentId, 'pi_test_verify', 'Should find by paymentIntentId');
})();

// Test: refund() finds transaction by sessionId
await test('refund() finds transaction by sessionId', async () => {
  MockTransaction.reset();
  
  await MockTransaction.create({
    _id: 'txn_refund_session',
    amount: 1000,
    status: 'verified',
    gateway: {
      type: 'stripe-checkout',
      sessionId: 'cs_test_refund',
      paymentIntentId: 'pi_test_refund',
    },
  });

  const provider = createCheckoutProvider();
  const container = createContainer({ 'stripe-checkout': provider });
  const service = new PaymentService(container);

  const result = await service.refund('cs_test_refund', 500);
  assertEquals(result.status, 'partially_refunded', 'Should process refund');
})();

console.log('\n✅ All gateway ID handling tests passed!\n');

