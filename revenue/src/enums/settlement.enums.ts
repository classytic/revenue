export const SETTLEMENT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type SettlementStatus = typeof SETTLEMENT_STATUS;
export type SettlementStatusValue = SettlementStatus[keyof SettlementStatus];
export const SETTLEMENT_STATUS_VALUES = Object.values(SETTLEMENT_STATUS) as SettlementStatusValue[];

export const SETTLEMENT_TYPE = {
  SPLIT_PAYOUT: 'split_payout',
  PLATFORM_WITHDRAWAL: 'platform_withdrawal',
  MANUAL_PAYOUT: 'manual_payout',
  ESCROW_RELEASE: 'escrow_release',
} as const;

export type SettlementType = typeof SETTLEMENT_TYPE;
export type SettlementTypeValue = SettlementType[keyof SettlementType];
export const SETTLEMENT_TYPE_VALUES = Object.values(SETTLEMENT_TYPE) as SettlementTypeValue[];

const settlementStatusSet = new Set<SettlementStatusValue>(SETTLEMENT_STATUS_VALUES);
const settlementTypeSet = new Set<SettlementTypeValue>(SETTLEMENT_TYPE_VALUES);

export function isSettlementStatus(value: unknown): value is SettlementStatusValue {
  return typeof value === 'string' && settlementStatusSet.has(value as SettlementStatusValue);
}

export function isSettlementType(value: unknown): value is SettlementTypeValue {
  return typeof value === 'string' && settlementTypeSet.has(value as SettlementTypeValue);
}
