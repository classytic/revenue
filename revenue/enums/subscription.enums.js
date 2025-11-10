/**
 * Subscription Enums
 * @classytic/revenue
 *
 * All subscription-related enums and constants
 */

// ============ SUBSCRIPTION STATUS ============
/**
 * Subscription Status
 */
export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PENDING: 'pending',
  INACTIVE: 'inactive',
};

export const SUBSCRIPTION_STATUS_VALUES = Object.values(SUBSCRIPTION_STATUS);

// ============ PLAN KEYS ============
/**
 * Supported plan intervals
 */
export const PLAN_KEYS = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
};

export const PLAN_KEY_VALUES = Object.values(PLAN_KEYS);
