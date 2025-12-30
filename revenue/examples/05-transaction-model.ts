/**
 * Transaction Model - Complete Setup
 * @classytic/revenue
 *
 * ONE Transaction model = Universal Financial Ledger
 *
 * This is the ONLY required model. Use it for:
 * - Subscriptions (platform_subscription, course_enrollment)
 * - Purchases (product_order, one_time)
 * - Refunds (outflow)
 * - Operational expenses (rent, salary, utilities)
 *
 * The Subscription model is OPTIONAL (only if you need subscription state tracking)
 */

import mongoose, { Schema } from 'mongoose';
import type { ITransaction } from '@classytic/shared-types';

// ============ IMPORT FROM LIBRARY ============
import {
  // Enums
  TRANSACTION_FLOW_VALUES,
  TRANSACTION_STATUS_VALUES,
  // Mongoose Schemas (compose into your model)
  gatewaySchema,
  paymentDetailsSchema,
  commissionSchema,
  holdSchema,
  splitSchema,
} from '@classytic/revenue';

// ============ YOUR APP ENUMS ============

/**
 * Transaction Categories
 * Define YOUR business-specific categories
 */
export const TRANSACTION_CATEGORIES = {
  // Revenue categories (managed via library)
  PLATFORM_SUBSCRIPTION: 'platform_subscription',
  COURSE_ENROLLMENT: 'course_enrollment',
  PRODUCT_ORDER: 'product_order',
  GYM_MEMBERSHIP: 'gym_membership',
  REFUND: 'refund',

  // Operational categories (manual)
  CAPITAL_INJECTION: 'capital_injection',
  RENT: 'rent',
  UTILITIES: 'utilities',
  SALARY: 'salary',
  EQUIPMENT: 'equipment',
  MARKETING: 'marketing',
  OTHER_INCOME: 'other_income',
  OTHER_EXPENSE: 'other_expense',
} as const;

export const TRANSACTION_CATEGORIES_VALUES = Object.values(TRANSACTION_CATEGORIES);

/**
 * Polymorphic Source Models
 * Links transaction to any entity in your app
 */
export const SOURCE_MODELS = {
  SUBSCRIPTION: 'Subscription',
  ORDER: 'Order',
  ENROLLMENT: 'Enrollment',
  MEMBERSHIP: 'Membership',
  INVOICE: 'Invoice',
} as const;

export const SOURCE_MODEL_VALUES = Object.values(SOURCE_MODELS);

/**
 * Payment Methods (your app-specific)
 */
export const PAYMENT_METHODS = {
  CARD: 'card',
  BKASH: 'bkash',
  NAGAD: 'nagad',
  BANK_TRANSFER: 'bank_transfer',
  CASH: 'cash',
  MANUAL: 'manual',
} as const;

export const PAYMENT_METHOD_VALUES = Object.values(PAYMENT_METHODS);

// ============ INTERFACE ============

// ============ SCHEMA ============

