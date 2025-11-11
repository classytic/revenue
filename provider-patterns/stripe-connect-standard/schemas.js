/**
 * Stripe Connect Schemas
 * @classytic/revenue
 *
 * Schemas for storing Stripe Connect account data
 * Add to your Organization/Vendor models
 */

import { Schema } from 'mongoose';

/**
 * Stripe Connect Account Schema
 * Store in Organization/Vendor model
 * 
 * Usage:
 * const organizationSchema = new Schema({
 *   name: String,
 *   stripeConnect: stripeConnectAccountSchema,  // ← Add this
 * });
 */
export const stripeConnectAccountSchema = new Schema({
  // Stripe Connect account ID
  accountId: {
    type: String,
    required: true,
    index: true,
    unique: true,
    sparse: true,
  },
  
  // Account type
  accountType: {
    type: String,
    enum: ['standard', 'express', 'custom'],
    default: 'standard',
  },
  
  // Account status
  chargesEnabled: {
    type: Boolean,
    default: false,
  },
  
  payoutsEnabled: {
    type: Boolean,
    default: false,
  },
  
  detailsSubmitted: {
    type: Boolean,
    default: false,
  },
  
  // Onboarding
  onboardingUrl: String,
  dashboardUrl: String,
  
  // Connection status
  connected: {
    type: Boolean,
    default: false,
  },
  
  connectedAt: Date,
  disconnectedAt: Date,
  
  // Business details
  businessProfile: {
    name: String,
    url: String,
    supportEmail: String,
    supportPhone: String,
  },
  
  // Capabilities status
  capabilities: {
    cardPayments: String,     // 'active', 'inactive', 'pending'
    transfers: String,
    legacyPayments: String,
  },
  
  // Requirements (if any)
  requiresAction: {
    type: Boolean,
    default: false,
  },
  
  requirementsDeadline: Date,
  
  // Metadata
  metadata: Schema.Types.Mixed,
  
  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { _id: false });

/**
 * Stripe Connect Payout Schema
 * Optional: Track payouts to vendors
 * 
 * Usage in separate Payout model:
 * const payoutSchema = new Schema({
 *   organizationId: ObjectId,
 *   stripePayout: stripeConnectPayoutSchema,
 * });
 */
export const stripeConnectPayoutSchema = new Schema({
  payoutId: String,
  amount: Number,
  currency: String,
  status: {
    type: String,
    enum: ['pending', 'in_transit', 'paid', 'failed', 'canceled'],
  },
  arrivalDate: Date,
  method: String, // 'standard', 'instant'
  bankAccount: {
    bankName: String,
    last4: String,
    country: String,
  },
}, { _id: false });

export default {
  stripeConnectAccountSchema,
  stripeConnectPayoutSchema,
};

