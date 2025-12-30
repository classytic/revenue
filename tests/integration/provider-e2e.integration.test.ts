/**
 * Provider Integration End-to-End Tests
 * @classytic/revenue
 *
 * Tests full payment lifecycle with provider:
 * - Intent creation → verification → webhook handling → refund
 * - Provider failure scenarios
 * - Webhook signature validation
 * - Idempotency guarantees
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema, Model } from 'mongoose';
import { Revenue } from '../../revenue/src/core/revenue.js';
import { connectToMongoDB, disconnectFromMongoDB, clearCollections } from '../helpers/mongodb-memory.js';
import type {
  PaymentProvider,
  CreateIntentParams,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '../../revenue/src/providers/base.js';

/**
 * Inline schemas for testing
 * Same pattern as tax-correctness tests
 */
interface ITransaction {
  organizationId?: string | mongoose.Types.ObjectId;
  customerId?: string | mongoose.Types.ObjectId;
  sourceId?: string | mongoose.Types.ObjectId;
  sourceId?: string | mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  status: string;
  flow?: 'inflow' | 'outflow';
}

interface ISubscription {
  customerId?: string | mongoose.Types.ObjectId;
  organizationId?: string | mongoose.Types.ObjectId;
  planKey?: string;
  status: string;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    organizationId: Schema.Types.Mixed,
    customerId: Schema.Types.Mixed,
    sourceId: Schema.Types.Mixed,
    sourceModel: String,
    category: String,
    type: { type: String, default: 'payment' },
    flow: { type: String, default: 'inflow' },
    method: { type: String, default: 'manual' },
    monetizationType: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, default: 'pending' },
    gateway: Schema.Types.Mixed,
    commission: Schema.Types.Mixed,
    tax: Schema.Types.Mixed,
    escrow: Schema.Types.Mixed,
    refundedAmount: Number,
    verifiedAt: Date,
    metadata: Schema.Types.Mixed,
    idempotencyKey: String,
  },
  { timestamps: true, strict: false }
);

const SubscriptionSchema = new Schema<ISubscription>(
  {
    customerId: Schema.Types.Mixed,
    organizationId: Schema.Types.Mixed,
    planKey: String,
    status: { type: String, default: 'pending' },
  },
  { timestamps: true, strict: false }
);

/**
 * Mock Payment Provider for Testing
 * Simulates real gateway behavior with success/failure modes
 */
class MockPaymentProvider implements PaymentProvider {
  name = 'mock-gateway';

  private intentStore = new Map<string, any>();
  private refundStore = new Map<string, any>();
  private shouldFailIntentCreation = false;
  private shouldFailVerification = false;
  private shouldFailRefund = false;

  capabilities = {
    supportsRefunds: true,
    supportsPartialRefunds: true,
    supportsWebhooks: true,
    supportsRecurring: true,
  };

  // Test helpers
  simulateIntentFailure() {
    this.shouldFailIntentCreation = true;
  }

  simulateVerificationFailure() {
    this.shouldFailVerification = true;
  }

  simulateRefundFailure() {
    this.shouldFailRefund = true;
  }

