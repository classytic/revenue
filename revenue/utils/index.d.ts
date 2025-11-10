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
};

export default _default;
