/**
 * @classytic/revenue - Transaction Types
 * Re-export unified transaction interface from shared-types
 *
 * This package uses the unified transaction interface from @classytic/shared-types
 * which provides a single source of truth for both revenue and payroll packages.
 */
export type {
  ITransaction,
  ITransactionCreateInput,
  HoldInfo,
  ReleaseRecord,
  HoldStatusValue,
  HoldReasonValue,
  ReleaseReasonValue,
} from '@classytic/shared-types';

export {
  isTransaction,
  toTransactionObject,
} from '@classytic/shared-types';
