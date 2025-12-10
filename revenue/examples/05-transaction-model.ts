/**
 * Transaction Model - Complete Setup
 * @classytic/revenue
 *
 * ONE Transaction model = Universal Financial Ledger
 *
 * This is the ONLY required model. Use it for:
 * - Subscriptions (platform_subscription, course_enrollment)
 * - Purchases (product_order, one_time)
 * - Refunds (expense type)
 * - Operational expenses (rent, salary, utilities)
 *
 * The Subscription model is OPTIONAL (only if you need subscription state tracking)
 */

import mongoose, { Schema, Document } from 'mongoose';

// ============ IMPORT FROM LIBRARY ============
import {
  // Enums
  TRANSACTION_TYPE_VALUES,
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
 * Polymorphic Reference Models
 * Links transaction to any entity in your app
 */
export const REFERENCE_MODELS = {
  SUBSCRIPTION: 'Subscription',
  ORDER: 'Order',
  ENROLLMENT: 'Enrollment',
  MEMBERSHIP: 'Membership',
  INVOICE: 'Invoice',
} as const;

export const REFERENCE_MODEL_VALUES = Object.values(REFERENCE_MODELS);

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

export interface ITransaction extends Document {
  organizationId: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  handledBy?: mongoose.Types.ObjectId;
  type: 'income' | 'expense';
  category: string;
  status: string;
  amount: number;
  currency: string;
  method: string;
  gateway?: any;
  idempotencyKey?: string;
  webhook?: {
    eventId?: string;
    receivedAt?: Date;
    processedAt?: Date;
    payload?: any;
  };
  reference?: string;
  paymentDetails?: any;
  notes?: string;
  date: Date;
  verifiedAt?: Date;
  verifiedBy?: mongoose.Types.ObjectId | 'system';
  commission?: any;
  hold?: any;
  splits?: any[];
  referenceId?: mongoose.Types.ObjectId;
  referenceModel?: string;
  refundedAmount?: number;
  refundedAt?: Date;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

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
      enum: TRANSACTION_TYPE_VALUES, // ['income', 'expense']
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: TRANSACTION_CATEGORIES_VALUES,
      trim: true,
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

    // ============ POLYMORPHIC REFERENCE ============
    // Links transaction to any entity (Order, Subscription, Enrollment)
    referenceId: {
      type: Schema.Types.ObjectId,
      refPath: 'referenceModel',
      index: true,
    },
    referenceModel: {
      type: String,
      enum: REFERENCE_MODEL_VALUES,
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
transactionSchema.index({ category: 1, type: 1 });
transactionSchema.index({ 'gateway.paymentIntentId': 1 });
transactionSchema.index({ referenceModel: 1, referenceId: 1 });

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
    referenceId: subscriptionId,
    referenceModel: 'Subscription',
  },
  planKey: 'monthly',
  monetizationType: 'subscription',  // Stored in metadata
  entity: 'PlatformSubscription',     // Maps to 'platform_subscription' category
  amount: 2999,
  gateway: 'manual',
});

// Create one-time purchase
const { transaction: orderTx } = await revenue.monetization.create({
  data: {
    organizationId,
    customerId,
    referenceId: orderId,
    referenceModel: 'Order',
  },
  planKey: 'one_time',
  monetizationType: 'purchase',
  entity: 'ProductOrder',  // Maps to 'product_order' category
  amount: 1500,
  gateway: 'manual',
});

// Query by category
const subscriptionPayments = await Transaction.find({
  category: 'platform_subscription',
  status: 'verified',
});

// Query by reference
const orderPayments = await Transaction.find({
  referenceModel: 'Order',
  referenceId: orderId,
});

// Calculate revenue
const income = await Transaction.aggregate([
  { $match: { type: 'income', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const expenses = await Transaction.aggregate([
  { $match: { type: 'expense', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const netRevenue = (income[0]?.total ?? 0) - (expenses[0]?.total ?? 0);
*/
