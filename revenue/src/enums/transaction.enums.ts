export const TRANSACTION_FLOW = {
  INFLOW: 'inflow',
  OUTFLOW: 'outflow',
} as const;

export type TransactionFlow = typeof TRANSACTION_FLOW;
export type TransactionFlowValue = TransactionFlow[keyof TransactionFlow];
export const TRANSACTION_FLOW_VALUES = Object.values(TRANSACTION_FLOW) as TransactionFlowValue[];

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
export const TRANSACTION_STATUS_VALUES = Object.values(TRANSACTION_STATUS) as TransactionStatusValue[];

export const LIBRARY_CATEGORIES = {
  SUBSCRIPTION: 'subscription',
  PURCHASE: 'purchase',
} as const;

export type LibraryCategories = typeof LIBRARY_CATEGORIES;
export type LibraryCategoryValue = LibraryCategories[keyof LibraryCategories];
export const LIBRARY_CATEGORY_VALUES = Object.values(LIBRARY_CATEGORIES) as LibraryCategoryValue[];

const transactionFlowSet = new Set<TransactionFlowValue>(TRANSACTION_FLOW_VALUES);
const transactionStatusSet = new Set<TransactionStatusValue>(TRANSACTION_STATUS_VALUES);
const libraryCategorySet = new Set<LibraryCategoryValue>(LIBRARY_CATEGORY_VALUES);

export function isLibraryCategory(value: unknown): value is LibraryCategoryValue {
  return typeof value === 'string' && libraryCategorySet.has(value as LibraryCategoryValue);
}

export function isTransactionFlow(value: unknown): value is TransactionFlowValue {
  return typeof value === 'string' && transactionFlowSet.has(value as TransactionFlowValue);
}

export function isTransactionStatus(value: unknown): value is TransactionStatusValue {
  return typeof value === 'string' && transactionStatusSet.has(value as TransactionStatusValue);
}
