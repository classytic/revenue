/**
 * Tax Correctness Integration Tests
 * @classytic/revenue
 *
 * Tests tax behavior across all financial operations:
 * - Tax persistence after plugin injection
 * - Tax reversal on partial/full refunds
 * - Tax handling in escrow release
 * - Tax distribution in commission splits
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, type Model, type Document } from 'mongoose';
import { Revenue } from '../../revenue/src/core/revenue.js';
import { createTaxPlugin } from '../../revenue/src/infrastructure/plugins/business/tax.plugin.js';
import ManualProvider from '../../revenue-manual/src/index.js';
import { connectToMongoDB, disconnectFromMongoDB, dropDatabase } from '../helpers/mongodb-memory.js';

// ============ MONGOOSE SCHEMAS ============
interface ITransaction extends Document {
  organizationId?: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  sourceId?: mongoose.Types.ObjectId;
  sourceModel?: string;
  sourceId?: mongoose.Types.ObjectId;
  sourceModel?: string;
  category?: string;
  type: string;
  flow?: 'inflow' | 'outflow';
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
  };
  commission?: Record<string, unknown>;
  tax?: Record<string, unknown>;
  hold?: Record<string, unknown>;
  refundedAmount?: number;
  verifiedAt?: Date;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

interface ISubscription extends Document {
  customerId?: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  planKey?: string;
  status: string;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    organizationId: Schema.Types.Mixed, // Can be string or ObjectId
    customerId: Schema.Types.Mixed, // Can be string or ObjectId
    sourceId: Schema.Types.Mixed, // Can be string or ObjectId
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
    hold: Schema.Types.Mixed,
    refundedAmount: Number,
    verifiedAt: Date,
    metadata: Schema.Types.Mixed,
    idempotencyKey: String,
  },
  { timestamps: true, strict: false }
);

const SubscriptionSchema = new Schema<ISubscription>(
  {
    customerId: Schema.Types.Mixed, // Can be string or ObjectId
    organizationId: Schema.Types.Mixed, // Can be string or ObjectId
    planKey: String,
    status: { type: String, default: 'pending' },
  },
  { timestamps: true, strict: false }
);

describe('Tax Correctness Integration', () => {
  let Transaction: Model<ITransaction>;
  let Subscription: Model<ISubscription>;
  let revenue: ReturnType<typeof Revenue.create> extends { build(): infer R } ? R : never;
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
  }, 30000); // Increase timeout for MongoDB Memory Server

  afterAll(async () => {
    await disconnectFromMongoDB();
  });

  beforeEach(async () => {
    if (!mongoAvailable) return;

    // Clear collections
    await dropDatabase();

    // Build revenue instance with tax plugin
    revenue = Revenue.create({ defaultCurrency: 'USD' })
      .withModels({ Transaction, Subscription })
      .withProvider('manual', new ManualProvider())
      .withPlugin(
        createTaxPlugin({
          getTaxConfig: async (orgId) => ({
            isRegistered: true,
            defaultRate: 0.15, // 15% tax
            pricesIncludeTax: false,
            exemptCategories: ['education', 'medical'],
          }),
          categoryMappings: {
            Order: 'order_subscription',
            Course: 'education', // Exempt category
          },
          incomeCategories: ['subscription', 'purchase', 'order_subscription'],
        })
      )
      .build();
  });

  describe('Tax Persistence', () => {
    it('should persist tax calculated by plugin to transaction document', async () => {
      if (!mongoAvailable) return;

      const result = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000, // $100
        currency: 'USD',
        gateway: 'manual',
        entity: 'Order',
        monetizationType: 'subscription',
      });

      const transaction = result.transaction!;

      // Tax should be persisted (UNIFIED STRUCTURE)
      expect(transaction.tax).toBeDefined();
      expect(transaction.tax).toBe(1500); // ✅ Now a number (15% of $100)
      expect(transaction.taxDetails?.type).toBe('sales_tax'); // ✅ Changed from 'collected'
      expect(transaction.taxDetails?.rate).toBe(0.15);
      expect(transaction.taxDetails?.isInclusive).toBe(false); // ✅ Changed from pricesIncludeTax

      // Net should be calculated correctly: amount - fee - tax
      expect(transaction.net).toBe(10000 - (transaction.fee || 0) - 1500);

      // Verify it's actually saved in database
      const savedTransaction = await Transaction.findById(transaction._id);
      expect(savedTransaction?.tax).toBeDefined();
      expect(savedTransaction?.tax).toBe(1500); // ✅ Number, not object
    });

    it('should handle exempt categories correctly', async () => {
      if (!mongoAvailable) return;

      const result = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'course-monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        entity: 'Course', // Maps to 'education' - exempt category
        monetizationType: 'subscription',
      });

      const transaction = result.transaction!;

      // Tax should be exempt (UNIFIED STRUCTURE)
      expect(transaction.tax).toBe(0); // ✅ 0 for exempt
      expect(transaction.taxDetails?.type).toBe('none'); // ✅ Changed from 'exempt'
      // No tax, so net = amount - fee
      expect(transaction.net).toBe(10000 - (transaction.fee || 0));
    });

    it('should handle prices including tax', async () => {
      if (!mongoAvailable) return;

      // Override tax config to include tax in prices
      const customRevenue = Revenue.create({ defaultCurrency: 'USD' })
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new ManualProvider())
        .withPlugin(
          createTaxPlugin({
            getTaxConfig: async () => ({
              isRegistered: true,
              defaultRate: 0.15,
              pricesIncludeTax: true, // Tax included in price
              exemptCategories: [],
            }),
          })
        )
        .build();

      const result = await customRevenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 11500, // $115 including tax
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      const transaction = result.transaction!;

      // Tax should be extracted from total (UNIFIED STRUCTURE)
      expect(transaction.tax).toBe(1500); // ✅ Tax amount (11500 - 10000)
      expect(transaction.taxDetails?.isInclusive).toBe(true); // ✅ Changed from pricesIncludeTax
      expect(transaction.amount).toBe(10000); // ✅ Base amount (11500 / 1.15)
      // When tax is inclusive, amount is the base (pre-tax) amount
    });
  });

  describe('Tax Reversal on Refunds', () => {
    it('should reverse tax proportionally on partial refund', async () => {
      if (!mongoAvailable) return;

      // Create transaction with tax
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      const originalTransaction = createResult.transaction!;
      expect(originalTransaction.tax).toBe(1500); // ✅ Number

      // Verify payment first
      await revenue.payments.verify(originalTransaction._id.toString());

      // Partial refund (50%)
      const refundResult = await revenue.payments.refund(
        originalTransaction._id.toString(),
        5000, // Refund $50 (50% of base amount)
        {
          reason: 'Customer request',
        }
      );

      const refundTransaction = refundResult.refundTransaction;

      // Refund transaction should have proportional tax reversal (UNIFIED STRUCTURE)
      expect(refundTransaction.tax).toBeDefined();
      expect(refundTransaction.tax).toBe(750); // ✅ 50% of 1500 (positive value, number)
      expect(refundTransaction.amount).toBe(5000); // ✅ Refund amount
      expect(refundTransaction.net).toBe(5000 - (refundTransaction.fee || 0) - 750); // ✅ Net calculation

      // Original transaction should be updated
      const updatedOriginal = await Transaction.findById(originalTransaction._id);
      expect(updatedOriginal?.status).toBe('partially_refunded');
    });

    it('should reverse tax completely on full refund', async () => {
      if (!mongoAvailable) return;

      // Create transaction with tax
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      const originalTransaction = createResult.transaction!;

      // Verify payment
      await revenue.payments.verify(originalTransaction._id.toString());

      // Full refund
      const refundResult = await revenue.payments.refund(
        originalTransaction._id.toString(),
        null, // Full refund (no amount specified)
        {
          reason: 'Full refund',
        }
      );

      const refundTransaction = refundResult.refundTransaction;

      // Refund transaction should reverse all tax (UNIFIED STRUCTURE)
      expect(refundTransaction.tax).toBe(1500); // ✅ Full reversal (positive value, number)
      expect(refundTransaction.amount).toBe(10000); // ✅ Full refund amount

      // Original transaction should be marked refunded
      const updatedOriginal = await Transaction.findById(originalTransaction._id);
      expect(updatedOriginal?.status).toBe('refunded');
    });
  });

  describe('Tax Handling in Escrow Operations', () => {
    it('should include tax when holding funds in escrow', async () => {
      if (!mongoAvailable) return;

      // Create transaction with tax
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      const transaction = createResult.transaction!;
      // Calculate total: amount (base) + tax (not using totalAmount anymore)
      const totalWithTax = transaction.amount + (transaction.tax || 0); // ✅ 10000 + 1500 = 11500

      // Verify payment
      await revenue.payments.verify(transaction._id.toString());

      // Hold in escrow
      await revenue.escrow.hold(transaction._id.toString(), {
        reason: 'Pending instructor approval',
      });

      const heldTransaction = await Transaction.findById(transaction._id);

      // Escrow should hold the full amount (UNIFIED STRUCTURE)
      expect(heldTransaction?.hold).toBeDefined();
      expect(heldTransaction?.hold?.status).toBe('held');
      expect(heldTransaction?.hold?.heldAmount).toBe(transaction.amount); // ✅ Holds base amount (10000)

      // Tax information should be preserved
      expect(heldTransaction?.tax).toBe(1500); // ✅ Number
    });

    it('should preserve tax when releasing from escrow', async () => {
      if (!mongoAvailable) return;

      // Create, verify, and hold
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      const transaction = createResult.transaction!;
      await revenue.payments.verify(transaction._id.toString());
      await revenue.escrow.hold(transaction._id.toString());

      // Release to instructor
      const releaseResult = await revenue.escrow.release(
        transaction._id.toString(),
        {
          recipientId: 'instructor_123',
          recipientType: 'user',
          reason: 'Course completed',
        }
      );

      // Release transaction should preserve tax information (UNIFIED STRUCTURE)
      const releaseTransaction = releaseResult.releaseTransaction;
      expect(releaseTransaction).toBeDefined();
      expect(releaseTransaction?.tax).toBeDefined();
      expect(releaseTransaction?.tax).toBe(1500); // ✅ Number

      // Original transaction should be updated
      const updatedOriginal = await Transaction.findById(transaction._id);
      expect(updatedOriginal?.hold?.status).toBe('released');
    });

    it('should handle partial escrow release with tax', async () => {
      if (!mongoAvailable) return;

      // Create, verify, and hold
      const createResult = await revenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      const transaction = createResult.transaction!;
      await revenue.payments.verify(transaction._id.toString());
      await revenue.escrow.hold(transaction._id.toString());

      // Partial release (50%)
      const releaseResult = await revenue.escrow.release(
        transaction._id.toString(),
        {
          amount: 5750, // 50% of total with tax (5000 + 750)
          recipientId: 'instructor_123',
          recipientType: 'user',
          reason: 'Partial milestone completed',
        }
      );

      const releaseTransaction = releaseResult.releaseTransaction;

      // Release should have proportional tax (UNIFIED STRUCTURE)
      expect(releaseTransaction?.amount).toBe(5750); // ✅ Release amount (includes base + tax calculation)
      expect(releaseTransaction?.tax).toBe(750); // ✅ 50% of 1500 (number)

      // Original should still be partially held
      const updatedOriginal = await Transaction.findById(transaction._id);
      expect(updatedOriginal?.hold?.status).toBe('partially_released');
    });
  });

  describe('Tax Edge Cases', () => {
    it('should handle tax when organization is not registered', async () => {
      if (!mongoAvailable) return;

      const customRevenue = Revenue.create({ defaultCurrency: 'USD' })
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new ManualProvider())
        .withPlugin(
          createTaxPlugin({
            getTaxConfig: async () => ({
              isRegistered: false, // Not tax registered
              defaultRate: 0,
              pricesIncludeTax: false,
              exemptCategories: [],
            }),
          })
        )
        .build();

      const result = await customRevenue.monetization.create({
        data: { organizationId: 'org_456', customerId: 'cust_789' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      const transaction = result.transaction!;

      // Tax should not be applicable (UNIFIED STRUCTURE)
      expect(transaction.tax).toBe(0); // ✅ No tax (number)
      expect(transaction.amount).toBe(10000); // ✅ Base amount unchanged
    });

    it('should gracefully handle tax calculation failure', async () => {
      if (!mongoAvailable) return;

      const customRevenue = Revenue.create({ defaultCurrency: 'USD' })
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new ManualProvider())
        .withPlugin(
          createTaxPlugin({
            getTaxConfig: async () => {
              throw new Error('Tax service unavailable');
            },
          })
        )
        .build();

      // Transaction should still be created even if tax calc fails
      const result = await customRevenue.monetization.create({
        data: { organizationId: 'org_123', customerId: 'cust_456' },
        planKey: 'monthly',
        amount: 10000,
        currency: 'USD',
        gateway: 'manual',
        monetizationType: 'subscription',
      });

      // Transaction should exist
      expect(result.transaction).toBeDefined();

      // Tax may not be calculated but transaction succeeds
      // (Tax plugin catches errors and logs them)
    });
  });
});
