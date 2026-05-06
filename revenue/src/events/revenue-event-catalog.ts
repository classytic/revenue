/**
 * Revenue event catalog — Zod-source-of-truth definitions for every
 * `revenue:*` event.
 *
 * Each definition exposes:
 *   - `.zodSchema`   — source of truth, used by host code's `.safeParse()`
 *   - `.schema`      — JSON Schema derived via `z.toJSONSchema()`, consumed
 *                     by Arc's EventRegistry + OpenAPI plugin
 *   - `.create(...)` — DomainEvent envelope builder, structurally compatible
 *                     with `@classytic/arc`'s `EventDefinitionOutput`
 *
 * Structurally compatible with Arc 2.10's `EventRegistry` — hosts register
 * `revenueEventDefinitions` directly, no adapter code. Revenue does NOT
 * import from `@classytic/arc` (PACKAGE_RULES §11); compatibility is purely
 * structural.
 *
 * Payload shapes reflect what the repositories actually emit today:
 * domain documents (transactions, subscriptions, settlements) are modelled
 * as structured objects with key business fields required and a passthrough
 * escape hatch for fields host code doesn't care about at validation time.
 * See PACKAGE_RULES §18.5 for the full pattern.
 *
 * @example Wiring into an Arc app
 * ```ts
 * import { createEventRegistry } from '@classytic/arc/events';
 * import { revenueEventDefinitions } from '@classytic/revenue/events';
 *
 * const registry = createEventRegistry();
 * for (const def of revenueEventDefinitions) registry.register(def);
 *
 * const app = await createApp({
 *   arcPlugins: { events: { registry, validateMode: 'reject' } },
 * });
 * ```
 */
import { z } from 'zod';
import type { DomainEvent } from '@classytic/primitives/events';
import { createEvent as createPrimitiveEvent } from '@classytic/primitives/events';
import { REVENUE_EVENTS } from './event-constants.js';

// ─── Definition shape (structurally compatible with Arc EventRegistry) ────

export interface RevenueEventSchema {
  type: 'object';
  properties?: Record<string, { type?: string; format?: string; [key: string]: unknown }>;
  required?: string[];
  [key: string]: unknown;
}

export interface RevenueEventDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly schema: RevenueEventSchema;
  readonly zodSchema: TSchema;
  create(
    payload: z.infer<TSchema>,
    meta?: Partial<DomainEvent['meta']>,
  ): DomainEvent<z.infer<TSchema>>;
  readonly __payload?: z.infer<TSchema>;
}

export type RevenueEventPayloadOf<D> =
  D extends RevenueEventDefinition<infer S> ? z.infer<S> : never;

function defineRevenueEvent<TSchema extends z.ZodType>(input: {
  name: string;
  version?: number;
  description?: string;
  zodSchema: TSchema;
}): RevenueEventDefinition<TSchema> {
  const { name, version = 1, description, zodSchema } = input;
  return {
    name,
    version,
    description,
    schema: z.toJSONSchema(zodSchema) as RevenueEventSchema,
    zodSchema,
    create(payload, meta) {
      return createPrimitiveEvent(name, payload, { resource: 'revenue', ...meta });
    },
  };
}

// ─── Reusable fragments ───────────────────────────────────────────────────

const money = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
});

// Domain documents are attached raw (repositories pass Mongoose docs). Hosts
// that need strict validation can narrow via `passthrough` — we require the
// headline identity fields so subscribers can route + log without parsing
// the full blob.
const transactionRef = z.object({
  _id: z.union([z.string(), z.any()]).optional(),
  publicId: z.string().optional(),
  status: z.string().optional(),
  monetizationType: z.string().optional(),
  amount: money.optional(),
}).passthrough();

const subscriptionRef = z.object({
  _id: z.union([z.string(), z.any()]).optional(),
  publicId: z.string().optional(),
  status: z.string().optional(),
  planId: z.string().optional(),
  customerId: z.string().optional(),
}).passthrough();

const settlementRef = z.object({
  _id: z.union([z.string(), z.any()]).optional(),
  publicId: z.string().optional(),
  status: z.string().optional(),
  totalAmount: money.optional(),
  payoutMethod: z.string().optional(),
}).passthrough();

