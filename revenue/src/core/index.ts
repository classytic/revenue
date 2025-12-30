/**
 * Core Module Exports
 * @classytic/revenue
 */

// ============ MAIN API ============
export {
  Revenue,
  RevenueBuilder,
  createRevenue,
  type RevenueOptions,
  type ModelsConfig,
  type ProvidersConfig,
} from './revenue.js';

export { Container } from './container.js';

// ============ RESULT TYPE ============
export {
  Result,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  map,
  mapErr,
  flatMap,
  tryCatch,
  tryCatchSync,
  all,
  match,
  type Ok,
  type Err,
} from './result.js';

// ============ EVENT SYSTEM ============
export {
  EventBus,
  createEventBus,
  type RevenueEvents,
  type BaseEvent,
  type PaymentVerifiedEvent,
  type PaymentFailedEvent,
  type PaymentRefundedEvent,
  type MonetizationCreatedEvent,
  type PurchaseCreatedEvent,
  type FreeCreatedEvent,
  type SubscriptionCreatedEvent,
  type SubscriptionActivatedEvent,
  type SubscriptionRenewedEvent,
  type SubscriptionCancelledEvent,
  type SubscriptionPausedEvent,
  type SubscriptionResumedEvent,
  type TransactionUpdatedEvent,
  type EscrowHeldEvent,
  type EscrowReleasedEvent,
  type EscrowCancelledEvent,
  type EscrowSplitEvent,
  type SettlementCreatedEvent,
  type SettlementScheduledEvent,
  type SettlementProcessingEvent,
  type SettlementCompletedEvent,
  type SettlementFailedEvent,
  type WebhookProcessedEvent,
} from './events.js';

// ============ PLUGIN SYSTEM ============
export {
  PluginManager,
  loggingPlugin,
  auditPlugin,
  metricsPlugin,
  definePlugin,
  type RevenuePlugin,
  type PluginContext,
  type PluginLogger,
  type PluginHooks,
  type HookFn,
} from './plugin.js';

// ============ STATE MACHINES ============
export {
  StateMachine,
  TRANSACTION_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
  HOLD_STATE_MACHINE,
  SPLIT_STATE_MACHINE,
} from './state-machine/index.js';

// ============ ERRORS ============
export * from './errors.js';
