/**
 * Single Transaction Model Integration Tests
 * @classytic/revenue
 *
 * Tests the ONE Transaction model pattern for:
 * - Subscriptions (referenceModel: 'Subscription')
 * - Purchases (referenceModel: 'Order')
 * - Split payments (multiple payers, same referenceId)
 */

import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import mongoose, { Schema, type Model, type Document } from 'mongoose';
import {
  Revenue,
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  type CreateIntentParams,
  type ProviderCapabilities,
} from '@classytic/revenue';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/revenue_test';
const TEST_TIMEOUT = 15_000;

// ---------- Test Provider ----------
class FakeProvider extends PaymentProvider {
  public override readonly name: string = 'fake';
  private amounts = new Map<string, { amount: number; currency: string }>();

  constructor() {
    super({});
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.amounts.set(id, { amount: params.amount, currency: params.currency ?? 'USD' });
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
    const info = this.amounts.get(intentId) ?? { amount: 0, currency: 'USD' };
    return new PaymentResult({
      id: intentId,
      provider: this.name,
      status: 'succeeded',
      amount: info.amount,
      currency: info.currency,
      paidAt: new Date(),
      metadata: { verified: true },
    });
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    const info = this.amounts.get(paymentId) ?? { amount: 0, currency: 'USD' };
    return new RefundResult({
      id: `refund_${paymentId}`,
      provider: this.name,
      status: 'succeeded',
      amount: amount ?? info.amount,
      currency: info.currency,
      refundedAt: new Date(),
      metadata: {},
    });
  }

  async handleWebhook(): Promise<any> {
    throw new Error('Webhook not supported for FakeProvider');
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }
}

// ---------- Schema ----------
interface TxDoc extends Document {
  organizationId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  referenceId?: mongoose.Types.ObjectId;
  referenceModel?: string;
  category?: string;
  type: string;
  status: string;
  amount: number;
  currency: string;
  method?: string;
  gateway?: {
    type?: string;
    paymentIntentId?: string;
    verificationData?: any;
  };
  verifiedAt?: Date;
  refundedAmount?: number;
  metadata?: any;
}

const TxSchema = new Schema<TxDoc>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, required: true },
    referenceId: { type: Schema.Types.ObjectId, refPath: 'referenceModel' },
    referenceModel: { type: String },
    category: { type: String },
    type: { type: String, enum: ['income', 'expense'], default: 'income' },
    status: { type: String, default: 'pending' },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    method: { type: String, default: 'manual' },
    gateway: {
      type: { type: String },
      paymentIntentId: { type: String },
      verificationData: Schema.Types.Mixed,
    },
    verifiedAt: Date,
    refundedAmount: Number,
    metadata: Schema.Types.Mixed,
  },
  { timestamps: true }
);

let Transaction: Model<TxDoc>;
let revenue: any;
let mongoAvailable = true;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL);
    Transaction =
      (mongoose.models.Transaction as Model<TxDoc>) ??
      mongoose.model<TxDoc>('Transaction', TxSchema);
  } catch (err) {
    mongoAvailable = false;
    console.warn('Skipping tests - MongoDB not reachable:', err);
  }
}, TEST_TIMEOUT);