// ─── Payment ──────────────────────────────────────────────────────────────

const paymentVerifiedSchema = z.object({
  transaction: transactionRef,
  paymentResult: z.record(z.string(), z.unknown()).optional(),
  verifiedBy: z.string().optional(),
});

const paymentFailedSchema = z.object({
  transaction: transactionRef,
  paymentResult: z.record(z.string(), z.unknown()).optional(),
  verifiedBy: z.string().optional(),
});

const paymentProcessingSchema = z.object({
  transaction: transactionRef,
  paymentResult: z.record(z.string(), z.unknown()).optional(),
  verifiedBy: z.string().optional(),
});

const paymentRequiresActionSchema = z.object({
  transaction: transactionRef,
  paymentResult: z.record(z.string(), z.unknown()).optional(),
  verifiedBy: z.string().optional(),
});

const paymentRefundedSchema = z.object({
  transaction: transactionRef,
  refundTransaction: transactionRef,
  refundAmount: money,
  reason: z.string().optional(),
  isPartialRefund: z.boolean(),
});

// ─── Monetization / purchase / free ──────────────────────────────────────

const monetizationCreatedSchema = z.object({
  monetizationType: z.string(),
  transaction: transactionRef,
});

// Hosts that split one-shot purchases from free grants emit these; same
// shape as the generic `monetization.created` event so downstream consumers
// don't have to branch.
const purchaseCreatedSchema = monetizationCreatedSchema;
const freeCreatedSchema = monetizationCreatedSchema;

// ─── Transaction (generic updates, host-emitted) ─────────────────────────

const transactionUpdatedSchema = z.object({
  transaction: transactionRef,
  changedFields: z.array(z.string()).optional(),
});

// ─── Subscription ────────────────────────────────────────────────────────

const subscriptionCreatedSchema = z.object({
  subscription: subscriptionRef,
});

const subscriptionActivatedSchema = z.object({
  subscription: subscriptionRef,
  activatedAt: z.iso.datetime(),
});

const subscriptionRenewedSchema = z.object({
  subscription: subscriptionRef,
  renewedAt: z.iso.datetime(),
  nextPeriodStart: z.iso.datetime().optional(),
  nextPeriodEnd: z.iso.datetime().optional(),
});

const subscriptionCancelledSchema = z.object({
  subscription: subscriptionRef,
  immediate: z.boolean().optional(),
  reason: z.string().optional(),
});

const subscriptionPausedSchema = z.object({
  subscription: subscriptionRef,
  reason: z.string().optional(),
});

const subscriptionResumedSchema = z.object({
  subscription: subscriptionRef,
  extendPeriod: z.boolean().optional(),
});

// ─── Escrow ──────────────────────────────────────────────────────────────

const escrowHeldSchema = z.object({
  transaction: transactionRef,
  heldAmount: money,
  reason: z.string().optional(),
});

const escrowReleasedSchema = z.object({
  transaction: transactionRef,
  releaseAmount: money,
  recipientId: z.string().optional(),
  recipientType: z.string().optional(),
  isFullRelease: z.boolean(),
  isPartialRelease: z.boolean(),
});

const escrowCancelledSchema = z.object({
  transaction: transactionRef,
  cancelledAmount: money.optional(),
  reason: z.string().optional(),
});

const escrowSplitSchema = z.object({
  transaction: transactionRef,
  splits: z.array(
    z.object({
      recipientId: z.string(),
      recipientType: z.string().optional(),
      amount: money,
    }).passthrough(),
  ),
  organizationPayout: money.optional(),
});

// ─── Settlement ──────────────────────────────────────────────────────────

const settlementCreatedSchema = z.object({
  settlement: settlementRef,
});

const settlementScheduledSchema = z.object({
  settlement: settlementRef,
  scheduledAt: z.iso.datetime(),
});

const settlementProcessingSchema = z.object({
  settlement: settlementRef,
  processedAt: z.iso.datetime(),
});

const settlementCompletedSchema = z.object({
  settlement: settlementRef,
  completedAt: z.iso.datetime(),
});

const settlementFailedSchema = z.object({
  settlement: settlementRef,
  reason: z.string(),
  code: z.string().optional(),
  retry: z.boolean().optional(),
});

