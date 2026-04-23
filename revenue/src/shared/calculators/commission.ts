export interface CommissionInfo {
  rate: number;
  grossAmount: number;
  gatewayFeeRate: number;
  gatewayFeeAmount: number;
  netAmount: number;
  status: string;
}

export function calculateCommission(
  amount: number,
  commissionRate: number,
  gatewayFeeRate: number = 0,
): CommissionInfo | null {
  if (!commissionRate || commissionRate <= 0) return null;
  if (amount < 0) throw new Error('Transaction amount cannot be negative');
  if (commissionRate < 0 || commissionRate > 1) throw new Error('Commission rate must be between 0 and 1');
  if (gatewayFeeRate < 0 || gatewayFeeRate > 1) throw new Error('Gateway fee rate must be between 0 and 1');

  const grossAmount = Math.round(amount * commissionRate);
  const gatewayFeeAmount = Math.round(amount * gatewayFeeRate);
  const netAmount = Math.max(0, grossAmount - gatewayFeeAmount);

  return { rate: commissionRate, grossAmount, gatewayFeeRate, gatewayFeeAmount, netAmount, status: 'pending' };
}

export function reverseCommission(
  originalCommission: CommissionInfo | null | undefined,
  originalAmount: number,
  refundAmount: number,
): CommissionInfo | null {
  if (!originalCommission?.netAmount) return null;
  if (!originalAmount || originalAmount <= 0) throw new Error('Original amount must be greater than 0');
  if (refundAmount < 0) throw new Error('Refund amount cannot be negative');
  if (refundAmount > originalAmount) throw new Error('Refund amount exceeds original amount');

  const refundRatio = refundAmount / originalAmount;
  return {
    rate: originalCommission.rate,
    grossAmount: Math.round(originalCommission.grossAmount * refundRatio),
    gatewayFeeRate: originalCommission.gatewayFeeRate,
    gatewayFeeAmount: Math.round(originalCommission.gatewayFeeAmount * refundRatio),
    netAmount: Math.round(originalCommission.netAmount * refundRatio),
    status: 'waived',
  };
}
