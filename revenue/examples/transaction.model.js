/**
 * Transaction Model Example
 * @classytic/revenue
 *
 * Shows how to merge library schemas/enums with your own
 */

import mongoose from 'mongoose';
import {
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS_VALUES,
  LIBRARY_CATEGORY_VALUES,
} from '@classytic/revenue/enums';
import {
  gatewaySchema,
  currentPaymentSchema,
  paymentDetailsSchema,
} from '@classytic/revenue/schemas';

// ============ YOUR CATEGORIES ============
// Merge library categories with your own
const MY_CATEGORIES = {
  SUBSCRIPTION: 'subscription',  // From library
  PURCHASE: 'purchase',          // From library
  SALARY: 'salary',              // Your own
  RENT: 'rent',                  // Your own
  EQUIPMENT: 'equipment',        // Your own
  // Add as many as you need...
};

const MY_CATEGORY_VALUES = Object.values(MY_CATEGORIES);

// ============ YOUR PAYMENT METHODS ============
// Define payment methods your business accepts
const MY_PAYMENT_METHODS = {
  BKASH: 'bkash',        // Bangladesh
  NAGAD: 'nagad',        // Bangladesh
  ROCKET: 'rocket',      // Bangladesh
  CARD: 'card',          // Credit/debit cards
  BANK: 'bank',          // Bank transfer
  CASH: 'cash',          // Cash payment
  // Add country-specific methods as needed
};

const MY_PAYMENT_METHOD_VALUES = Object.values(MY_PAYMENT_METHODS);

// ============ TRANSACTION SCHEMA ============
const transactionSchema = new mongoose.Schema({
  // ============ REQUIRED BY LIBRARY ============
  amount: { type: Number, required: true, min: 0 },
  type: { type: String, enum: TRANSACTION_TYPE_VALUES, required: true, index: true },  // 'income' | 'expense'
  method: { type: String, enum: MY_PAYMENT_METHOD_VALUES, required: true },  // Payment method
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, default: 'pending', required: true, index: true },
  category: { type: String, enum: MY_CATEGORY_VALUES, required: true, index: true },
  
  // ============ MULTI-TENANT (optional) ============
  organizationId: { type: String, index: true },  // Only for multi-tenant platforms

  // Spread library schemas
  gateway: gatewaySchema,
  currentPayment: currentPaymentSchema,
  paymentDetails: paymentDetailsSchema,

  // ============ POLYMORPHIC REFERENCE ============
  // Links transaction to any entity (Order, Subscription, Enrollment, etc.)
  // Library automatically populates these if provided in data param
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceModel',
    index: true,
  },
  referenceModel: {
    type: String,
    enum: ['Subscription', 'Order', 'Enrollment', 'Membership'], // Your models
    index: true,
  },

  // Optional but recommended
  customerId: String,
  currency: { type: String, default: 'BDT' },
  verifiedAt: Date,
  verifiedBy: mongoose.Schema.Types.ObjectId,

  // Idempotency
  idempotencyKey: { type: String, unique: true, sparse: true },

  // Your custom fields
  notes: String,
  invoiceNumber: String,
}, { timestamps: true });

// Indexes
transactionSchema.index({ organizationId: 1, status: 1 });
transactionSchema.index({ organizationId: 1, type: 1 });  // For income/expense queries
transactionSchema.index({ customerId: 1 });
transactionSchema.index({ referenceModel: 1, referenceId: 1 });  // For polymorphic queries
transactionSchema.index({ 'gateway.paymentIntentId': 1 });

export default mongoose.model('Transaction', transactionSchema);