// ─── Webhook ─────────────────────────────────────────────────────────────

const webhookProcessedSchema = z.object({
  webhookType: z.string(),
  provider: z.string(),
  event: z.record(z.string(), z.unknown()),
  transaction: transactionRef.optional(),
});

// ─── Bank feed / accounting feed (3.0) ───────────────────────────────────

const transactionImportedSchema = z.object({
  transaction: transactionRef,
  source: z.string(),
  bankAccountId: z.string(),
  externalId: z.string(),
});

const transactionMatchedSchema = z.object({
  transaction: transactionRef,
  mapping: z.object({
    debitAccount: z.string().optional(),
    creditAccount: z.string().optional(),
    notes: z.string().optional(),
  }).passthrough(),
  relatedTransactionId: z.string().optional(),
  matchedBy: z.string().optional(),
});

const transactionUnmatchedSchema = z.object({
  transaction: transactionRef,
  unmatchedBy: z.string().optional(),
});

const transactionJournalizedSchema = z.object({
  transaction: transactionRef,
  journalEntryRef: z.object({
    type: z.string(),
    id: z.string(),
  }),
  journalizedBy: z.string().optional(),
});

const transactionRejectedSchema = z.object({
  transaction: transactionRef,
  reason: z.string().min(1),
  rejectedBy: z.string().optional(),
});

// Plaid `removed[]` array — entries the upstream feed has retracted.
// We soft-delete and emit one of these per row so subscribers can
// reconcile downstream materialized views.
const transactionRemovedByFeedSchema = z.object({
  transaction: transactionRef,
  source: z.string(),
  externalId: z.string(),
});

// ─── Inferred payload types (exported for host subscribers) ──────────────

export type PaymentVerifiedPayload = z.infer<typeof paymentVerifiedSchema>;
export type PaymentFailedPayload = z.infer<typeof paymentFailedSchema>;
export type PaymentProcessingPayload = z.infer<typeof paymentProcessingSchema>;
export type PaymentRequiresActionPayload = z.infer<typeof paymentRequiresActionSchema>;
export type PaymentRefundedPayload = z.infer<typeof paymentRefundedSchema>;
export type MonetizationCreatedPayload = z.infer<typeof monetizationCreatedSchema>;
export type PurchaseCreatedPayload = z.infer<typeof purchaseCreatedSchema>;
export type FreeCreatedPayload = z.infer<typeof freeCreatedSchema>;
export type TransactionUpdatedPayload = z.infer<typeof transactionUpdatedSchema>;
export type SubscriptionCreatedPayload = z.infer<typeof subscriptionCreatedSchema>;
export type SubscriptionActivatedPayload = z.infer<typeof subscriptionActivatedSchema>;
export type SubscriptionRenewedPayload = z.infer<typeof subscriptionRenewedSchema>;
export type SubscriptionCancelledPayload = z.infer<typeof subscriptionCancelledSchema>;
export type SubscriptionPausedPayload = z.infer<typeof subscriptionPausedSchema>;
export type SubscriptionResumedPayload = z.infer<typeof subscriptionResumedSchema>;
export type EscrowHeldPayload = z.infer<typeof escrowHeldSchema>;
export type EscrowReleasedPayload = z.infer<typeof escrowReleasedSchema>;
export type EscrowCancelledPayload = z.infer<typeof escrowCancelledSchema>;
export type EscrowSplitPayload = z.infer<typeof escrowSplitSchema>;
export type SettlementCreatedPayload = z.infer<typeof settlementCreatedSchema>;
export type SettlementScheduledPayload = z.infer<typeof settlementScheduledSchema>;
export type SettlementProcessingPayload = z.infer<typeof settlementProcessingSchema>;
export type SettlementCompletedPayload = z.infer<typeof settlementCompletedSchema>;
export type SettlementFailedPayload = z.infer<typeof settlementFailedSchema>;
export type WebhookProcessedPayload = z.infer<typeof webhookProcessedSchema>;
export type TransactionImportedPayload = z.infer<typeof transactionImportedSchema>;
export type TransactionMatchedPayload = z.infer<typeof transactionMatchedSchema>;
export type TransactionUnmatchedPayload = z.infer<typeof transactionUnmatchedSchema>;
export type TransactionJournalizedPayload = z.infer<typeof transactionJournalizedSchema>;
export type TransactionRejectedPayload = z.infer<typeof transactionRejectedSchema>;
export type TransactionRemovedByFeedPayload = z.infer<typeof transactionRemovedByFeedSchema>;

