/**
 * TypeScript definitions for @classytic/revenue/enums
 * Centralized Enums
 */

// ============ TRANSACTION ENUMS ============

export const TRANSACTION_TYPE: {
  readonly INCOME: 'income';
  readonly EXPENSE: 'expense';
};

export const TRANSACTION_TYPE_VALUES: string[];

export const TRANSACTION_STATUS: {
  readonly PENDING: 'pending';
  readonly PAYMENT_INITIATED: 'payment_initiated';
  readonly PROCESSING: 'processing';
  readonly REQUIRES_ACTION: 'requires_action';
  readonly VERIFIED: 'verified';
  readonly COMPLETED: 'completed';
  readonly FAILED: 'failed';
  readonly CANCELLED: 'cancelled';
  readonly EXPIRED: 'expired';
  readonly REFUNDED: 'refunded';
  readonly PARTIALLY_REFUNDED: 'partially_refunded';
};

export const TRANSACTION_STATUS_VALUES: string[];

export const LIBRARY_CATEGORIES: {
  readonly SUBSCRIPTION: 'subscription';
  readonly PURCHASE: 'purchase';
};

export const LIBRARY_CATEGORY_VALUES: string[];

// ============ PAYMENT ENUMS ============

export const PAYMENT_STATUS: {
  readonly PENDING: 'pending';
  readonly VERIFIED: 'verified';
  readonly FAILED: 'failed';
  readonly REFUNDED: 'refunded';
  readonly CANCELLED: 'cancelled';
};

export const PAYMENT_STATUS_VALUES: string[];

export const PAYMENT_GATEWAY_TYPE: {
  readonly MANUAL: 'manual';
  readonly STRIPE: 'stripe';
  readonly SSLCOMMERZ: 'sslcommerz';
};

export const PAYMENT_GATEWAY_TYPE_VALUES: string[];

// Backward compatibility aliases
export const GATEWAY_TYPES: typeof PAYMENT_GATEWAY_TYPE;
export const GATEWAY_TYPE_VALUES: typeof PAYMENT_GATEWAY_TYPE_VALUES;

// ============ SUBSCRIPTION ENUMS ============

export const SUBSCRIPTION_STATUS: {
  readonly ACTIVE: 'active';
  readonly PAUSED: 'paused';
  readonly CANCELLED: 'cancelled';
  readonly EXPIRED: 'expired';
  readonly PENDING: 'pending';
  readonly INACTIVE: 'inactive';
};

export const SUBSCRIPTION_STATUS_VALUES: string[];

export const PLAN_KEYS: {
  readonly MONTHLY: 'monthly';
  readonly QUARTERLY: 'quarterly';
  readonly YEARLY: 'yearly';
};

export const PLAN_KEY_VALUES: string[];

// ============ MONETIZATION ENUMS ============

export const MONETIZATION_TYPES: {
  readonly FREE: 'free';
  readonly PURCHASE: 'purchase';
  readonly SUBSCRIPTION: 'subscription';
};

export const MONETIZATION_TYPE_VALUES: string[];

// ============ DEFAULT EXPORT ============

declare const _default: {
  TRANSACTION_TYPE: typeof TRANSACTION_TYPE;
  TRANSACTION_TYPE_VALUES: typeof TRANSACTION_TYPE_VALUES;
  TRANSACTION_STATUS: typeof TRANSACTION_STATUS;
  TRANSACTION_STATUS_VALUES: typeof TRANSACTION_STATUS_VALUES;
  LIBRARY_CATEGORIES: typeof LIBRARY_CATEGORIES;
  LIBRARY_CATEGORY_VALUES: typeof LIBRARY_CATEGORY_VALUES;
  PAYMENT_STATUS: typeof PAYMENT_STATUS;
  PAYMENT_STATUS_VALUES: typeof PAYMENT_STATUS_VALUES;
  PAYMENT_GATEWAY_TYPE: typeof PAYMENT_GATEWAY_TYPE;
  PAYMENT_GATEWAY_TYPE_VALUES: typeof PAYMENT_GATEWAY_TYPE_VALUES;
  GATEWAY_TYPES: typeof GATEWAY_TYPES;
  GATEWAY_TYPE_VALUES: typeof GATEWAY_TYPE_VALUES;
  SUBSCRIPTION_STATUS: typeof SUBSCRIPTION_STATUS;
  SUBSCRIPTION_STATUS_VALUES: typeof SUBSCRIPTION_STATUS_VALUES;
  PLAN_KEYS: typeof PLAN_KEYS;
  PLAN_KEY_VALUES: typeof PLAN_KEY_VALUES;
  MONETIZATION_TYPES: typeof MONETIZATION_TYPES;
  MONETIZATION_TYPE_VALUES: typeof MONETIZATION_TYPE_VALUES;
};

export default _default;