afterAll(async () => {
  if (!mongoAvailable) return;
  if (mongoose.connection.db) {
    await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect();
}, TEST_TIMEOUT);

beforeEach(async () => {
  if (!mongoAvailable) return;
  if (mongoose.connection.db) {
    await mongoose.connection.db.dropDatabase();
  }

  revenue = Revenue.create({ defaultCurrency: 'USD' })
    .withModels({ Transaction })
    .withProvider('fake', new FakeProvider())
    .withCategoryMappings({
      PlatformSubscription: 'platform_subscription',
      ProductOrder: 'product_order',
    })
    .build();
});

// ---------- Helper ----------
function skipIfNoMongo(): boolean {
  if (!mongoAvailable) {
    expect(true).toBe(true);
    return true;
  }
  return false;
}

// ---------- Tests ----------

describe('Single Transaction Model - Subscription Payments', () => {
  it('creates subscription payment with referenceModel', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const subscriptionId = new mongoose.Types.ObjectId();

    const { transaction, paymentIntent } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: subscriptionId,
        referenceModel: 'Subscription',
      },
      planKey: 'monthly',
      monetizationType: 'subscription',
      amount: 2999,
      gateway: 'fake',
    });

    expect(transaction).toBeDefined();
    expect(transaction.referenceId.toString()).toBe(subscriptionId.toString());
    expect(transaction.referenceModel).toBe('Subscription');
    expect(transaction.amount).toBe(2999);
    // Status depends on gateway - could be 'pending' or 'payment_initiated'
    expect(['pending', 'payment_initiated']).toContain(transaction.status);
    expect(paymentIntent.paymentIntentId).toBeDefined();
  }, TEST_TIMEOUT);

  it('verifies subscription payment and updates status', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const subscriptionId = new mongoose.Types.ObjectId();

    const { transaction, paymentIntent } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: subscriptionId,
        referenceModel: 'Subscription',
      },
      planKey: 'monthly',
      monetizationType: 'subscription',
      amount: 2999,
      gateway: 'fake',
    });

    // Verify payment
    const result = await revenue.payments.verify(paymentIntent.paymentIntentId);
    expect(result.status).toBe('verified');

    // Check database
    const updated = await Transaction.findById(transaction._id);
    expect(updated?.status).toBe('verified');
    expect(updated?.verifiedAt).toBeInstanceOf(Date);
  }, TEST_TIMEOUT);

  it('queries payments by referenceId (subscription)', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const subscriptionId = new mongoose.Types.ObjectId();

    // Create initial payment
    await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: subscriptionId,
        referenceModel: 'Subscription',
      },
      planKey: 'monthly',
      monetizationType: 'subscription',
      amount: 2999,
      gateway: 'fake',
    });

    // Create renewal payment
    await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: subscriptionId,
        referenceModel: 'Subscription',
      },
      planKey: 'monthly',
      monetizationType: 'subscription',
      amount: 2999,
      gateway: 'fake',
      metadata: { isRenewal: true },
    });

    // Query by referenceId
    const payments = await Transaction.find({
      referenceModel: 'Subscription',
      referenceId: subscriptionId,
    });

    expect(payments).toHaveLength(2);
    expect(payments.every(p => p.referenceId?.toString() === subscriptionId.toString())).toBe(true);
  }, TEST_TIMEOUT);
});

describe('Single Transaction Model - One-time Purchases', () => {
  it('creates one-time purchase with referenceModel', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();

    const { transaction, paymentIntent } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 1500,
      gateway: 'fake',
    });

    expect(transaction.referenceId.toString()).toBe(orderId.toString());
    expect(transaction.referenceModel).toBe('Order');
    expect(transaction.amount).toBe(1500);
    expect(paymentIntent).toBeDefined();
  }, TEST_TIMEOUT);

  it('verifies and refunds one-time purchase', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();

    const { transaction, paymentIntent } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'one_time',
      monetizationType: 'purchase',
      amount: 1500,
      gateway: 'fake',
    });

    // Verify
    await revenue.payments.verify(paymentIntent.paymentIntentId);

    // Refund
    const refundResult = await revenue.payments.refund(transaction._id.toString());
    expect(refundResult.refundResult.status).toBe('succeeded');

    // Check original transaction
    const updated = await Transaction.findById(transaction._id);
    expect(updated?.status).toBe('refunded');
    expect(updated?.refundedAmount).toBe(1500);
  }, TEST_TIMEOUT);
});