// ─── Event definitions ────────────────────────────────────────────────────

export const PaymentVerified = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_VERIFIED,
  description: 'A payment transaction was verified by its provider.',
  zodSchema: paymentVerifiedSchema,
});

export const PaymentFailed = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_FAILED,
  description: 'A payment verification failed.',
  zodSchema: paymentFailedSchema,
});

export const PaymentProcessing = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_PROCESSING,
  description: 'A payment entered an in-progress state at the provider.',
  zodSchema: paymentProcessingSchema,
});

export const PaymentRequiresAction = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_REQUIRES_ACTION,
  description: 'A payment requires additional customer action (3DS, OTP, etc.).',
  zodSchema: paymentRequiresActionSchema,
});

export const PaymentRefunded = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_REFUNDED,
  description: 'A payment transaction was (partially or fully) refunded.',
  zodSchema: paymentRefundedSchema,
});

export const MonetizationCreated = defineRevenueEvent({
  name: REVENUE_EVENTS.MONETIZATION_CREATED,
  description: 'A monetization transaction (purchase, free grant, …) was created.',
  zodSchema: monetizationCreatedSchema,
});

export const PurchaseCreated = defineRevenueEvent({
  name: REVENUE_EVENTS.PURCHASE_CREATED,
  description: 'A one-shot purchase transaction was created.',
  zodSchema: purchaseCreatedSchema,
});

export const FreeCreated = defineRevenueEvent({
  name: REVENUE_EVENTS.FREE_CREATED,
  description: 'A free (zero-cost) transaction was granted.',
  zodSchema: freeCreatedSchema,
});

export const TransactionUpdated = defineRevenueEvent({
  name: REVENUE_EVENTS.TRANSACTION_UPDATED,
  description: 'Generic host-level update on a transaction record.',
  zodSchema: transactionUpdatedSchema,
});

export const SubscriptionCreated = defineRevenueEvent({
  name: REVENUE_EVENTS.SUBSCRIPTION_CREATED,
  description: 'A subscription was created (before first activation).',
  zodSchema: subscriptionCreatedSchema,
});

export const SubscriptionActivated = defineRevenueEvent({
  name: REVENUE_EVENTS.SUBSCRIPTION_ACTIVATED,
  description: 'A subscription became active (first successful charge).',
  zodSchema: subscriptionActivatedSchema,
});

export const SubscriptionRenewed = defineRevenueEvent({
  name: REVENUE_EVENTS.SUBSCRIPTION_RENEWED,
  description: 'A subscription renewal cycle succeeded.',
  zodSchema: subscriptionRenewedSchema,
});

export const SubscriptionCancelled = defineRevenueEvent({
  name: REVENUE_EVENTS.SUBSCRIPTION_CANCELLED,
  description: 'A subscription was cancelled (immediate or end-of-period).',
  zodSchema: subscriptionCancelledSchema,
});

export const SubscriptionPaused = defineRevenueEvent({
  name: REVENUE_EVENTS.SUBSCRIPTION_PAUSED,
  description: 'A subscription was paused.',
  zodSchema: subscriptionPausedSchema,
});

export const SubscriptionResumed = defineRevenueEvent({
  name: REVENUE_EVENTS.SUBSCRIPTION_RESUMED,
  description: 'A paused subscription was resumed.',
  zodSchema: subscriptionResumedSchema,
});

export const EscrowHeld = defineRevenueEvent({
  name: REVENUE_EVENTS.ESCROW_HELD,
  description: 'An amount was placed into escrow against a transaction.',
  zodSchema: escrowHeldSchema,
});

export const EscrowReleased = defineRevenueEvent({
  name: REVENUE_EVENTS.ESCROW_RELEASED,
  description: 'Escrow was released (full or partial) to a recipient.',
  zodSchema: escrowReleasedSchema,
});

