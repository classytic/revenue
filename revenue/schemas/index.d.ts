/**
 * TypeScript definitions for @classytic/revenue/schemas
 * Core schemas for injection into your models
 */

import { Schema } from 'mongoose';

// ============ TRANSACTION SCHEMAS ============

export const currentPaymentSchema: Schema;
export const paymentSummarySchema: Schema;
export const paymentDetailsSchema: Schema;
export const gatewaySchema: Schema;
export const commissionSchema: Schema;

// ============ SUBSCRIPTION SCHEMAS ============

export const subscriptionInfoSchema: Schema;
export const subscriptionPlanSchema: Schema;

// ============ DEFAULT EXPORT ============

declare const _default: {
  currentPaymentSchema: Schema;
  paymentSummarySchema: Schema;
  paymentDetailsSchema: Schema;
  gatewaySchema: Schema;
  commissionSchema: Schema;
  subscriptionInfoSchema: Schema;
  subscriptionPlanSchema: Schema;
};

export default _default;
