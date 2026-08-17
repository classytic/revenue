export const REVENUE_EVENTS = {
  // Payment
  /**
   * RETIRED in 4.0.0 — `PAYMENT_VERIFIED`, `PAYMENT_FAILED`, `PAYMENT_REFUNDED`.
   *
   * These were portable payment OUTCOMES carrying revenue's own document shape.
   * They now publish the canonical `@classytic/primitives/payment-events`
   * contract as `payment.succeeded` / `payment.failed` / `payment.refunded`,
   * built by `events/canonical-payment-events.ts`.
   *
   * The constants are DELETED rather than deprecated: a name nothing emits is a
   * stream a host can still bind a handler to, and that handler never fires and
   * never errors. There is no alias and no compatibility projector — one
   * authoritative fact per outcome, or a consumer subscribed to both processes
   * the same refund twice.
   *
   * The intermediate states below are NOT outcomes and keep their names.
   */
  PAYMENT_REQUIRES_ACTION: 'revenue:payment.requires_action',
  PAYMENT_PROCESSING: 'revenue:payment.processing',
  PAYMENT_AUTHORIZED: 'revenue:payment.authorized',
  PAYMENT_CAPTURED: 'revenue:payment.captured',
  PAYMENT_AUTH_VOIDED: 'revenue:payment.auth_voided',
  PAYMENT_DISPUTED: 'revenue:payment.disputed',
  PAYMENT_DISPUTE_WON: 'revenue:payment.dispute_won',
  PAYMENT_DISPUTE_LOST: 'revenue:payment.dispute_lost',
  PAYMENT_SETTLED: 'revenue:payment.settled',
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
  // Bank feed / accounting feed (3.0)
  TRANSACTION_IMPORTED: 'revenue:transaction.imported',
  TRANSACTION_MATCHED: 'revenue:transaction.matched',
  TRANSACTION_UNMATCHED: 'revenue:transaction.unmatched',
  TRANSACTION_JOURNALIZED: 'revenue:transaction.journalized',
  TRANSACTION_REJECTED: 'revenue:transaction.rejected',
  TRANSACTION_REMOVED_BY_FEED: 'revenue:transaction.removed_by_feed',
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
