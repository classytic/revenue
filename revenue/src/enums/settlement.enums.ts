/**
 * Settlement Enums
 * @classytic/revenue
 *
 * Enums for settlement/payout tracking
 */

// ============ SETTLEMENT STATUS ============

export const SETTLEMENT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type SettlementStatus = typeof SETTLEMENT_STATUS;
export type SettlementStatusValue = SettlementStatus[keyof SettlementStatus];

export const SETTLEMENT_STATUS_VALUES = Object.values(SETTLEMENT_STATUS);

/**
 * Type guard for settlement status
 */
export function isSettlementStatus(value: unknown): value is SettlementStatusValue {
  return typeof value === 'string' && SETTLEMENT_STATUS_VALUES.includes(value as SettlementStatusValue);
}

// ============ SETTLEMENT TYPE ============

export const SETTLEMENT_TYPE = {
  SPLIT_PAYOUT: 'split_payout',           // Payout to split recipient (vendor/affiliate)
  PLATFORM_WITHDRAWAL: 'platform_withdrawal', // Platform withdraws commission
  MANUAL_PAYOUT: 'manual_payout',         // Manual vendor payout
  ESCROW_RELEASE: 'escrow_release',       // Release from escrow hold
} as const;

export type SettlementType = typeof SETTLEMENT_TYPE;
export type SettlementTypeValue = SettlementType[keyof SettlementType];

export const SETTLEMENT_TYPE_VALUES = Object.values(SETTLEMENT_TYPE);

/**
 * Type guard for settlement type
 */
export function isSettlementType(value: unknown): value is SettlementTypeValue {
  return typeof value === 'string' && SETTLEMENT_TYPE_VALUES.includes(value as SettlementTypeValue);
}

// ============ EXPORTS ============

export default {
  SETTLEMENT_STATUS,
  SETTLEMENT_STATUS_VALUES,
  SETTLEMENT_TYPE,
  SETTLEMENT_TYPE_VALUES,
  isSettlementStatus,
  isSettlementType,
};