  reset() {
    this.shouldFailIntentCreation = false;
    this.shouldFailVerification = false;
    this.shouldFailRefund = false;
    this.intentStore.clear();
    this.refundStore.clear();
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    if (this.shouldFailIntentCreation) {
      throw new Error('Payment provider unavailable');
    }

    const intentId = `pi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sessionId = `ses_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const intent: PaymentIntent = {
      id: intentId,
      status: 'requires_confirmation',
      amount: params.amount,
      currency: params.currency,
      paymentIntentId: intentId,
      sessionId,
      provider: this.name,
      metadata: params.metadata || {},
    };

    this.intentStore.set(intentId, intent);

    return intent;
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    if (this.shouldFailVerification) {
      throw new Error('Verification failed: Payment declined');
    }

    const intent = this.intentStore.get(intentId);
    if (!intent) {
      throw new Error('Payment intent not found');
    }

    // Simulate successful verification
    intent.status = 'succeeded';
    this.intentStore.set(intentId, intent);

    return {
      success: true,
      transactionId: intent.paymentIntentId,
      amount: intent.amount,
      currency: intent.currency,
      provider: this.name,
      providerTransactionId: intent.paymentIntentId,
      status: 'succeeded',
      metadata: intent.metadata,
    };
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(
    paymentId: string,
    amount?: number | null,
    options?: { reason?: string }
  ): Promise<RefundResult> {
    if (this.shouldFailRefund) {
      throw new Error('Refund failed: Insufficient funds');
    }

    const intent = this.intentStore.get(paymentId);
    if (!intent) {
      throw new Error('Payment intent not found');
    }

    if (intent.status !== 'succeeded') {
      throw new Error('Cannot refund unverified payment');
    }

    const refundId = `re_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const refundAmount = amount || intent.amount;

    const refund: RefundResult = {
      success: true,
      refundId,
      amount: refundAmount,
      currency: intent.currency,
      provider: this.name,
      providerRefundId: refundId,
      status: 'succeeded',
      reason: options?.reason,
      metadata: {},
    };

    this.refundStore.set(refundId, refund);

    return refund;
  }

  getCapabilities() {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }

  async handleWebhook(payload: any, signature: string): Promise<WebhookEvent> {
    // Simulate webhook signature validation
    if (!signature || signature !== 'valid_signature') {
      throw new Error('Invalid webhook signature');
    }

    // Parse webhook event
    const eventType = payload.type;
    const paymentIntentId = payload.data?.object?.id;

    return {
      type: eventType,
      provider: this.name,
      transactionId: paymentIntentId,
      data: payload.data,
      raw: payload,
    };
  }
}

describe('Provider Integration E2E', () => {
  let Transaction: Model<ITransaction>;
  let Subscription: Model<ISubscription>;
  let revenue: ReturnType<typeof Revenue.create> extends { build(): infer R } ? R : never;
  let mockProvider: MockPaymentProvider;
  let mongoAvailable = true;

  beforeAll(async () => {
    mongoAvailable = await connectToMongoDB();
    if (mongoAvailable) {
      // Clear existing models to avoid OverwriteModelError
      if (mongoose.models.Transaction) {
        delete mongoose.models.Transaction;
      }
      if (mongoose.models.Subscription) {
        delete mongoose.models.Subscription;
      }
      Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);
      Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);
    }
  }, 30000);

  afterAll(async () => {
    if (mongoAvailable) {
      await disconnectFromMongoDB();
    }
  });

  beforeEach(async () => {
    if (!mongoAvailable) return;

    // Clear collections before each test
    await clearCollections();

    // Create mock provider
    mockProvider = new MockPaymentProvider();
    mockProvider.reset();

    // Build revenue instance
    revenue = Revenue.create({ defaultCurrency: 'USD' })
      .withModels({ Transaction, Subscription })
      .withProvider('mock-gateway', mockProvider)
      .build();
  });

  describe('Full Payment Lifecycle: Intent → Verify → Webhook → Refund', () => {
    it('should complete full successful payment flow', async () => {
      if (!mongoAvailable) return;

      // Step 1: Create monetization (creates payment intent)
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000, // $100
        currency: 'USD',
        gateway: 'mock-gateway',
        monetizationType: 'subscription',
      });

      expect(createResult.transaction).toBeDefined();
      expect(createResult.paymentIntent).toBeDefined();
      expect(createResult.paymentIntent?.status).toBe('requires_confirmation');

      const transaction = createResult.transaction!;
      const paymentIntentId = createResult.paymentIntent!.id;

      // Transaction should be pending
      expect(transaction.status).toBe('pending');
      expect(transaction.gateway.paymentIntentId).toBe(paymentIntentId);

      // Step 2: Verify payment
      const verifyResult = await revenue.payments.verify(
        transaction._id.toString()
      );

      expect(verifyResult.status).toBe('verified');
      expect(verifyResult.transaction).toBeDefined();

      // Transaction should be verified
      const verifiedTx = await Transaction.findById(transaction._id);
      expect(verifiedTx.status).toBe('verified');

      // Step 3: Simulate webhook (payment.succeeded)
      const webhookPayload = {
        type: 'payment.succeeded',
        data: {
          object: {
            id: paymentIntentId,
            status: 'succeeded',
            amount: 10000,
          },
        },
      };

      const webhookResult = await mockProvider.handleWebhook(
        webhookPayload,
        'valid_signature'
      );

      expect(webhookResult.type).toBe('payment.succeeded');
      expect(webhookResult.transactionId).toBe(paymentIntentId);

      // Step 4: Full refund
      const refundResult = await revenue.payments.refund(
        transaction._id.toString(),
        null, // Full refund
        {
          reason: 'Customer request',
        }
      );

      expect(refundResult.refundTransaction).toBeDefined();
      expect(refundResult.refundTransaction.amount).toBe(10000);
      expect(refundResult.status).toBe('refunded');

      // Original transaction should be refunded
      const refundedTx = await Transaction.findById(transaction._id);
      expect(refundedTx.status).toBe('refunded');
    });

    it('should handle partial refund flow', async () => {
      if (!mongoAvailable) return;

      // Create and verify transaction
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'mock-gateway',
        monetizationType: 'subscription',
      });

      const transaction = createResult.transaction!;
      await revenue.payments.verify(transaction._id.toString());

      // Partial refund (40%)
      const refundResult = await revenue.payments.refund(
        transaction._id.toString(),
        4000, // $40
        {
          reason: 'Partial refund',
        }
      );

      expect(refundResult.refundTransaction).toBeDefined();
      expect(refundResult.refundTransaction.amount).toBe(4000);
      expect(refundResult.status).toBe('partially_refunded');

      // Original transaction should be partially refunded
      const partiallyRefundedTx = await Transaction.findById(transaction._id);
      expect(partiallyRefundedTx.status).toBe('partially_refunded');

      // Second partial refund (remaining 60%)
      const secondRefund = await revenue.payments.refund(
        transaction._id.toString(),
        6000,
        {
          reason: 'Final refund',
        }
      );

      expect(secondRefund.refundResult.success).toBe(true);

      // Now should be fully refunded
      const fullyRefundedTx = await Transaction.findById(transaction._id);
      expect(fullyRefundedTx.status).toBe('refunded');
    });
  });

  describe('Provider Failure Scenarios', () => {
    it('should handle intent creation failure gracefully', async () => {
      if (!mongoAvailable) return;

      mockProvider.simulateIntentFailure();

      await expect(async () => {
        await revenue.monetization.create({
          data: { organizationId: 'org_123', customerId: 'cust_456' },
          planKey: 'monthly',
          amount: 10000,
          currency: 'USD',
          gateway: 'mock-gateway',
          monetizationType: 'subscription',
        });
      }).rejects.toThrow('Failed to create payment intent');

      // No transaction should be created
      const txCount = await Transaction.countDocuments();
      expect(txCount).toBe(0);
    });

    it('should handle verification failure and mark transaction as failed', async () => {
      if (!mongoAvailable) return;

      // Create transaction successfully
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'mock-gateway',
        monetizationType: 'subscription',
      });

      const transaction = createResult.transaction!;

      // Simulate verification failure
      mockProvider.simulateVerificationFailure();

      await expect(async () => {
        await revenue.payments.verify(transaction._id.toString());
      }).rejects.toThrow('Payment verification failed');

      // Transaction should be marked as failed
      const failedTx = await Transaction.findById(transaction._id);
      expect(failedTx.status).toBe('failed');
    });

    it('should handle refund failure', async () => {
      if (!mongoAvailable) return;

      // Create and verify transaction
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'mock-gateway',
        monetizationType: 'subscription',
      });

      const transaction = createResult.transaction!;
      await revenue.payments.verify(transaction._id.toString());

      // Simulate refund failure
      mockProvider.simulateRefundFailure();

      await expect(async () => {
        await revenue.payments.refund(transaction._id.toString());
      }).rejects.toThrow('Refund failed');

      // Transaction should remain verified (refund didn't succeed)
      const stillVerifiedTx = await Transaction.findById(transaction._id);
      expect(stillVerifiedTx.status).toBe('verified');
    });
  });

  describe('Webhook Signature Validation', () => {
    it('should reject webhook with invalid signature', async () => {
      if (!mongoAvailable) return;

      const webhookPayload = {
        type: 'payment.succeeded',
        data: { object: { id: 'pi_test' } },
      };

      await expect(async () => {
        await mockProvider.handleWebhook(webhookPayload, 'invalid_signature');
      }).rejects.toThrow('Invalid webhook signature');
    });

    it('should accept webhook with valid signature', async () => {
      if (!mongoAvailable) return;

      const webhookPayload = {
        type: 'payment.succeeded',
        data: { object: { id: 'pi_test', status: 'succeeded' } },
      };

      const result = await mockProvider.handleWebhook(
        webhookPayload,
        'valid_signature'
      );

      expect(result.type).toBe('payment.succeeded');
      expect(result.transactionId).toBe('pi_test');
    });
  });

  describe('Multi-Gateway Support', () => {
    it('should handle multiple providers simultaneously', async () => {
      if (!mongoAvailable) return;

      // Add second mock provider
      const secondProvider = new MockPaymentProvider();
      secondProvider.name = 'second-gateway';

      const multiGatewayRevenue = Revenue.create({ defaultCurrency: 'USD' })
        .withModels({ Transaction, Subscription })
        .withProvider('first-gateway', mockProvider)
        .withProvider('second-gateway', secondProvider)
        .build();

      // Create transaction with first gateway
      const first = await multiGatewayRevenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'first-gateway',
        monetizationType: 'subscription',
      });

      // Create transaction with second gateway
      const second = await multiGatewayRevenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_789' },
        planKey: 'monthly',
        amount: 15000,
        currency: 'USD',
        gateway: 'second-gateway',
        monetizationType: 'subscription',
      });

      // Both should succeed with different gateways
      expect(first.transaction?.gateway.type).toBe('first-gateway');
      expect(second.transaction?.gateway.type).toBe('second-gateway');

      // Verify both work independently
      await multiGatewayRevenue.payments.verify(
        first.transaction!._id.toString()
      );
      await multiGatewayRevenue.payments.verify(
        second.transaction!._id.toString()
      );

      const verifiedFirst = await Transaction.findById(first.transaction?._id);
      const verifiedSecond = await Transaction.findById(second.transaction?._id);

      expect(verifiedFirst.status).toBe('verified');
      expect(verifiedSecond.status).toBe('verified');
    });
  });
});
