/**
 * Settlement Schema
 * @classytic/revenue
 *
 * Mongoose schema for settlement/payout tracking
 */

import mongoose, { Schema } from 'mongoose';
import { SETTLEMENT_STATUS_VALUES, SETTLEMENT_TYPE_VALUES } from '../../enums/settlement.enums.js';
import { PAYOUT_METHOD_VALUES } from '../../enums/split.enums.js';

/**
 * Settlement Schema
 * Tracks payouts from platform to vendors/affiliates/partners
 *
 * Use in your Settlement model:
 * ```typescript
 * import mongoose from 'mongoose';
 * import { settlementSchema } from '@classytic/revenue/schemas';
 *
 * const Settlement = mongoose.model('Settlement', settlementSchema);
 * ```
 */
export const settlementSchema = new Schema({
  // ============ IDENTIFICATION ============

  organizationId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
    // The organization responsible for this payout
  },

  recipientId: {
    type: Schema.Types.ObjectId,
    required: true,
    index: true,
    // Who receives the payout (vendor, affiliate, partner)
  },

  recipientType: {
    type: String,
    enum: ['platform', 'organization', 'user', 'affiliate', 'partner'],
    required: true,
    // Type of recipient
  },

  // ============ CLASSIFICATION ============

  type: {
    type: String,
    enum: SETTLEMENT_TYPE_VALUES,
    required: true,
    // split_payout | platform_withdrawal | manual_payout | escrow_release
  },

  status: {
    type: String,
    enum: SETTLEMENT_STATUS_VALUES,
    default: 'pending',
    index: true,
    // pending | processing | completed | failed | cancelled
  },

  payoutMethod: {
    type: String,
    enum: PAYOUT_METHOD_VALUES,
    required: true,
    // bank_transfer | mobile_wallet | platform_balance | crypto | manual
  },

  // ============ AMOUNT ============

  amount: {
    type: Number,
    required: true,
    min: 0,
    // Amount in smallest currency unit (cents, paisa, etc.)
  },

  currency: {
    type: String,
    required: true,
    default: 'USD',
    // ISO 4217 currency code
  },

  // ============ SOURCE LINKAGE ============

  sourceTransactionIds: [{
    type: Schema.Types.ObjectId,
    ref: 'Transaction',
    // Transactions this settlement pays out from
  }],

  sourceSplitIds: [{
    type: String,
    // Split IDs within transactions (if applicable)
  }],

  // ============ BANK TRANSFER DETAILS ============

  bankTransferDetails: {
    accountNumber: { type: String },
    accountName: { type: String },
    bankName: { type: String },
    routingNumber: { type: String },
    swiftCode: { type: String },
    iban: { type: String },
    transferReference: { type: String }, // Bank confirmation reference
    transferredAt: { type: Date },
  },

  // ============ MOBILE WALLET DETAILS ============

  mobileWalletDetails: {
    provider: { type: String },      // bKash, Nagad, Rocket, etc.
    phoneNumber: { type: String },
    accountNumber: { type: String }, // Wallet account number
    transactionId: { type: String }, // Provider transaction ID
    transferredAt: { type: Date },
  },

  // ============ CRYPTO DETAILS ============

  cryptoDetails: {
    network: { type: String },      // Ethereum, Bitcoin, etc.
    walletAddress: { type: String },
    transactionHash: { type: String },
    transferredAt: { type: Date },
  },

  // ============ PLATFORM BALANCE ============

  platformBalanceDetails: {
    balanceId: { type: Schema.Types.ObjectId }, // Reference to balance record
    appliedAt: { type: Date },
  },

  // ============ DATES ============

  scheduledAt: {
    type: Date,
    index: true,
    // When this payout is scheduled for
  },

  processedAt: {
    type: Date,
    // When processing started
  },

  completedAt: {
    type: Date,
    // When successfully completed
  },

  failedAt: {
    type: Date,
    // When it failed
  },

  cancelledAt: {
    type: Date,
    // When it was cancelled
  },

  // ============ FAILURE INFO ============

  failureReason: {
    type: String,
    // Human-readable failure reason
  },

  failureCode: {
    type: String,
    // Machine-readable error code
  },

  retryCount: {
    type: Number,
    default: 0,
    min: 0,
    // Number of retry attempts
  },

  // ============ NOTES & METADATA ============

  notes: {
    type: String,
    // Admin notes about this settlement
  },

  metadata: {
    type: Schema.Types.Mixed,
    default: {},
    // Flexible metadata for app-specific data
  },
}, {
  timestamps: true, // Adds createdAt and updatedAt
});

// ============ INDEXES ============

// Query by organization and status
settlementSchema.index({ organizationId: 1, status: 1 });

// Query by recipient and status
settlementSchema.index({ recipientId: 1, status: 1 });

// Query scheduled settlements
settlementSchema.index({ type: 1, status: 1, scheduledAt: 1 });

// Query by source transaction
settlementSchema.index({ sourceTransactionIds: 1 });

// Query pending payouts by date
settlementSchema.index({ status: 1, scheduledAt: 1 });

// ============ TYPESCRIPT TYPE ============

export type SettlementDocument = mongoose.InferSchemaType<typeof settlementSchema> &
  mongoose.Document & {
    _id: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
  };

// ============ EXPORTS ============

export default settlementSchema;
