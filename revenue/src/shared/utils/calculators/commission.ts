/**
 * Commission Calculation Utility
 * @classytic/revenue
 *
 * Handles platform commission calculation with gateway fee deduction
 */

import type { CommissionInfo } from '../../types/index.js';
import { ValidationError } from '../../../core/errors.js';

/**
 * Build commission object for transaction
 *
 * @param amount - Transaction amount
 * @param commissionRate - Commission rate (0 to 1, e.g., 0.10 for 10%)
 * @param gatewayFeeRate - Gateway fee rate (0 to 1, e.g., 0.018 for 1.8%)
 * @returns Commission object or null
 */
export function calculateCommission(
  amount: number,
  commissionRate: number,
  gatewayFeeRate: number = 0
): CommissionInfo | null {
  // No commission if rate is 0 or negative
  if (!commissionRate || commissionRate <= 0) {
    return null;
  }

  // Validate inputs
  if (amount < 0) {
    throw new Error('Transaction amount cannot be negative');
  }

  if (commissionRate < 0 || commissionRate > 1) {
    throw new Error('Commission rate must be between 0 and 1');
  }

  if (gatewayFeeRate < 0 || gatewayFeeRate > 1) {
    throw new Error('Gateway fee rate must be between 0 and 1');
  }

  // Calculate commission (integer-only math, amounts are in smallest currency unit)
  const grossAmount = Math.round(amount * commissionRate);
  const gatewayFeeAmount = Math.round(amount * gatewayFeeRate);
  const netAmount = Math.max(0, grossAmount - gatewayFeeAmount);

  return {
    rate: commissionRate,
    grossAmount,
    gatewayFeeRate,
    gatewayFeeAmount,
    netAmount,
    status: 'pending',
  };
}

/**
 * Reverse commission on refund (proportional)
 *
 * @param originalCommission - Original commission object
 * @param originalAmount - Original transaction amount
 * @param refundAmount - Amount being refunded
 * @returns Reversed commission or null
 */
export function reverseCommission(
  originalCommission: CommissionInfo | null | undefined,
  originalAmount: number,
  refundAmount: number
): CommissionInfo | null {
  if (!originalCommission?.netAmount) {
    return null;
  }

  // Edge case validations
  if (!originalAmount || originalAmount <= 0) {
    throw new ValidationError('Original amount must be greater than 0', { originalAmount });
  }

  if (refundAmount < 0) {
    throw new ValidationError('Refund amount cannot be negative', { refundAmount });
  }

  if (refundAmount > originalAmount) {
    throw new ValidationError(
      `Refund amount (${refundAmount}) exceeds original amount (${originalAmount})`,
      { refundAmount, originalAmount }
    );
  }

  // Calculate proportional refund (integer-only math)
  const refundRatio = refundAmount / originalAmount;
  const reversedNetAmount = Math.round(originalCommission.netAmount * refundRatio);
  const reversedGrossAmount = Math.round(originalCommission.grossAmount * refundRatio);
  const reversedGatewayFee = Math.round(originalCommission.gatewayFeeAmount * refundRatio);

  return {
    rate: originalCommission.rate,
    grossAmount: reversedGrossAmount,
    gatewayFeeRate: originalCommission.gatewayFeeRate,
    gatewayFeeAmount: reversedGatewayFee,
    netAmount: reversedNetAmount,
    status: 'waived', // Commission waived due to refund
  };
}

export default {
  calculateCommission,
  reverseCommission,
};

