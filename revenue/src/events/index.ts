/**
 * Revenue events — transport shape + in-process fallback + name constants
 * + createEvent helper. Five files total per PACKAGE_RULES §13.
 *
 * Usage:
 *
 *   // Accept any arc-compatible transport, default to the local fallback
 *   const revenue = await createRevenue({
 *     connection: mongoose.connection,
 *     eventTransport: new MemoryEventTransport(), // from @classytic/arc
 *   });
 *
 *   // Glob-subscribe like any arc transport
 *   await revenue.events.subscribe('revenue:payment.*', async (event) => {
 *     await ledger.onPayment(event);
 *   });
 */

export type { DomainEvent, EventHandler, EventTransport } from '@classytic/primitives/events';
export { InProcessRevenueBus, type InProcessRevenueBusOptions } from './in-process-bus.js';
export { createEvent } from './helpers.js';
export { REVENUE_EVENTS, type RevenueEventName } from './event-constants.js';

// Arc 2.10 EventRegistry catalog — Zod-backed definitions with JSON Schema
// derived via `z.toJSONSchema()`. See PACKAGE_RULES §18.5. Hosts register
// `revenueEventDefinitions` directly with Arc's registry.
export {
  revenueEventDefinitions,
  PaymentVerified,
  PaymentFailed,
  PaymentProcessing,
  PaymentRequiresAction,
  PaymentRefunded,
  MonetizationCreated,
  PurchaseCreated,
  FreeCreated,
  TransactionUpdated,
  SubscriptionCreated,
  SubscriptionActivated,
  SubscriptionRenewed,
  SubscriptionCancelled,
  SubscriptionPaused,
  SubscriptionResumed,
  EscrowHeld,
  EscrowReleased,
  EscrowCancelled,
  EscrowSplit,
  SettlementCreated,
  SettlementScheduled,
  SettlementProcessing,
  SettlementCompleted,
  SettlementFailed,
  WebhookProcessed,
  // Bank feed / accounting feed (3.0)
  TransactionImported,
  TransactionMatched,
  TransactionUnmatched,
  TransactionJournalized,
  TransactionRejected,
  TransactionRemovedByFeed,
} from './revenue-event-catalog.js';
export type {
  RevenueEventDefinition,
  RevenueEventPayloadOf,
  RevenueEventSchema,
  PaymentVerifiedPayload,
  PaymentFailedPayload,
  PaymentProcessingPayload,
  PaymentRequiresActionPayload,
  PaymentRefundedPayload,
  MonetizationCreatedPayload,
  PurchaseCreatedPayload,
  FreeCreatedPayload,
  TransactionUpdatedPayload,
  SubscriptionCreatedPayload,
  SubscriptionActivatedPayload,
  SubscriptionRenewedPayload,
  SubscriptionCancelledPayload,
  SubscriptionPausedPayload,
  SubscriptionResumedPayload,
  EscrowHeldPayload,
  EscrowReleasedPayload,
  EscrowCancelledPayload,
  EscrowSplitPayload,
  SettlementCreatedPayload,
  SettlementScheduledPayload,
  SettlementProcessingPayload,
  SettlementCompletedPayload,
  SettlementFailedPayload,
  WebhookProcessedPayload,
  TransactionImportedPayload,
  TransactionMatchedPayload,
  TransactionUnmatchedPayload,
  TransactionJournalizedPayload,
  TransactionRejectedPayload,
  TransactionRemovedByFeedPayload,
} from './revenue-event-catalog.js';
