// ─── Engine ───
export { createRevenue } from './engine/create-revenue.js';
export type {
  RevenueConfig,
  RevenueEngine,
  RevenueContext,
  CommissionConfig,
  RetryConfig,
  BankFeedIndexConfig,
  BankFeedModuleConfig,
} from './engine/engine-types.js';

// ─── Events ───
// Transport shapes are plain `DomainEvent` / `EventTransport` / `EventHandler`,
// structurally identical to @classytic/arc so hosts can drop in any arc
// transport without an adapter. `InProcessRevenueBus` is the default fallback
// (~50-line match of arc's MemoryEventTransport). `createEvent` is the
// payload builder. See PACKAGE_RULES §11–§14.
export type { DomainEvent, EventHandler, EventTransport } from '@classytic/primitives/events';

// ─── Outbox (transactional event durability — host-composed) ────────────────
// Re-exports the OutboxStore contract from @classytic/primitives/outbox so
// hosts can wire any compatible implementation (arc's MongoOutboxStore,
// custom Kafka-backed store, etc.) without an adapter — see PACKAGE_RULES
// §5.5 + §P8. Ships `MemoryOutboxStore` for tests + dev wiring; production
// durability belongs to the host. Revenue's `dispatch()` helper
// ([`src/repositories/base.repository.ts`](src/repositories/base.repository.ts#L175))
// calls `outbox.save(event, { session })` BEFORE `events.publish(event)`
// when an outbox is wired; otherwise events flow only to `eventTransport`.
export type {
  OutboxStore,
  OutboxWriteOptions,
  OutboxClaimOptions,
  OutboxAcknowledgeOptions,
  OutboxFailOptions,
  OutboxFailureContext,
  OutboxFailureDecision,
  OutboxFailurePolicy,
  OutboxErrorInfo,
} from '@classytic/primitives/outbox';
export {
  InvalidOutboxEventError,
  OutboxOwnershipError,
} from '@classytic/primitives/outbox';
export { MemoryOutboxStore } from './events/outbox-store.js';
export { InProcessRevenueBus } from './events/in-process-bus.js';
export type { InProcessRevenueBusOptions } from './events/in-process-bus.js';
export { createEvent } from './events/helpers.js';
export { REVENUE_EVENTS, type RevenueEventName } from './events/event-constants.js';

// Arc 2.10 EventRegistry catalog — Zod-backed definitions + JSON Schemas
// derived via `z.toJSONSchema()`. See PACKAGE_RULES §18.5.
export { revenueEventDefinitions } from './events/revenue-event-catalog.js';
export type {
  RevenueEventDefinition,
  RevenueEventPayloadOf,
  RevenueEventSchema,
} from './events/revenue-event-catalog.js';

// ─── Enums ───
export * from './enums/transaction.enums.js';
export * from './enums/payment.enums.js';
export * from './enums/subscription.enums.js';
export * from './enums/monetization.enums.js';
export * from './enums/escrow.enums.js';
export * from './enums/split.enums.js';
export * from './enums/settlement.enums.js';
export * from './enums/bank-feed.enums.js';

// ─── Models ───
export type { RevenueModels, RevenueSchemaOptions } from './models/create-models.js';
export type { TransactionDocument } from './models/transaction.schema.js';
export type { SubscriptionDocument } from './models/subscription.schema.js';
export type { SettlementDocument } from './models/settlement.schema.js';

// ─── Repositories ───
export { TransactionRepository } from './repositories/transaction.repository.js';
export { SubscriptionRepository } from './repositories/subscription.repository.js';
export { SettlementRepository } from './repositories/settlement.repository.js';
export type { RecipientBalance } from './repositories/settlement.repository.js';
export type { RevenueRepositories, RepositoryPluginBundle } from './repositories/create-repositories.js';

