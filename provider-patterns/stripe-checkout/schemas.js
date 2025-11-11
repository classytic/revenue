/**
 * Stripe Checkout Schemas
 * @classytic/revenue
 *
 * Mongoose schemas for storing Stripe-related data
 * Add these to your Customer/User models
 */

import { Schema } from 'mongoose';

/**
 * Stripe Customer Schema
 * Store in your Customer or User model
 * 
 * Usage:
 * import { stripeCustomerSchema } from './schemas/stripe.js';
 * 
 * const customerSchema = new Schema({
 *   name: String,
 *   email: String,
 *   stripe: stripeCustomerSchema,  // ← Add this
 * });
 */
export const stripeCustomerSchema = new Schema({
  // Stripe customer ID
  customerId: {
    type: String,
    index: true,
    sparse: true,
  },
  
  // Payment methods
  paymentMethods: [{
    id: String,
    type: String, // 'card', 'bank_account', 'sepa_debit'
    
    // Card details (if type is 'card')
    card: {
      brand: String,        // 'visa', 'mastercard', 'amex'
      last4: String,        // Last 4 digits
      expMonth: Number,
      expYear: Number,
      country: String,
    },
    
    // Bank details (if type is 'bank_account')
    bankAccount: {
      bankName: String,
      last4: String,
      routingNumber: String,
    },
    
    isDefault: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  }],
  
  // Default payment method
  defaultPaymentMethodId: String,
  
  // Billing details
  billingAddress: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    postalCode: String,
    country: String,
  },
  
  // Customer metadata
  metadata: Schema.Types.Mixed,
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { _id: false });

/**
 * Stripe Subscription Schema
 * Store in your Subscription model (if using recurring payments)
 * 
 * Usage:
 * const subscriptionSchema = new Schema({
 *   planKey: String,
 *   status: String,
 *   stripe: stripeSubscriptionSchema,  // ← Add this
 * });
 */
export const stripeSubscriptionSchema = new Schema({
  // Stripe subscription ID
  subscriptionId: {
    type: String,
    index: true,
    sparse: true,
  },
  
  // Stripe price ID
  priceId: String,
  
  // Stripe product ID
  productId: String,
  
  // Current period
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  
  // Cancel details
  cancelAt: Date,
  canceledAt: Date,
  cancelAtPeriodEnd: { type: Boolean, default: false },
  
  // Trial
  trialStart: Date,
  trialEnd: Date,
  
  // Metadata
  metadata: Schema.Types.Mixed,
}, { _id: false });

/**
 * Stripe Checkout Session Schema
 * Store temporarily for tracking checkout sessions
 * 
 * Usage in Transaction model:
 * const transactionSchema = new Schema({
 *   amount: Number,
 *   gateway: gatewaySchema,
 *   stripeSession: stripeCheckoutSessionSchema,  // ← Add this
 * });
 */
export const stripeCheckoutSessionSchema = new Schema({
  sessionId: String,
  sessionUrl: String,
  expiresAt: Date,
  paymentIntentId: String,
  customerId: String,
  status: {
    type: String,
    enum: ['open', 'complete', 'expired'],
    default: 'open',
  },
}, { _id: false });

export default {
  stripeCustomerSchema,
  stripeSubscriptionSchema,
  stripeCheckoutSessionSchema,
};

