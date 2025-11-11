/**
 * SSLCommerz Schemas
 * @classytic/revenue
 *
 * Schemas for storing SSLCommerz payment data
 */

import { Schema } from 'mongoose';

/**
 * SSLCommerz Payment Details Schema
 * Store in Transaction model for reference
 * 
 * Usage:
 * const transactionSchema = new Schema({
 *   gateway: gatewaySchema,
 *   sslcommerz: sslcommerzPaymentSchema,  // ← Add this
 * });
 */
export const sslcommerzPaymentSchema = new Schema({
  // Transaction IDs
  tranId: {
    type: String,
    index: true,
  },
  
  valId: String,            // Validation ID
  bankTranId: String,       // Required for refunds
  
  // Card details (if card payment)
  cardType: String,         // 'VISA', 'MASTERCARD', 'AMEX'
  cardIssuer: String,       // 'BRAC Bank', 'City Bank', etc.
  cardBrand: String,        // 'VISA-Brac Bank'
  cardSubBrand: String,
  cardNumber: String,       // Masked: 411111XXXXXX1111
  
  // Bank/Mobile wallet details
  bankGateway: String,      // 'bKash', 'nagad', 'rocket'
  
  // Transaction status
  status: String,           // 'VALID', 'VALIDATED', 'FAILED'
  riskLevel: String,        // '0' (safe), '1' (risky)
  riskTitle: String,
  
  // Amounts
  amount: Number,
  storeAmount: Number,      // Amount after SSLCommerz fee
  currencyType: String,
  currencyAmount: Number,
  currencyRate: Number,
  
  // Timestamps
  tranDate: Date,
  
  // Metadata
  metadata: Schema.Types.Mixed,
}, { _id: false });

/**
 * SSLCommerz Customer Schema
 * Optional: Store customer payment preferences
 * 
 * Usage in Customer model:
 * const customerSchema = new Schema({
 *   name: String,
 *   sslcommerz: sslcommerzCustomerSchema,  // ← Add this
 * });
 */
export const sslcommerzCustomerSchema = new Schema({
  // Preferred payment method
  preferredMethod: {
    type: String,
    enum: ['bkash', 'nagad', 'rocket', 'card', 'bank'],
  },
  
  // Saved details (for reference, not for auto-payment)
  savedMethods: [{
    type: String,     // 'bkash', 'card'
    label: String,    // 'My bKash', 'Visa ending in 1111'
    isDefault: Boolean,
  }],
  
  // Transaction history count
  totalTransactions: {
    type: Number,
    default: 0,
  },
  
  lastTransactionDate: Date,
  
  // Metadata
  metadata: Schema.Types.Mixed,
}, { _id: false });

export default {
  sslcommerzPaymentSchema,
  sslcommerzCustomerSchema,
};

