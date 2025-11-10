/**
 * Gateway and Commission Schemas
 * @classytic/revenue
 *
 * Schemas for payment gateway and commission tracking
 */

import { Schema } from 'mongoose';
import { PAYMENT_GATEWAY_TYPE_VALUES } from '../../enums/index.js';

/**
 * Gateway Schema
 * For payment gateway integration details
 */
export const gatewaySchema = new Schema({
  type: {
    type: String,
    enum: PAYMENT_GATEWAY_TYPE_VALUES,
    default: 'manual'
  },
  paymentIntentId: { type: String },
  sessionId: { type: String },
  paymentUrl: { type: String },
  expiresAt: { type: Date },
  metadata: { type: Schema.Types.Mixed },
}, { _id: false });

/**
 * Commission Schema
 * Commission tracking for marketplace transactions
 */
export const commissionSchema = new Schema({
  rate: {
    type: Number,
    min: 0,
    max: 1
  },
  grossAmount: {
    type: Number,
    min: 0
  },
  gatewayFeeRate: {
    type: Number,
    min: 0,
    max: 1
  },
  gatewayFeeAmount: {
    type: Number,
    min: 0
  },
  netAmount: {
    type: Number,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'due', 'paid', 'waived'],
    default: 'pending'
  },
  dueDate: { type: Date },
  paidDate: { type: Date },
  paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
  notes: { type: String },
}, { _id: false });

export default {
  gatewaySchema,
  commissionSchema,
};
