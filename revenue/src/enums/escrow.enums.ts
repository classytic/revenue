/**
 * Escrow/Hold Enums
 * @classytic/revenue
 *
 * Enums for platform-as-intermediary payment flow
 */

export const HOLD_STATUS = {
  PENDING: 'pending',
  HELD: 'held',
  RELEASED: 'released',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PARTIALLY_RELEASED: 'partially_released',
} as const;

export type HoldStatus = typeof HOLD_STATUS;
export type HoldStatusValue = HoldStatus[keyof HoldStatus];
export const HOLD_STATUS_VALUES = Object.values(HOLD_STATUS);

export const RELEASE_REASON = {
  PAYMENT_VERIFIED: 'payment_verified',
  MANUAL_RELEASE: 'manual_release',
  AUTO_RELEASE: 'auto_release',
  DISPUTE_RESOLVED: 'dispute_resolved',
} as const;

export type ReleaseReason = typeof RELEASE_REASON;
export type ReleaseReasonValue = ReleaseReason[keyof ReleaseReason];
export const RELEASE_REASON_VALUES = Object.values(RELEASE_REASON);

export const HOLD_REASON = {
  PAYMENT_VERIFICATION: 'payment_verification',
  FRAUD_CHECK: 'fraud_check',
  MANUAL_REVIEW: 'manual_review',
  DISPUTE: 'dispute',
  COMPLIANCE: 'compliance',
} as const;

export type HoldReason = typeof HOLD_REASON;
export type HoldReasonValue = HoldReason[keyof HoldReason];
export const HOLD_REASON_VALUES = Object.values(HOLD_REASON);

