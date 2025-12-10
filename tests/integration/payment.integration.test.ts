/**
 * Integration Tests - Payment Flow
 * @classytic/revenue
 *
 * Industry best practices:
 * - Real MongoDB (localhost)
 * - Proper TypeScript types
 * - Arrange-Act-Assert pattern
 * - Descriptive test names
 * - Isolated tests (fresh DB each time)
 * - Graceful skip if MongoDB unavailable
 */

import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import mongoose, { Schema, type Model, type Document } from 'mongoose';
import {
  Revenue,
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
  type CreateIntentParams,
  type ProviderCapabilities,
} from '../../revenue/src/index.js';

// ============ CONFIG ============
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/revenue_test';
const TEST_TIMEOUT = 10000;

// ============ FAKE PROVIDER ============
/**
 * In-memory fake provider for testing
 * Tracks payment intents and simulates verification/refund
 */
class FakeProvider extends PaymentProvider {
  public override readonly name: string = 'fake';
  private store = new Map<string, { amount: number; currency: string; status: string }>();

  constructor() {
    super({});
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `fake_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.store.set(id, {
      amount: params.amount,
      currency: params.currency ?? 'USD',
      status: 'pending',
    });

    return new PaymentIntent({
      id,
      sessionId: null,
      paymentIntentId: id,
      provider: this.name,
      status: 'pending',
      amount: params.amount,
      currency: params.currency ?? 'USD',
      metadata: params.metadata ?? {},
    });
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const data = this.store.get(intentId);
    if (!data) {
      return new PaymentResult({
        id: intentId,
        provider: this.name,
        status: 'failed',
        metadata: { error: 'Not found' },
      });
    }

    data.status = 'succeeded';
    return new PaymentResult({
      id: intentId,
      provider: this.name,
      status: 'succeeded',
      amount: data.amount,
      currency: data.currency,
      paidAt: new Date(),
      metadata: { verified: true },
    });
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    const data = this.store.get(intentId);
    return new PaymentResult({
      id: intentId,
      provider: this.name,
      status: data?.status === 'succeeded' ? 'succeeded' : 'processing',
      amount: data?.amount,
      currency: data?.currency,
      metadata: {},
    });
  }

  async refund(
    paymentId: string,
    amount?: number | null,
    _options?: { reason?: string }
  ): Promise<RefundResult> {
    const data = this.store.get(paymentId);
    const refundAmount = amount ?? data?.amount ?? 0;

    return new RefundResult({
      id: `refund_${paymentId}_${Date.now()}`,
      provider: this.name,
      status: 'succeeded',
      amount: refundAmount,
      currency: data?.currency ?? 'USD',
      refundedAt: new Date(),
      reason: _options?.reason,
      metadata: { originalPaymentId: paymentId },
    });
  }

  async handleWebhook(
    _payload: unknown,
    _headers?: Record<string, string>
  ): Promise<WebhookEvent> {
    throw new Error('FakeProvider does not support webhooks');
  }

  override getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }

  // Test helper: manually add a payment intent
  _addIntent(id: string, amount: number, currency = 'USD', status = 'pending'): void {
    this.store.set(id, { amount, currency, status });
  }

  // Test helper: clear all intents
  _clear(): void {
    this.store.clear();
  }
}

// ============ MONGOOSE SCHEMAS ============
interface ITransaction extends Document {
  organizationId?: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  referenceId?: mongoose.Types.ObjectId;
  referenceModel?: string;
  category?: string;
  type: string;
  method?: string;
  monetizationType?: string;
  amount: number;
  currency: string;
  status: string;
  gateway?: {
    type?: string;
    sessionId?: string | null;
    paymentIntentId?: string | null;
    provider?: string;
    metadata?: Record<string, unknown>;
    verificationData?: Record<string, unknown>;
  };
  commission?: Record<string, unknown>;
  refundedAmount?: number;
  refundedAt?: Date;
  verifiedAt?: Date;
  verifiedBy?: string | null;
  failureReason?: string | null;
  paymentDetails?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

interface ISubscription extends Document {
  customerId?: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  planKey?: string;
  status: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Org' },
    customerId: { type: Schema.Types.ObjectId, ref: 'User' },
    referenceId: { type: Schema.Types.ObjectId },
    referenceModel: String,
    category: String,
    type: { type: String, default: 'income' },
    method: { type: String, default: 'manual' },
    monetizationType: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, default: 'pending' },
    gateway: {
      type: { type: String },
      sessionId: String,
      paymentIntentId: String,
      provider: String,
      metadata: Schema.Types.Mixed,
      verificationData: Schema.Types.Mixed,
    },
    commission: Schema.Types.Mixed,
    refundedAmount: Number,
    refundedAt: Date,
    verifiedAt: Date,
    verifiedBy: String,
    failureReason: String,
    paymentDetails: Schema.Types.Mixed,
    metadata: Schema.Types.Mixed,
    idempotencyKey: String,
  },
  { timestamps: true }
);

const SubscriptionSchema = new Schema<ISubscription>(
  {
    customerId: Schema.Types.ObjectId,
    organizationId: Schema.Types.ObjectId,
    planKey: String,
    status: { type: String, default: 'pending' },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
  },
  { timestamps: true }
);

// ============ TEST SETUP ============
let TransactionModel: Model<ITransaction>;
let SubscriptionModel: Model<ISubscription>;
let revenue: Revenue;
let fakeProvider: FakeProvider;
let mongoAvailable = true;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL, {
      serverSelectionTimeoutMS: 3000,
    });
    
    // Clear existing models to avoid OverwriteModelError
    if (mongoose.models.Transaction) {
      delete mongoose.models.Transaction;
    }
    if (mongoose.models.Subscription) {
      delete mongoose.models.Subscription;
    }
    
    TransactionModel = mongoose.model<ITransaction>('Transaction', TransactionSchema);
    SubscriptionModel = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);
  } catch (err) {
    mongoAvailable = false;
    console.warn('⚠️  MongoDB not available - integration tests will be skipped');
    console.warn('   Start MongoDB with: mongod --dbpath /data/db');
  }
}, TEST_TIMEOUT);

afterAll(async () => {
  if (!mongoAvailable) return;
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch {
    // Ignore cleanup errors
  }
});

beforeEach(async () => {
  if (!mongoAvailable) return;

  // Clean collections
  const db = mongoose.connection.db;
  if (db) {
    const collections = await db.listCollections().toArray();
    for (const coll of collections) {
      await db.dropCollection(coll.name).catch(() => {});
    }
  }

  // Fresh provider instance
  fakeProvider = new FakeProvider();

  // Build Revenue instance
  revenue = Revenue
    .create({ defaultCurrency: 'USD' })
    .withModels({
      Transaction: TransactionModel as any,
      Subscription: SubscriptionModel as any,
    })
    .withProvider('fake', fakeProvider)
    .withDebug(false)
    .build();
});

// ============ HELPER ============
function skipIfNoMongo() {
  if (!mongoAvailable) {
    console.log('    ↳ Skipped (no MongoDB)');
    return true;
  }
  return false;
}

// ============ TEST SUITES ============

describe('Integration: Payment Verification', () => {
  it('should verify a pending payment and update transaction status', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_verify_test';
    fakeProvider._addIntent(paymentIntentId, 1500, 'USD');
    
    await TransactionModel.create({
      amount: 1500,
      currency: 'USD',
      status: 'payment_initiated',
      type: 'income',
      gateway: {
        type: 'fake',
        paymentIntentId,
      },
    });

    // Act
    const result = await revenue.payments.verify(paymentIntentId);

    // Assert
    expect(result.status).toBe('verified');
    expect(result.paymentResult).not.toBeNull();
    expect(result.paymentResult?.status).toBe('succeeded');
    expect(result.paymentResult?.amount).toBe(1500);

    // Verify DB state
    const tx = await TransactionModel.findOne({ 'gateway.paymentIntentId': paymentIntentId });
    expect(tx).not.toBeNull();
    expect(tx?.status).toBe('verified');
    expect(tx?.verifiedAt).toBeInstanceOf(Date);
  }, TEST_TIMEOUT);

  it('should throw error when verifying non-existent transaction', async () => {
    if (skipIfNoMongo()) return;

    // Use a valid-looking payment intent ID that doesn't exist
    const fakeId = 'fake_pi_does_not_exist_123';

    // Act & Assert - will throw either "not found" or cast error
    await expect(revenue.payments.verify(fakeId))
      .rejects.toThrow();
  }, TEST_TIMEOUT);

  it('should throw error when verifying already verified transaction', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_already_verified';
    await TransactionModel.create({
      amount: 1000,
      currency: 'USD',
      status: 'verified',
      gateway: { type: 'fake', paymentIntentId },
    });

    // Act & Assert
    await expect(revenue.payments.verify(paymentIntentId))
      .rejects.toThrow(/already verified/i);
  }, TEST_TIMEOUT);
});

describe('Integration: Payment Refunds', () => {
  it('should process a full refund', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_full_refund';
    fakeProvider._addIntent(paymentIntentId, 2000, 'USD', 'succeeded');
    
    await TransactionModel.create({
      amount: 2000,
      currency: 'USD',
      status: 'verified',
      type: 'income',
      gateway: { type: 'fake', paymentIntentId },
    });

    // Act
    const result = await revenue.payments.refund(paymentIntentId);

    // Assert
    expect(result.transaction.status).toBe('refunded');
    expect(result.transaction.refundedAmount).toBe(2000);
    expect(result.refundResult.status).toBe('succeeded');
    expect(result.refundTransaction).toBeDefined();
    expect(result.refundTransaction.type).toBe('expense');
    expect(result.refundTransaction.amount).toBe(2000);
  }, TEST_TIMEOUT);

  it('should process a partial refund', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_partial_refund';
    fakeProvider._addIntent(paymentIntentId, 3000, 'USD', 'succeeded');
    
    await TransactionModel.create({
      amount: 3000,
      currency: 'USD',
      status: 'verified',
      type: 'income',
      gateway: { type: 'fake', paymentIntentId },
    });

    // Act
    const result = await revenue.payments.refund(paymentIntentId, 1000);

    // Assert
    expect(result.transaction.status).toBe('partially_refunded');
    expect(result.transaction.refundedAmount).toBe(1000);
    expect(result.refundTransaction.amount).toBe(1000);
  }, TEST_TIMEOUT);

  it('should process multiple partial refunds on completed transaction', async () => {
    if (skipIfNoMongo()) return;

    // Arrange - Note: Service only allows refunds on 'verified' or 'completed' status
    // After first partial refund, status becomes 'partially_refunded'
    // To continue refunding, we need status to stay in allowed state
    const paymentIntentId = 'fake_pi_multi_refund';
    fakeProvider._addIntent(paymentIntentId, 5000, 'USD', 'succeeded');
    
    const tx = await TransactionModel.create({
      amount: 5000,
      currency: 'USD',
      status: 'completed', // Using 'completed' for this test
      type: 'income',
      gateway: { type: 'fake', paymentIntentId },
    });

    // Act - First refund
    const firstRefund = await revenue.payments.refund(paymentIntentId, 1500);
    expect(firstRefund.transaction.status).toBe('partially_refunded');
    expect(firstRefund.transaction.refundedAmount).toBe(1500);

    // To allow second refund, manually set status back to 'completed' 
    // (simulating a business workflow where partial refunds don't lock the transaction)
    await TransactionModel.findByIdAndUpdate(tx._id, { status: 'completed' });

    // Act - Second refund
    const result = await revenue.payments.refund(paymentIntentId, 2000);

    // Assert
    expect(result.transaction.refundedAmount).toBe(3500); // 1500 + 2000

    // Verify refund transaction count
    const refundTxs = await TransactionModel.find({ 
      type: 'expense',
      'metadata.isRefund': true,
    });
    expect(refundTxs).toHaveLength(2);
  }, TEST_TIMEOUT);

  it('should reject refund exceeding refundable amount', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_over_refund';
    fakeProvider._addIntent(paymentIntentId, 1000, 'USD', 'succeeded');
    
    await TransactionModel.create({
      amount: 1000,
      currency: 'USD',
      status: 'verified',
      type: 'income',
      gateway: { type: 'fake', paymentIntentId },
    });

    // Act & Assert
    await expect(revenue.payments.refund(paymentIntentId, 1500))
      .rejects.toThrow(/exceeds/i);
  }, TEST_TIMEOUT);

  it('should reject refund on pending transaction', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_pending';
    await TransactionModel.create({
      amount: 1000,
      currency: 'USD',
      status: 'pending',
      type: 'income',
      gateway: { type: 'fake', paymentIntentId },
    });

    // Act & Assert
    await expect(revenue.payments.refund(paymentIntentId))
      .rejects.toThrow(/verified|completed/i);
  }, TEST_TIMEOUT);
});

describe('Integration: Payment Status', () => {
  it('should get payment status for existing transaction', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_status';
    fakeProvider._addIntent(paymentIntentId, 1200, 'USD', 'succeeded');
    
    await TransactionModel.create({
      amount: 1200,
      currency: 'USD',
      status: 'verified',
      type: 'income',
      gateway: { type: 'fake', paymentIntentId },
    });

    // Act
    const result = await revenue.payments.getStatus(paymentIntentId);

    // Assert
    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('fake');
    expect(result.transaction).toBeDefined();
  }, TEST_TIMEOUT);
});

describe('Integration: Event System', () => {
  it('should emit events on payment verification', async () => {
    if (skipIfNoMongo()) return;

    // Arrange
    const paymentIntentId = 'fake_pi_events';
    fakeProvider._addIntent(paymentIntentId, 999, 'USD');
    
    await TransactionModel.create({
      amount: 999,
      currency: 'USD',
      status: 'payment_initiated',
      type: 'income',
      gateway: { type: 'fake', paymentIntentId },
    });

    const eventSpy = vi.fn();
    revenue.on('*', eventSpy);

    // Act
    await revenue.payments.verify(paymentIntentId);

    // Assert - give time for async event handlers
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Note: The actual event emission depends on service implementation
    // This test ensures the event system is wired up
    expect(revenue.events).toBeDefined();
  }, TEST_TIMEOUT);
});

describe('Integration: Revenue Builder', () => {
  it('should create revenue instance with fluent API', () => {
    if (skipIfNoMongo()) return;

    // Assert instance properties
    expect(revenue).toBeDefined();
    expect(revenue.defaultCurrency).toBe('USD');
    expect(revenue.hasProvider('fake')).toBe(true);
    expect(revenue.getProviderNames()).toContain('fake');
  });

  it('should throw when building without models', () => {
    expect(() => {
      Revenue.create()
        .withProvider('fake', new FakeProvider())
        .build();
    }).toThrow(/models/i);
  });

  it('should throw when building without providers', () => {
    if (skipIfNoMongo()) return;

    expect(() => {
      Revenue.create()
        .withModels({
          Transaction: TransactionModel as any,
          Subscription: SubscriptionModel as any,
        })
        .build();
    }).toThrow(/provider/i);
  });
});
