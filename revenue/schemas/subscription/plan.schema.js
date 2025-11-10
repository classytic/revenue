/**
 * Subscription Plan Schema
 * @classytic/revenue
 *
 * Schema for subscription plan definitions
 */

import { Schema } from 'mongoose';
import { PLAN_KEY_VALUES } from '../../enums/index.js';

/**
 * Subscription Plan Schema
 * Embedded in subscription info
 */
export const subscriptionPlanSchema = new Schema({
  key: {
    type: String,
    required: true,
    enum: PLAN_KEY_VALUES,
  },
  label: {
    type: String,
    required: true,
  },
  duration: {
    type: Number,
    required: true,
    min: 1,
  },
  durationUnit: {
    type: String,
    default: 'days',
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  discount: {
    type: Number,
    default: 0,
    min: 0,
  },
}, { _id: false });

export default {
  subscriptionPlanSchema,
};
