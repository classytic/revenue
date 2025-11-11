/**
 * Commission Calculation Utility
 * @classytic/revenue
 *
 * Handles platform commission calculation with gateway fee deduction
 */

/**
 * Build commission object for transaction
 *
 * @param {Number} amount - Transaction amount
 * @param {Number} commissionRate - Commission rate (0 to 1, e.g., 0.10 for 10%)
 * @param {Number} gatewayFeeRate - Gateway fee rate (0 to 1, e.g., 0.018 for 1.8%)
 * @returns {Object} Commission object or null
 */
export function calculateCommission(amount, commissionRate, gatewayFeeRate = 0) {
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

  // Calculate commission
  const grossAmount = Math.round(amount * commissionRate * 100) / 100; // Round to 2 decimals
  const gatewayFeeAmount = Math.round(amount * gatewayFeeRate * 100) / 100;
  const netAmount = Math.max(0, Math.round((grossAmount - gatewayFeeAmount) * 100) / 100);

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
 * @param {Object} originalCommission - Original commission object
 * @param {Number} originalAmount - Original transaction amount
 * @param {Number} refundAmount - Amount being refunded
 * @returns {Object} Reversed commission or null
 */
export function reverseCommission(originalCommission, originalAmount, refundAmount) {
  if (!originalCommission || !originalCommission.netAmount) {
    return null;
  }

  // Calculate proportional refund
  const refundRatio = refundAmount / originalAmount;
  const reversedNetAmount = Math.round(originalCommission.netAmount * refundRatio * 100) / 100;
  const reversedGrossAmount = Math.round(originalCommission.grossAmount * refundRatio * 100) / 100;
  const reversedGatewayFee = Math.round(originalCommission.gatewayFeeAmount * refundRatio * 100) / 100;

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

