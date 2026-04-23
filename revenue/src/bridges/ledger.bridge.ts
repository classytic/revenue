import type { RevenueContext } from '../core/context.js';

export interface LedgerBridge {
  onPaymentVerified?(transaction: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onRefundProcessed?(original: Record<string, unknown>, refund: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onSettlementCompleted?(settlement: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
}