// ─── Providers ───
// Revenue owns only the abstract `PaymentProvider` contract + the registry.
// All payment-gateway data shapes (`CreateIntentParams`, `PaymentIntent`,
// `PaymentResult`, `RefundResult`, `WebhookEvent`, `ProviderCapabilities`)
// live in `@classytic/primitives/payment-gateway`. Hosts and provider
// packages MUST import them from primitives directly — no re-exports
// here per PACKAGE_RULES P2 (subpath imports only, barrels hurt
// tree-shaking and the dep graph).
//
//   import type {
//     CreateIntentParams, PaymentIntent, PaymentResult,
//     RefundResult, WebhookEvent, ProviderCapabilities,
//   } from '@classytic/primitives/payment-gateway';
export { PaymentProvider } from './providers/base.js';
export { ProviderRegistry, createProviderRegistry } from './providers/registry.js';

// ─── Bank-feed providers (3.0) ───
export {
  BankFeedProvider,
  BankFeedProviderRegistry,
  createBankFeedProviderRegistry,
} from './providers/bank-feed.js';
export type {
  BankFeedProviderCapabilities,
  FetchTransactionsParams,
  FetchTransactionsResult,
  ParseUploadParams,
  ParseUploadResult,
} from './providers/bank-feed.js';

// Canonical bank-transaction shapes (3.0) — owned by primitives, not
// revenue. Hosts that need these types import directly from primitives:
//
//   import type { BankTransaction, BankStatement, BankCounterparty } from '@classytic/primitives/bank-transaction';
//   import type { Money } from '@classytic/primitives/money';
//
// We intentionally don't re-export them here — barrels hurt tree-shaking
// (PACKAGE_RULES P2). Subpath imports keep the dep graph honest.

// ─── Bridges ───
export type { RevenueBridges } from './bridges/revenue-bridges.js';
export type { LedgerBridge } from './bridges/ledger.bridge.js';
export type { TaxBridge } from './bridges/tax.bridge.js';
export type { NotificationBridge } from './bridges/notification.bridge.js';
export type { CurrencyBridge } from './bridges/currency.bridge.js';
export type { CustomerBridge } from './bridges/customer.bridge.js';
export type { AnalyticsBridge } from './bridges/analytics.bridge.js';

// ─── Validators ───
export * from './validators/transaction.schema.js';
export * from './validators/subscription.schema.js';
export * from './validators/settlement.schema.js';
export * from './validators/payment.schema.js';
export * from './validators/escrow.schema.js';

// ─── Core ───
export {
  StateMachine,
  TRANSACTION_STATE_MACHINE,
  PAYMENT_FLOW_STATE_MACHINE,
  BANK_FEED_STATE_MACHINE,
  MANUAL_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
  HOLD_STATE_MACHINE,
  SPLIT_STATE_MACHINE,
  smFor,
} from './core/state-machines.js';
export type { StateChangeEvent } from './core/state-machines.js';
export * from './core/errors.js';
export { ok, err, isOk, isErr, type Result } from '@classytic/primitives/result';

// ─── Shared ───
export { calculateCommission, reverseCommission, type CommissionInfo } from './shared/calculators/commission.js';
export { calculateTax, getTaxType, reverseTax, validateTaxCalculation, type TaxConfig, type TaxCalculation, type TaxType } from './shared/calculators/tax.js';
export { calculateSplits, calculateOrganizationPayout, type SplitRule, type SplitInfo } from './shared/calculators/splits.js';
export {
  type Money,
  type MoneyValue,
  money,
  fromMajor,
  toMajor,
  addMoney,
  subtractMoney,
  multiplyMoney,
  sumMoney,
  equalsMoney,
  compareMoney,
  isZeroMoney,
  isPositiveMoney,
  isNegativeMoney,
  negateMoney,
  absMoney,
  isMoney,
  CurrencyMismatchError,
  CURRENCIES,
  MINOR_UNIT_FACTOR,
  minorUnitFactor,
  toCurrencyCode,
  isCurrencyCode,
  type CurrencyCode,
  toSmallestUnit,
  fromSmallestUnit,
} from './shared/formatters/money.js';
export { appendAuditEvent, getAuditTrail, getLastStateChange } from './shared/audit.js';

// ─── Plugins ───
export { PluginManager, type RevenuePluginDefinition, type PluginContext, type HookHandler } from './plugins/plugin.interface.js';
