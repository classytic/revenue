/**
 * Transaction Model Example
 * @classytic/revenue
 *
 * Shows how to merge library schemas/enums with your own
 */

import mongoose from 'mongoose';
import {
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
  // Required by library
  organizationId: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, default: 'pending', required: true, index: true },
  category: { type: String, enum: MY_CATEGORY_VALUES, required: true, index: true },

  // Spread library schemas
  gateway: gatewaySchema,
  currentPayment: currentPaymentSchema,
  paymentDetails: paymentDetailsSchema,

  // Optional but recommended
  customerId: String,
  currency: { type: String, default: 'BDT' },
  method: { type: String, enum: MY_PAYMENT_METHOD_VALUES },  // Your payment methods
  verifiedAt: Date,
  verifiedBy: mongoose.Schema.Types.ObjectId,

  // Reference tracking (for subscriptions/purchases)
  referenceModel: String,
  referenceId: mongoose.Schema.Types.ObjectId,

  // Idempotency
  idempotencyKey: { type: String, unique: true, sparse: true },

  // Your custom fields
  notes: String,
  invoiceNumber: String,
}, { timestamps: true });

// Indexes
transactionSchema.index({ organizationId: 1, status: 1 });
transactionSchema.index({ customerId: 1 });
transactionSchema.index({ referenceModel: 1, referenceId: 1 });
transactionSchema.index({ 'gateway.paymentIntentId': 1 });

export default mongoose.model('Transaction', transactionSchema);