const transactionSchema = new Schema<ITransaction>(
  {
    // ============ REQUIRED CORE FIELDS ============
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'Customer',
      index: true,
    },
    handledBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    type: {
      type: String,
      enum: TRANSACTION_CATEGORIES_VALUES, // category (e.g. subscription, refund)
      required: true,
      index: true,
    },
    flow: {
      type: String,
      enum: TRANSACTION_FLOW_VALUES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: TRANSACTION_STATUS_VALUES,
      default: 'pending',
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'BDT',
      uppercase: true,
    },
    method: {
      type: String,
      enum: PAYMENT_METHOD_VALUES,
      required: true,
    },

    // ============ LIBRARY SCHEMAS ============
    // Payment gateway integration
    gateway: gatewaySchema,

    // Platform commission tracking
    commission: commissionSchema,

    // Payment details (wallet/bank info)
    paymentDetails: paymentDetailsSchema,

    // Escrow hold (for marketplaces)
    hold: holdSchema,

    // Multi-party splits (for affiliates, partners)
    splits: [splitSchema],

    // ============ IDEMPOTENCY ============
    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    // ============ WEBHOOK TRACKING ============
    webhook: {
      eventId: { type: String },
      receivedAt: { type: Date },
      processedAt: { type: Date },
      payload: { type: Schema.Types.Mixed },
    },

    // ============ PAYMENT REFERENCE ============
    reference: { type: String }, // Customer-provided (bKash trxId, etc.)
    notes: { type: String },
    date: { type: Date, default: () => new Date() },

    // ============ VERIFICATION ============
    verifiedAt: { type: Date },
    verifiedBy: {
      type: Schema.Types.Mixed,
      validate: {
        validator: function (value: unknown) {
          if (!value) return true;
          if (value === 'system') return true;
          if (mongoose.Types.ObjectId.isValid(value as string)) return true;
          return false;
        },
        message: 'verifiedBy must be ObjectId, "system", or null',
      },
    },

    // ============ REFUND TRACKING ============
    refundedAmount: { type: Number },
    refundedAt: { type: Date },

    // ============ POLYMORPHIC SOURCE ============
    // Links transaction to any entity (Order, Subscription, Enrollment)
    sourceId: {
      type: Schema.Types.ObjectId,
      refPath: 'sourceModel',
      index: true,
    },
    sourceModel: {
      type: String,
      enum: SOURCE_MODEL_VALUES,
    },

    // ============ METADATA ============
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ============ INDEXES ============
transactionSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
transactionSchema.index({ customerId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ type: 1, flow: 1 });
transactionSchema.index({ 'gateway.paymentIntentId': 1 });
transactionSchema.index({ sourceModel: 1, sourceId: 1 });

// ============ VIRTUALS ============
transactionSchema.virtual('isRefundable').get(function () {
  return ['verified', 'completed'].includes(this.status);
});

transactionSchema.virtual('remainingAmount').get(function () {
  return this.amount - (this.refundedAmount ?? 0);
});

// ============ EXPORT ============
export const Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);

// ============ USAGE EXAMPLE ============
/*
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import { Transaction } from './models/transaction';

const revenue = Revenue
  .create({ defaultCurrency: 'BDT' })
  .withModels({ Transaction })  // Only Transaction is required!
  .withProvider('manual', new ManualProvider())
  .withCommission(10, 2.9)
  .withCategoryMappings({
    // Entity → Category mapping
    PlatformSubscription: 'platform_subscription',
    CourseEnrollment: 'course_enrollment',
    ProductOrder: 'product_order',
    GymMembership: 'gym_membership',
  })
  .build();

// Create subscription payment
const { transaction } = await revenue.monetization.create({
  data: {
    organizationId,
    customerId,
    sourceId: subscriptionId,
    sourceModel: 'Subscription',
  },
  planKey: 'monthly',
  monetizationType: 'subscription',  // Stored in metadata
  entity: 'PlatformSubscription',     // Maps to 'platform_subscription' type
  amount: 2999,
  gateway: 'manual',
});

// Create one-time purchase
const { transaction: orderTx } = await revenue.monetization.create({
  data: {
    organizationId,
    customerId,
    sourceId: orderId,
    sourceModel: 'Order',
  },
  planKey: 'one_time',
  monetizationType: 'purchase',
  entity: 'ProductOrder',  // Maps to 'product_order' type
  amount: 1500,
  gateway: 'manual',
});

// Query by type (category)
const subscriptionPayments = await Transaction.find({
  type: 'platform_subscription',
  status: 'verified',
});

// Query by source
const orderPayments = await Transaction.find({
  sourceModel: 'Order',
  sourceId: orderId,
});

// Calculate revenue
const income = await Transaction.aggregate([
  { $match: { flow: 'inflow', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const expenses = await Transaction.aggregate([
  { $match: { flow: 'outflow', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const netRevenue = (income[0]?.total ?? 0) - (expenses[0]?.total ?? 0);
*/
