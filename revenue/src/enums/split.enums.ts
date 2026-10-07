import { PAYMENT_METHOD_KIND } from '@classytic/primitives/payment-method-kind';
export const SPLIT_TYPE = {
  PLATFORM_COMMISSION: 'platform_commission',
  AFFILIATE_COMMISSION: 'affiliate_commission',
  REFERRAL_COMMISSION: 'referral_commission',
  PARTNER_COMMISSION: 'partner_commission',
  CUSTOM: 'custom',
} as const;

export type SplitType = typeof SPLIT_TYPE;
export type SplitTypeValue = SplitType[keyof SplitType];
export const SPLIT_TYPE_VALUES = Object.values(SPLIT_TYPE) as SplitTypeValue[];

export const SPLIT_STATUS = {
  PENDING: 'pending',
  DUE: 'due',
  PAID: 'paid',
  WAIVED: 'waived',
  CANCELLED: 'cancelled',
} as const;

export type SplitStatus = typeof SPLIT_STATUS;
export type SplitStatusValue = SplitStatus[keyof SplitStatus];
export const SPLIT_STATUS_VALUES = Object.values(SPLIT_STATUS) as SplitStatusValue[];

/** How a payout leaves: a `PaymentMethodKind`, or credit to the recipient's platform balance. */
export const PAYOUT_METHOD = {
  BANK_TRANSFER: PAYMENT_METHOD_KIND.BANK_TRANSFER,
  MOBILE_MONEY: PAYMENT_METHOD_KIND.MOBILE_MONEY,
  WALLET: PAYMENT_METHOD_KIND.WALLET,
  CHEQUE: PAYMENT_METHOD_KIND.CHEQUE,
  CRYPTOCURRENCY: PAYMENT_METHOD_KIND.CRYPTO,
  MANUAL: PAYMENT_METHOD_KIND.MANUAL,
  PLATFORM_BALANCE: 'platform_balance',
} as const;

export type PayoutMethod = typeof PAYOUT_METHOD;
export type PayoutMethodValue = PayoutMethod[keyof PayoutMethod];
export const PAYOUT_METHOD_VALUES = Object.values(PAYOUT_METHOD) as PayoutMethodValue[];

const splitTypeSet = new Set<SplitTypeValue>(SPLIT_TYPE_VALUES);
const splitStatusSet = new Set<SplitStatusValue>(SPLIT_STATUS_VALUES);
const payoutMethodSet = new Set<PayoutMethodValue>(PAYOUT_METHOD_VALUES);

export function isSplitType(value: unknown): value is SplitTypeValue {
  return typeof value === 'string' && splitTypeSet.has(value as SplitTypeValue);
}

export function isSplitStatus(value: unknown): value is SplitStatusValue {
  return typeof value === 'string' && splitStatusSet.has(value as SplitStatusValue);
}

export function isPayoutMethod(value: unknown): value is PayoutMethodValue {
  return typeof value === 'string' && payoutMethodSet.has(value as PayoutMethodValue);
}
