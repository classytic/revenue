/**
 * Subscription Info Schema
 * @classytic/revenue
 *
 * Complete subscription information schema
 */

import { Schema } from 'mongoose';
import { subscriptionPlanSchema } from './plan.schema.js';

/**
 * Subscription Info Schema
 * Use this in your model: subscription: { type: subscriptionInfoSchema }
 *
 * Complete subscription information
 */
export const subscriptionInfoSchema = new Schema({
  isActive: {
    type: Boolean,
    default: false,
    index: true
  },
  plan: {
    type: subscriptionPlanSchema,
    required: true
  },
  startDate: {
    type: Date,
    index: true
  },
  endDate: {
    type: Date,
    index: true
  },
  autoRenew: {
    type: Boolean,
    default: true
  },
  renewalCount: {
    type: Number,
    default: 0,
    min: 0
  },

  // Cancellation
  canceledAt: {
    type: Date
  },
  cancelAt: {
    type: Date
  },
  cancellationReason: {
    type: String
  },

  // Pause/Resume
  pausedAt: {
    type: Date
  },
  pauseReason: {
    type: String
  },

  // Scheduled Plan Changes (Upgrade/Downgrade)
  scheduledChange: {
    type: new Schema({
      // New plan details
      newPlan: {
        type: subscriptionPlanSchema,
        required: true
      },
      // When the change takes effect
      effectiveDate: {
        type: Date,
        required: true
      },
      // Type of change
      changeType: {
        type: String,
        enum: ['upgrade', 'downgrade'],
        required: true
      },
      // Scheduled date
      scheduledAt: {
        type: Date,
        default: Date.now
      },
      // Optional admin price override (for upgrades)
      priceOverride: {
        type: Number,
        min: 0
      },
      // Who scheduled the change
      scheduledBy: {
        type: Schema.Types.ObjectId,
        ref: 'User'
      },
      // Calculation details (for audit trail)
      calculation: {
        type: Schema.Types.Mixed
      }
    }, { _id: false }),
    default: null
  },

  // Metadata
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  },
}, { _id: false });

export default {
  subscriptionInfoSchema,
};
