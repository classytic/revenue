/**
 * TypeScript definitions for @classytic/revenue/utils
 * Core utilities
 */

// ============ TRANSACTION TYPE UTILITIES ============

export const TRANSACTION_TYPE: {
  readonly MONETIZATION: 'monetization';
  readonly MANUAL: 'manual';
};

export const PROTECTED_MONETIZATION_FIELDS: readonly string[];
export const EDITABLE_MONETIZATION_FIELDS_PRE_VERIFICATION: readonly string[];
export const MANUAL_TRANSACTION_CREATE_FIELDS: readonly string[];
export const MANUAL_TRANSACTION_UPDATE_FIELDS: readonly string[];

export interface TransactionTypeOptions {
  targetModels?: string[];
  additionalCategories?: string[];
}

export function isMonetizationTransaction(
  transaction: any,
  options?: TransactionTypeOptions
): boolean;

export function isManualTransaction(
  transaction: any,
  options?: TransactionTypeOptions
): boolean;

export function getTransactionType(
  transaction: any,
  options?: TransactionTypeOptions
): 'monetization' | 'manual';

export function getAllowedUpdateFields(
  transaction: any,
  options?: TransactionTypeOptions
): string[];

export interface FieldValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateFieldUpdate(
  transaction: any,
  fieldName: string,
  options?: TransactionTypeOptions
): FieldValidationResult;

export function canSelfVerify(
  transaction: any,
  options?: TransactionTypeOptions
): boolean;

// ============ LOGGER UTILITIES ============

export interface Logger {
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  debug(...args: any[]): void;
}

export const logger: Logger;
export function setLogger(logger: Logger | Console): void;

// ============ HOOK UTILITIES ============

export function triggerHook(
  hooks: Record<string, Function[]>,
  event: string,
  data: any,
  logger: Logger
): void;

// ============ COMMISSION UTILITIES ============

export interface CommissionObject {
  rate: number;
  grossAmount: number;
  gatewayFeeRate: number;
  gatewayFeeAmount: number;
  netAmount: number;
  status: 'pending' | 'due' | 'paid' | 'waived';
}

export function calculateCommission(
  amount: number,
  commissionRate: number,
  gatewayFeeRate?: number
): CommissionObject | null;

export function reverseCommission(
  originalCommission: CommissionObject,
  originalAmount: number,
  refundAmount: number
): CommissionObject | null;

// ============ SUBSCRIPTION UTILITIES ============

export function addDuration(startDate: Date, duration: number, unit?: string): Date;

export function calculatePeriodRange(params: {
  currentEndDate?: Date | null;
  startDate?: Date | null;
  duration: number;
  unit?: string;
  now?: Date;
}): { startDate: Date; endDate: Date };

export function calculateProratedAmount(params: {
  amountPaid: number;
  startDate: Date;
  endDate: Date;
  asOfDate?: Date;
  precision?: number;
}): number;

export function resolveIntervalToDuration(
  interval?: string,
  intervalCount?: number
): { duration: number; unit: string };

export function isSubscriptionActive(subscription: any): boolean;
export function canRenewSubscription(entity: any): boolean;
export function canCancelSubscription(entity: any): boolean;
export function canPauseSubscription(entity: any): boolean;
export function canResumeSubscription(entity: any): boolean;

// ============ DEFAULT EXPORT ============

declare const _default: {
  TRANSACTION_TYPE: typeof TRANSACTION_TYPE;
  isMonetizationTransaction: typeof isMonetizationTransaction;
  isManualTransaction: typeof isManualTransaction;
  getTransactionType: typeof getTransactionType;
  PROTECTED_MONETIZATION_FIELDS: typeof PROTECTED_MONETIZATION_FIELDS;
  EDITABLE_MONETIZATION_FIELDS_PRE_VERIFICATION: typeof EDITABLE_MONETIZATION_FIELDS_PRE_VERIFICATION;
  MANUAL_TRANSACTION_CREATE_FIELDS: typeof MANUAL_TRANSACTION_CREATE_FIELDS;
  MANUAL_TRANSACTION_UPDATE_FIELDS: typeof MANUAL_TRANSACTION_UPDATE_FIELDS;
  getAllowedUpdateFields: typeof getAllowedUpdateFields;
  validateFieldUpdate: typeof validateFieldUpdate;
  canSelfVerify: typeof canSelfVerify;
  logger: typeof logger;
  setLogger: typeof setLogger;
  triggerHook: typeof triggerHook;
  calculateCommission: typeof calculateCommission;
  reverseCommission: typeof reverseCommission;
  addDuration: typeof addDuration;
  calculatePeriodRange: typeof calculatePeriodRange;
  calculateProratedAmount: typeof calculateProratedAmount;
  resolveIntervalToDuration: typeof resolveIntervalToDuration;
  isSubscriptionActive: typeof isSubscriptionActive;
  canRenewSubscription: typeof canRenewSubscription;
  canCancelSubscription: typeof canCancelSubscription;
  canPauseSubscription: typeof canPauseSubscription;
  canResumeSubscription: typeof canResumeSubscription;
};

export default _default;
