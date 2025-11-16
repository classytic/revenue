/**
 * Split Payment Schema
 * @classytic/revenue
 *
 * Schema for multi-party commission splits
 * Spread into transaction schema when needed
 */

import { SPLIT_TYPE, SPLIT_TYPE_VALUES, SPLIT_STATUS, SPLIT_STATUS_VALUES, PAYOUT_METHOD, PAYOUT_METHOD_VALUES } from '../../enums/split.enums.js';

export const splitItemSchema = {
  type: {
    type: String,
    enum: SPLIT_TYPE_VALUES,
    required: true,
  },

  recipientId: {
    type: String,
    required: true,
    index: true,
  },

  recipientType: {
    type: String,
    required: true,
  },

  rate: {
    type: Number,
    required: true,
    min: 0,
    max: 1,
  },

  grossAmount: {
    type: Number,
    required: true,
  },

  gatewayFeeRate: {
    type: Number,
    default: 0,
  },

  gatewayFeeAmount: {
    type: Number,
    default: 0,
  },

  netAmount: {
    type: Number,
    required: true,
  },

  status: {
    type: String,
    enum: SPLIT_STATUS_VALUES,
    default: SPLIT_STATUS.PENDING,
  },

  dueDate: Date,
  paidDate: Date,

  payoutMethod: {
    type: String,
    enum: PAYOUT_METHOD_VALUES,
    required: false,
  },

  payoutTransactionId: String,

  metadata: {
    type: Object,
    default: {},
  },
};

export const splitsSchema = {
  splits: {
    type: [splitItemSchema],
    default: [],
  },
};

export default splitsSchema;
