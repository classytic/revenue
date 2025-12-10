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
} as const;

export type SubscriptionStatus = typeof SUBSCRIPTION_STATUS;
export type SubscriptionStatusValue = SubscriptionStatus[keyof SubscriptionStatus];
export const SUBSCRIPTION_STATUS_VALUES = Object.values(SUBSCRIPTION_STATUS);

// ============ PLAN KEYS ============
/**
 * Supported plan intervals
 */
export const PLAN_KEYS = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
} as const;

export type PlanKeys = typeof PLAN_KEYS;
export type PlanKeyValue = PlanKeys[keyof PlanKeys];
export const PLAN_KEY_VALUES = Object.values(PLAN_KEYS);