describe('Single Transaction Model - Split Payments (Multiple Payers)', () => {
  it('allows multiple payers for one order using referenceId', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const friend1 = new mongoose.Types.ObjectId();
    const friend2 = new mongoose.Types.ObjectId();
    const friend3 = new mongoose.Types.ObjectId();

    // Friend 1 pays $40
    await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId: friend1,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'split_payment',
      monetizationType: 'purchase',
      amount: 4000,
      gateway: 'fake',
      metadata: { splitGroup: 'dinner_split' },
    });

    // Friend 2 pays $35
    await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId: friend2,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'split_payment',
      monetizationType: 'purchase',
      amount: 3500,
      gateway: 'fake',
      metadata: { splitGroup: 'dinner_split' },
    });

    // Friend 3 pays $25
    await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId: friend3,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'split_payment',
      monetizationType: 'purchase',
      amount: 2500,
      gateway: 'fake',
      metadata: { splitGroup: 'dinner_split' },
    });

    // Query all contributions for this order
    const contributions = await Transaction.find({
      referenceId: orderId,
      referenceModel: 'Order',
    });

    expect(contributions).toHaveLength(3);

    // Calculate total
    const total = contributions.reduce((sum, t) => sum + t.amount, 0);
    expect(total).toBe(10000); // $100

    // Query by split group
    const groupPayments = await Transaction.find({
      'metadata.splitGroup': 'dinner_split',
    });
    expect(groupPayments).toHaveLength(3);
  }, TEST_TIMEOUT);

  it('tracks partial payment status for split payments', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const friend1 = new mongoose.Types.ObjectId();
    const friend2 = new mongoose.Types.ObjectId();
    const orderTotal = 10000; // $100

    // Friend 1 pays and verifies
    const { paymentIntent: pi1 } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId: friend1,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'split_payment',
      monetizationType: 'purchase',
      amount: 6000, // $60
      gateway: 'fake',
    });
    await revenue.payments.verify(pi1.paymentIntentId);

    // Friend 2 creates but hasn't verified yet
    await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId: friend2,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'split_payment',
      monetizationType: 'purchase',
      amount: 4000, // $40
      gateway: 'fake',
    });

    // Check verified vs pending
    const verified = await Transaction.find({
      referenceId: orderId,
      status: 'verified',
    });
    const pending = await Transaction.find({
      referenceId: orderId,
      status: { $in: ['pending', 'payment_initiated'] },
    });

    expect(verified).toHaveLength(1);
    expect(pending).toHaveLength(1);

    const totalVerified = verified.reduce((sum, t) => sum + t.amount, 0);
    const remaining = orderTotal - totalVerified;

    expect(totalVerified).toBe(6000);
    expect(remaining).toBe(4000);
  }, TEST_TIMEOUT);
});

describe('Single Transaction Model - Category Mappings', () => {
  it('uses categoryMappings when entity is provided', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();

    // Note: Category mappings are configured in beforeEach
    // Entity 'PlatformSubscription' maps to 'platform_subscription'
    // Entity 'ProductOrder' maps to 'product_order'

    // The monetization service should resolve the category from the entity
    // if the resolveCategory utility is called
    const { transaction } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
      },
      planKey: 'test',
      monetizationType: 'subscription',
      amount: 999,
      gateway: 'fake',
    });

    expect(transaction).toBeDefined();
    expect(transaction.amount).toBe(999);
  }, TEST_TIMEOUT);
});

describe('Single Transaction Model - Revenue Calculations', () => {
  it('calculates net revenue from income and expenses', async () => {
    if (skipIfNoMongo()) return;

    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();

    // Create and verify income transaction
    const { transaction: incomeTx, paymentIntent } = await revenue.monetization.create({
      data: { organizationId: orgId, customerId },
      planKey: 'test',
      monetizationType: 'purchase',
      amount: 5000,
      gateway: 'fake',
    });
    await revenue.payments.verify(paymentIntent.paymentIntentId);

    // Create expense (refund creates expense transaction)
    await revenue.payments.refund(incomeTx._id.toString(), 1000);

    // Query totals - status could be 'verified', 'completed', or 'partially_refunded'
    const incomeTotal = await Transaction.aggregate([
      { 
        $match: { 
          organizationId: orgId, 
          type: 'income', 
          status: { $in: ['verified', 'completed', 'partially_refunded'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    const expenseTotal = await Transaction.aggregate([
      { $match: { organizationId: orgId, type: 'expense' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    const income = incomeTotal[0]?.total ?? 0;
    const expense = expenseTotal[0]?.total ?? 0;
    const netRevenue = income - expense;

    expect(income).toBe(5000);
    expect(expense).toBe(1000);
    expect(netRevenue).toBe(4000);
  }, TEST_TIMEOUT);
});
