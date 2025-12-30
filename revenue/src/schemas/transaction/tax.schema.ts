/**
 * Tax Schema
 * @classytic/revenue
 *
 * Mongoose schema for tax breakdown in transactions
 */

import { Schema } from 'mongoose';

/**
 * Tax Breakdown Schema
 * Embed this in Transaction model to track tax
 *
 * @example
 * ```typescript
 * import mongoose from 'mongoose';
 * import { taxBreakdownSchema } from '@classytic/revenue/schemas';
 *
 * const transactionSchema = new mongoose.Schema({
 *   amount: Number,
 *   tax: taxBreakdownSchema,  // Add tax tracking
 *   // ... other fields
 * });
 * ```
 */
export const taxBreakdownSchema = new Schema({
  /** Is tax applicable for this transaction? */
  isApplicable: {
    type: Boolean,
    default: false,
  },

  /** Tax rate used (0-1, e.g., 0.15 = 15%) */
  rate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1,
  },

  /** Base amount (before tax) */
  baseAmount: {
    type: Number,
    default: 0,
    min: 0,
  },

  /** Tax amount */
  taxAmount: {
    type: Number,
    default: 0,
    min: 0,
  },

  /** Total amount (base + tax) */
  totalAmount: {
    type: Number,
    default: 0,
    min: 0,
  },

  /** Were prices tax-inclusive? */
  pricesIncludeTax: {
    type: Boolean,
  },

  /** Tax type: collected (revenue), paid (expense), or exempt */
  type: {
    type: String,
    enum: ['collected', 'paid', 'exempt'],
  },
}, { _id: false });

/**
 * TypeScript type inference
 */
export type TaxBreakdown = {
  isApplicable: boolean;
  rate: number;
  baseAmount: number;
  taxAmount: number;
  totalAmount: number;
  pricesIncludeTax?: boolean;
  type?: 'collected' | 'paid' | 'exempt';
};

export default taxBreakdownSchema;
