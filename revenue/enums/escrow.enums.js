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
};

export const HOLD_STATUS_VALUES = Object.values(HOLD_STATUS);

export const RELEASE_REASON = {
  PAYMENT_VERIFIED: 'payment_verified',
  MANUAL_RELEASE: 'manual_release',
  AUTO_RELEASE: 'auto_release',
  DISPUTE_RESOLVED: 'dispute_resolved',
};

export const RELEASE_REASON_VALUES = Object.values(RELEASE_REASON);

export const HOLD_REASON = {
  PAYMENT_VERIFICATION: 'payment_verification',
  FRAUD_CHECK: 'fraud_check',
  MANUAL_REVIEW: 'manual_review',
  DISPUTE: 'dispute',
  COMPLIANCE: 'compliance',
};

export const HOLD_REASON_VALUES = Object.values(HOLD_REASON);