export const EscrowCancelled = defineRevenueEvent({
  name: REVENUE_EVENTS.ESCROW_CANCELLED,
  description: 'An escrow hold was cancelled and funds returned.',
  zodSchema: escrowCancelledSchema,
});

export const EscrowSplit = defineRevenueEvent({
  name: REVENUE_EVENTS.ESCROW_SPLIT,
  description: 'Escrow was split across multiple recipients.',
  zodSchema: escrowSplitSchema,
});

export const SettlementCreated = defineRevenueEvent({
  name: REVENUE_EVENTS.SETTLEMENT_CREATED,
  description: 'A settlement record was created.',
  zodSchema: settlementCreatedSchema,
});

export const SettlementScheduled = defineRevenueEvent({
  name: REVENUE_EVENTS.SETTLEMENT_SCHEDULED,
  description: 'A settlement was scheduled for a future payout.',
  zodSchema: settlementScheduledSchema,
});

export const SettlementProcessing = defineRevenueEvent({
  name: REVENUE_EVENTS.SETTLEMENT_PROCESSING,
  description: 'A settlement entered the processing phase.',
  zodSchema: settlementProcessingSchema,
});

export const SettlementCompleted = defineRevenueEvent({
  name: REVENUE_EVENTS.SETTLEMENT_COMPLETED,
  description: 'A settlement completed successfully.',
  zodSchema: settlementCompletedSchema,
});

export const SettlementFailed = defineRevenueEvent({
  name: REVENUE_EVENTS.SETTLEMENT_FAILED,
  description: 'A settlement failed during processing.',
  zodSchema: settlementFailedSchema,
});

export const WebhookProcessed = defineRevenueEvent({
  name: REVENUE_EVENTS.WEBHOOK_PROCESSED,
  description: 'A provider webhook was processed by the revenue engine.',
  zodSchema: webhookProcessedSchema,
});

// ─── Bank feed / accounting feed (3.0) ──────────────────────────────────

export const TransactionImported = defineRevenueEvent({
  name: REVENUE_EVENTS.TRANSACTION_IMPORTED,
  description: 'A bank-feed / accounting-feed row was imported.',
  zodSchema: transactionImportedSchema,
});

export const TransactionMatched = defineRevenueEvent({
  name: REVENUE_EVENTS.TRANSACTION_MATCHED,
  description: 'A bank-feed / manual transaction was matched to GL accounts (and optionally to an upstream payment-flow row).',
  zodSchema: transactionMatchedSchema,
});

export const TransactionUnmatched = defineRevenueEvent({
  name: REVENUE_EVENTS.TRANSACTION_UNMATCHED,
  description: 'A previously-matched bank-feed transaction was reverted to the imported state.',
  zodSchema: transactionUnmatchedSchema,
});

export const TransactionJournalized = defineRevenueEvent({
  name: REVENUE_EVENTS.TRANSACTION_JOURNALIZED,
  description: 'A bank-feed / manual transaction was journalized — the host LedgerBridge produced a journal entry.',
  zodSchema: transactionJournalizedSchema,
});

export const TransactionRejected = defineRevenueEvent({
  name: REVENUE_EVENTS.TRANSACTION_REJECTED,
  description: 'A bank-feed / manual transaction was rejected (operator skip — typically a duplicate / non-cash entry).',
  zodSchema: transactionRejectedSchema,
});

export const TransactionRemovedByFeed = defineRevenueEvent({
  name: REVENUE_EVENTS.TRANSACTION_REMOVED_BY_FEED,
  description: 'The upstream feed retracted a previously-imported row (Plaid `removed[]`, OFX correction). The row is soft-deleted.',
  zodSchema: transactionRemovedByFeedSchema,
});

// ─── Aggregate catalog ────────────────────────────────────────────────────

/**
 * Every revenue event defined in the package — pass to Arc's
 * `EventRegistry`. Hosts wire ONE array; the whole `revenue:*` namespace
 * becomes introspectable via OpenAPI and auto-validated at publish time
 * when `eventPlugin({ validateMode: 'reject' })` is set.
 */
export const revenueEventDefinitions: ReadonlyArray<RevenueEventDefinition> = [
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
];
