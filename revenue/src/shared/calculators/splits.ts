export interface SplitRule {
  type: string;
  recipientId: string;
  recipientType: string;
  rate: number;
}

export interface SplitInfo {
  type: string;
  recipientId: string;
  recipientType: string;
  rate: number;
  grossAmount: number;
  gatewayFeeRate: number;
  gatewayFeeAmount: number;
  netAmount: number;
  status: string;
}

export function calculateSplits(
  amount: number,
  rules: SplitRule[],
  gatewayFeeRate: number = 0,
): SplitInfo[] {
  const totalRate = rules.reduce((sum, r) => sum + r.rate, 0);
  if (totalRate > 1) throw new Error('Split rates exceed 100%');

  return rules.map((rule, index) => {
    const grossAmount = Math.round(amount * rule.rate);
    const feeAmount = index === 0 ? Math.round(amount * gatewayFeeRate) : 0;
    const netAmount = Math.max(0, grossAmount - feeAmount);
    return {
      type: rule.type,
      recipientId: rule.recipientId,
      recipientType: rule.recipientType,
      rate: rule.rate,
      grossAmount,
      gatewayFeeRate: index === 0 ? gatewayFeeRate : 0,
      gatewayFeeAmount: feeAmount,
      netAmount,
      status: 'pending',
    };
  });
}

export function calculateOrganizationPayout(amount: number, splits: SplitInfo[]): number {
  const splitTotal = splits.reduce((sum, s) => sum + s.grossAmount, 0);
  return amount - splitTotal;
}
