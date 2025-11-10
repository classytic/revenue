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
export const tenantSnapshotSchema: Schema;
export const timelineEventSchema: Schema;
export const customerInfoSchema: Schema;

// ============ SUBSCRIPTION SCHEMAS ============

export const subscriptionInfoSchema: Schema;
export const subscriptionPlanSchema: Schema;
export const customDiscountSchema: Schema;

// ============ GATEWAY ACCOUNT SCHEMAS ============

export const stripeAccountSchema: Schema;
export const sslcommerzAccountSchema: Schema;
export const bkashMerchantSchema: Schema;
export const bankAccountSchema: Schema;
export const walletSchema: Schema;

// ============ DEFAULT EXPORT ============

declare const _default: {
  currentPaymentSchema: Schema;
  paymentSummarySchema: Schema;
  paymentDetailsSchema: Schema;
  gatewaySchema: Schema;
  commissionSchema: Schema;
  tenantSnapshotSchema: Schema;
  timelineEventSchema: Schema;
  customerInfoSchema: Schema;
  subscriptionInfoSchema: Schema;
  subscriptionPlanSchema: Schema;
  customDiscountSchema: Schema;
  stripeAccountSchema: Schema;
  sslcommerzAccountSchema: Schema;
  bkashMerchantSchema: Schema;
  bankAccountSchema: Schema;
  walletSchema: Schema;
};

export default _default;
