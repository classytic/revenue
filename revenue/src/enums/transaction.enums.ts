/**
 * Transaction Enums
 * @classytic/revenue
 *
 * Library-managed transaction enums only.
 * Users should define their own categories and merge with these.
 */

// ============ TRANSACTION FLOW ============
/**
 * Transaction Flow - Directional money movement
 *
 * INFLOW: Money coming in (payments, subscriptions, purchases, receipts)
 * OUTFLOW: Money going out (refunds, payouts, expenses, disbursements)
 *
 * Industry-standard terminology compatible with QuickBooks, Xero, and other accounting systems.
 * Users can map categories to flow directions via transactionTypeMapping config.
 *
 * @example
 * // Revenue platform
 * { type: 'subscription', flow: 'inflow' }
 *
 * // Payroll platform
 * { type: 'salary', flow: 'outflow' }
 *
 * // Marketplace
 * { type: 'commission', flow: 'outflow' }  // Paying sellers
 * { type: 'platform_fee', flow: 'inflow' } // Platform revenue
 */
export const TRANSACTION_FLOW = {
  INFLOW: 'inflow',
  OUTFLOW: 'outflow',
} as const;

/** @deprecated Use TRANSACTION_FLOW instead */
export const TRANSACTION_TYPE = TRANSACTION_FLOW;

export type TransactionFlow = typeof TRANSACTION_FLOW;
export type TransactionFlowValue = TransactionFlow[keyof TransactionFlow];
export const TRANSACTION_FLOW_VALUES = Object.values(
  TRANSACTION_FLOW,
) as TransactionFlowValue[];

/** @deprecated Use TransactionFlow instead */
export type TransactionType = TransactionFlow;
/** @deprecated Use TransactionFlowValue instead */
export type TransactionTypeValue = TransactionFlowValue;
/** @deprecated Use TRANSACTION_FLOW_VALUES instead */
export const TRANSACTION_TYPE_VALUES = TRANSACTION_FLOW_VALUES;

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
} as const;

export type TransactionStatus = typeof TRANSACTION_STATUS;
export type TransactionStatusValue = TransactionStatus[keyof TransactionStatus];
export const TRANSACTION_STATUS_VALUES = Object.values(
  TRANSACTION_STATUS,
) as TransactionStatusValue[];

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
 * } as const;
 */
export const LIBRARY_CATEGORIES = {
  SUBSCRIPTION: 'subscription',
  PURCHASE: 'purchase',
} as const;

export type LibraryCategories = typeof LIBRARY_CATEGORIES;
export type LibraryCategoryValue = LibraryCategories[keyof LibraryCategories];
export const LIBRARY_CATEGORY_VALUES = Object.values(
  LIBRARY_CATEGORIES,
) as LibraryCategoryValue[];

const transactionFlowSet = new Set<TransactionFlowValue>(TRANSACTION_FLOW_VALUES);
const transactionStatusSet = new Set<TransactionStatusValue>(
  TRANSACTION_STATUS_VALUES,
);
const libraryCategorySet = new Set<LibraryCategoryValue>(LIBRARY_CATEGORY_VALUES);

export function isLibraryCategory(value: unknown): value is LibraryCategoryValue {
  return typeof value === 'string' && libraryCategorySet.has(value as LibraryCategoryValue);
}

export function isTransactionFlow(value: unknown): value is TransactionFlowValue {
  return typeof value === 'string' && transactionFlowSet.has(value as TransactionFlowValue);
}

/** @deprecated Use isTransactionFlow instead */
export function isTransactionType(value: unknown): value is TransactionTypeValue {
  return isTransactionFlow(value);
}

export function isTransactionStatus(
  value: unknown,
): value is TransactionStatusValue {
  return typeof value === 'string' && transactionStatusSet.has(value as TransactionStatusValue);
}
