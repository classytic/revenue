import type { RevenueContext } from '../core/context.js';

export interface NotificationBridge {
  onPaymentVerified?(transaction: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onRefundProcessed?(transaction: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onSubscriptionCreated?(subscription: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onSubscriptionCancelled?(subscription: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onSettlementCompleted?(settlement: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
}
