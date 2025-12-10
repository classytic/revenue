/**
 * Split Payment Enums
 * @classytic/revenue
 *
 * Enums for multi-party commission splits
 */

export const SPLIT_TYPE = {
  PLATFORM_COMMISSION: 'platform_commission',
  AFFILIATE_COMMISSION: 'affiliate_commission',
  REFERRAL_COMMISSION: 'referral_commission',
  PARTNER_COMMISSION: 'partner_commission',
  CUSTOM: 'custom',
} as const;

export type SplitType = typeof SPLIT_TYPE;
export type SplitTypeValue = SplitType[keyof SplitType];
export const SPLIT_TYPE_VALUES = Object.values(SPLIT_TYPE);

export const SPLIT_STATUS = {
  PENDING: 'pending',
  DUE: 'due',
  PAID: 'paid',
  WAIVED: 'waived',
  CANCELLED: 'cancelled',
} as const;

export type SplitStatus = typeof SPLIT_STATUS;
export type SplitStatusValue = SplitStatus[keyof SplitStatus];
export const SPLIT_STATUS_VALUES = Object.values(SPLIT_STATUS);

export const PAYOUT_METHOD = {
  BANK_TRANSFER: 'bank_transfer',
  MOBILE_WALLET: 'mobile_wallet',
  PLATFORM_BALANCE: 'platform_balance',
  CRYPTO: 'crypto',
  CHECK: 'check',
  MANUAL: 'manual',
} as const;

export type PayoutMethod = typeof PAYOUT_METHOD;
export type PayoutMethodValue = PayoutMethod[keyof PayoutMethod];
export const PAYOUT_METHOD_VALUES = Object.values(PAYOUT_METHOD);

