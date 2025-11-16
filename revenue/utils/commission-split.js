/**
 * Commission Split Utilities
 * @classytic/revenue
 *
 * Multi-party commission split calculation for affiliate/referral systems
 */

import { SPLIT_TYPE, SPLIT_STATUS } from '../enums/split.enums.js';

/**
 * Calculate multi-party commission splits
 *
 * @param {Number} amount - Transaction amount
 * @param {Array} splitRules - Split configuration
 * @param {Number} gatewayFeeRate - Gateway fee rate (optional)
 * @returns {Array} Split objects
 *
 * @example
 * calculateSplits(1000, [
 *   { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.10 },
 *   { type: 'affiliate_commission', recipientId: 'affiliate-123', recipientType: 'user', rate: 0.02 },
 * ], 0.018);
 *
 * Returns:
 * [
 *   { type: 'platform_commission', recipientId: 'platform', grossAmount: 100, gatewayFeeAmount: 18, netAmount: 82, ... },
 *   { type: 'affiliate_commission', recipientId: 'affiliate-123', grossAmount: 20, gatewayFeeAmount: 0, netAmount: 20, ... },
 * ]
 */
export function calculateSplits(amount, splitRules = [], gatewayFeeRate = 0) {
  if (!splitRules || splitRules.length === 0) {
    return [];
  }

  if (amount < 0) {
    throw new Error('Transaction amount cannot be negative');
  }

  if (gatewayFeeRate < 0 || gatewayFeeRate > 1) {
    throw new Error('Gateway fee rate must be between 0 and 1');
  }

  const totalRate = splitRules.reduce((sum, rule) => sum + rule.rate, 0);
  if (totalRate > 1) {
    throw new Error(`Total split rate (${totalRate}) cannot exceed 1.0`);
  }

  return splitRules.map((rule, index) => {
    if (rule.rate < 0 || rule.rate > 1) {
      throw new Error(`Split rate must be between 0 and 1 for split ${index}`);
    }

    const grossAmount = Math.round(amount * rule.rate * 100) / 100;

    const gatewayFeeAmount = index === 0 && gatewayFeeRate > 0
      ? Math.round(amount * gatewayFeeRate * 100) / 100
      : 0;

    const netAmount = Math.max(0, Math.round((grossAmount - gatewayFeeAmount) * 100) / 100);

    return {
      type: rule.type || SPLIT_TYPE.CUSTOM,
      recipientId: rule.recipientId,
      recipientType: rule.recipientType,
      rate: rule.rate,
      grossAmount,
      gatewayFeeRate: gatewayFeeAmount > 0 ? gatewayFeeRate : 0,
      gatewayFeeAmount,
      netAmount,
      status: SPLIT_STATUS.PENDING,
      dueDate: rule.dueDate || null,
      metadata: rule.metadata || {},
    };
  });
}

/**
 * Calculate organization payout after splits
 *
 * @param {Number} amount - Total transaction amount
 * @param {Array} splits - Calculated splits
 * @returns {Number} Amount organization receives
 */
export function calculateOrganizationPayout(amount, splits = []) {
  const totalSplitAmount = splits.reduce((sum, split) => sum + split.grossAmount, 0);
  return Math.max(0, Math.round((amount - totalSplitAmount) * 100) / 100);
}

/**
 * Reverse splits proportionally on refund
 *
 * @param {Array} originalSplits - Original split objects
 * @param {Number} originalAmount - Original transaction amount
 * @param {Number} refundAmount - Amount being refunded
 * @returns {Array} Reversed splits
 */
export function reverseSplits(originalSplits, originalAmount, refundAmount) {
  if (!originalSplits || originalSplits.length === 0) {
    return [];
  }

  const refundRatio = refundAmount / originalAmount;

  return originalSplits.map(split => ({
    ...split,
    grossAmount: Math.round(split.grossAmount * refundRatio * 100) / 100,
    gatewayFeeAmount: Math.round(split.gatewayFeeAmount * refundRatio * 100) / 100,
    netAmount: Math.round(split.netAmount * refundRatio * 100) / 100,
    status: SPLIT_STATUS.WAIVED,
  }));
}

/**
 * Build commission object with splits support
 * Backward compatible with existing calculateCommission
 *
 * @param {Number} amount - Transaction amount
 * @param {Number} commissionRate - Platform commission rate
 * @param {Number} gatewayFeeRate - Gateway fee rate
 * @param {Object} options - Additional options
 * @returns {Object} Commission with optional splits
 */
export function calculateCommissionWithSplits(amount, commissionRate, gatewayFeeRate = 0, options = {}) {
  const { affiliateRate = 0, affiliateId = null, affiliateType = 'user' } = options;

  if (commissionRate <= 0 && affiliateRate <= 0) {
    return null;
  }

  const splitRules = [];

  if (commissionRate > 0) {
    splitRules.push({
      type: SPLIT_TYPE.PLATFORM_COMMISSION,
      recipientId: 'platform',
      recipientType: 'platform',
      rate: commissionRate,
    });
  }

  if (affiliateRate > 0 && affiliateId) {
    splitRules.push({
      type: SPLIT_TYPE.AFFILIATE_COMMISSION,
      recipientId: affiliateId,
      recipientType: affiliateType,
      rate: affiliateRate,
    });
  }

  const splits = calculateSplits(amount, splitRules, gatewayFeeRate);

  const platformSplit = splits.find(s => s.type === SPLIT_TYPE.PLATFORM_COMMISSION);
  const affiliateSplit = splits.find(s => s.type === SPLIT_TYPE.AFFILIATE_COMMISSION);

  return {
    rate: commissionRate,
    grossAmount: platformSplit?.grossAmount || 0,
    gatewayFeeRate: platformSplit?.gatewayFeeRate || 0,
    gatewayFeeAmount: platformSplit?.gatewayFeeAmount || 0,
    netAmount: platformSplit?.netAmount || 0,
    status: SPLIT_STATUS.PENDING,
    ...(splits.length > 0 && { splits }),
    ...(affiliateSplit && {
      affiliate: {
        recipientId: affiliateSplit.recipientId,
        recipientType: affiliateSplit.recipientType,
        rate: affiliateSplit.rate,
        grossAmount: affiliateSplit.grossAmount,
        netAmount: affiliateSplit.netAmount,
      },
    }),
  };
}

export default {
  calculateSplits,
  calculateOrganizationPayout,
  reverseSplits,
  calculateCommissionWithSplits,
};
