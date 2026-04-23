export const REVENUE_EVENTS = {
  // Payment
  PAYMENT_VERIFIED: 'revenue:payment.verified',
  PAYMENT_FAILED: 'revenue:payment.failed',
  PAYMENT_REFUNDED: 'revenue:payment.refunded',
  PAYMENT_REQUIRES_ACTION: 'revenue:payment.requires_action',
  PAYMENT_PROCESSING: 'revenue:payment.processing',
  // Monetization
  MONETIZATION_CREATED: 'revenue:monetization.created',
  PURCHASE_CREATED: 'revenue:purchase.created',
  FREE_CREATED: 'revenue:free.created',
  // Subscription
  SUBSCRIPTION_CREATED: 'revenue:subscription.created',
  SUBSCRIPTION_ACTIVATED: 'revenue:subscription.activated',
  SUBSCRIPTION_RENEWED: 'revenue:subscription.renewed',
  SUBSCRIPTION_CANCELLED: 'revenue:subscription.cancelled',
  SUBSCRIPTION_PAUSED: 'revenue:subscription.paused',
  SUBSCRIPTION_RESUMED: 'revenue:subscription.resumed',
  // Transaction
  TRANSACTION_UPDATED: 'revenue:transaction.updated',
  // Escrow
  ESCROW_HELD: 'revenue:escrow.held',
  ESCROW_RELEASED: 'revenue:escrow.released',
  ESCROW_CANCELLED: 'revenue:escrow.cancelled',
  ESCROW_SPLIT: 'revenue:escrow.split',
  // Settlement
  SETTLEMENT_CREATED: 'revenue:settlement.created',
  SETTLEMENT_SCHEDULED: 'revenue:settlement.scheduled',
  SETTLEMENT_PROCESSING: 'revenue:settlement.processing',
  SETTLEMENT_COMPLETED: 'revenue:settlement.completed',
  SETTLEMENT_FAILED: 'revenue:settlement.failed',
  // Webhook
  WEBHOOK_PROCESSED: 'revenue:webhook.processed',
} as const;

export type RevenueEventName = typeof REVENUE_EVENTS[keyof typeof REVENUE_EVENTS];
