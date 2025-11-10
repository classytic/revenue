/**
 * Transaction Enums
 * @classytic/revenue
 *
 * Library-managed transaction enums only.
 * Users should define their own categories and merge with these.
 */

// ============ TRANSACTION STATUS ============
/**
 * Transaction Status - Library-managed states
 */
export const TRANSACTION_STATUS = {
  PENDING: 'pending',
  PAYMENT_INITIATED: 'payment_initiated',
  PROCESSING: 'processing',
  REQUIRES_ACTION: 'requires_action',
  VERIFIED: 'verified',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
};

export const TRANSACTION_STATUS_VALUES = Object.values(TRANSACTION_STATUS);

// ============ LIBRARY CATEGORIES ============
/**
 * Categories managed by this library
 *
 * SUBSCRIPTION: Recurring subscription payments
 * PURCHASE: One-time purchases
 *
 * Users should spread these into their own category enums:
 *
 * @example
 * import { LIBRARY_CATEGORIES } from '@classytic/revenue';
 *
 * export const MY_CATEGORIES = {
 *   ...LIBRARY_CATEGORIES,
 *   SALARY: 'salary',
 *   RENT: 'rent',
 *   EQUIPMENT: 'equipment',
 * };
 */
export const LIBRARY_CATEGORIES = {
  SUBSCRIPTION: 'subscription',
  PURCHASE: 'purchase',
};

export const LIBRARY_CATEGORY_VALUES = Object.values(LIBRARY_CATEGORIES);
