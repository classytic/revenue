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
import { PAYMENT_EVENT_TYPE } from '@classytic/primitives/payment-events';
import { CURRENCY_PATTERN } from '@classytic/primitives/currency';
import { z } from 'zod';
import type { DomainEvent } from '@classytic/primitives/events';
import { createEvent as createPrimitiveEvent } from '@classytic/primitives/events';
import {
  PAYMENT_METHOD_KIND,
  type PaymentMethodKind,
} from '@classytic/primitives/payment-method-kind';
import { REVENUE_EVENTS } from './event-constants.js';

const PAYMENT_METHOD_KIND_VALUES = Object.values(PAYMENT_METHOD_KIND) as [
  PaymentMethodKind,
  ...PaymentMethodKind[],
];

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
    /**
     * `unrepresentable: 'any'` — the DOCUMENTATION projection must never
     * constrain the VALIDATION contract.
     *
     * This ran with zod's defaults, i.e. `unrepresentable: 'throw'`, and it runs
     * EAGERLY at module load: one `z.date()` anywhere in any event schema below
     * threw `Date cannot be represented in JSON Schema` at import and took the
     * whole package down. So the schemas were written to whatever this line
     * tolerated rather than to what the transport actually delivers — and that
     * is how `canonicalInstant` was narrowed from a working union to a
     * string-only form that rejects every event this system emits (see its
     * docblock).
     *
     * `schema` is the human/registry-facing JSON Schema; `zodSchema` is the
     * source of truth every `.safeParse()` uses. Under `'any'`, a type JSON
     * Schema cannot express degrades to `{}` in the DOCS while runtime
     * validation stays exact — which is the correct trade in that order. This
     * matches what `@classytic/arc`'s own converter does for every non-throw
     * mode.
     */
    schema: z.toJSONSchema(zodSchema, { unrepresentable: 'any' }) as RevenueEventSchema,
    zodSchema,
    create(payload, meta) {
      return createPrimitiveEvent(name, payload, { resource: 'revenue', ...meta });
    },
  };
}

// ─── Reusable fragments ───────────────────────────────────────────────────

const money = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(CURRENCY_PATTERN, 'ISO 4217 (3 uppercase letters)'),
});

// Domain documents are attached raw (repositories pass Mongoose docs). Hosts
// that need strict validation can narrow via `passthrough` — every field is
// optional because this is a REF: subscribers route + log off whatever
// identity fields are present and re-fetch the authoritative doc by id.
// (2.8.2) `amount` on a transaction DOC is a plain minor-unit number — the
// old `money`-shaped requirement rejected every real emission; `methodKind`
// was required, which broke host-published test fixtures carrying only `_id`.
const transactionRef = z.object({
  _id: z.union([z.string(), z.any()]).optional(),
  publicId: z.string().optional(),
  status: z.string().optional(),
  monetizationType: z.string().optional(),
  amount: z.union([z.number(), money]).optional(),
  methodKind: z.enum(PAYMENT_METHOD_KIND_VALUES).optional(),
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

// (2.8.2) Aligned with what `refund()` ACTUALLY dispatches:
// `{ transaction, refundTransaction, refundAmount: number, reason?, isPartialRefund }`.
// The old shape (money-shaped refundAmount + required originalAmount) never
// matched a real emission — the drift was invisible until hosts wired the
// outbox/transport and subscribers started validating real payloads.

const paymentAuthorizedSchema = z.object({
  transaction: transactionRef,
  authorizedAmount: money,
  expiresAt: z.iso.datetime().optional(),
});

const paymentCapturedSchema = z.object({
  transaction: transactionRef,
  capturedAmount: money,
  authorizedAmount: money,
  isPartial: z.boolean(),
});

const paymentAuthVoidedSchema = z.object({
  transaction: transactionRef,
  voidedAmount: money,
  reason: z.string().optional(),
});

const paymentDisputedSchema = z.object({
  transaction: transactionRef,
  disputeId: z.string(),
  disputedAmount: money,
  reason: z.string(),
  status: z.string(),
  evidenceDueBy: z.iso.datetime().optional(),
});

const paymentDisputeWonSchema = z.object({
  transaction: transactionRef,
  disputeId: z.string(),
  recoveredAmount: money,
});

const paymentDisputeLostSchema = z.object({
  transaction: transactionRef,
  disputeId: z.string(),
  lostAmount: money,
  feeAmount: money.optional(),
});

const paymentSettledSchema = z.object({
  transaction: transactionRef,
  settledAmount: money,
  feeAmount: money.optional(),
  payoutId: z.string().optional(),
  expectedArrivalAt: z.iso.datetime().optional(),
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

/**
 * RETIRED payload aliases now point at the CANONICAL schemas.
 *
 * These were `z.infer` of the old document-shaped schemas. Left pointing there
 * they would keep every consumer compiling against a payload nothing emits —
 * the type would agree with the code and disagree with reality, which is worse
 * than a break because nothing surfaces it.
 */
export type PaymentSucceededPayload = z.infer<typeof paymentSucceededCanonicalSchema>;
export type PaymentFailedPayload = z.infer<typeof paymentFailedSchema>;
export type PaymentProcessingPayload = z.infer<typeof paymentProcessingSchema>;
export type PaymentRequiresActionPayload = z.infer<typeof paymentRequiresActionSchema>;
export type PaymentRefundedPayload = z.infer<typeof paymentRefundedCanonicalSchema>;
export type PaymentAuthorizedPayload = z.infer<typeof paymentAuthorizedSchema>;
export type PaymentCapturedPayload = z.infer<typeof paymentCapturedSchema>;
export type PaymentAuthVoidedPayload = z.infer<typeof paymentAuthVoidedSchema>;
export type PaymentDisputedPayload = z.infer<typeof paymentDisputedSchema>;
export type PaymentDisputeWonPayload = z.infer<typeof paymentDisputeWonSchema>;
export type PaymentDisputeLostPayload = z.infer<typeof paymentDisputeLostSchema>;
export type PaymentSettledPayload = z.infer<typeof paymentSettledSchema>;
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

/**
 * Canonical payload schemas — the RUNTIME half of the primitives contract.
 *
 * These mirror `@classytic/primitives/payment-events` so a host can validate at
 * the boundary. The compile-time half is the exported TypeScript payloads; the
 * builders in `canonical-payment-events.ts` are typed against THOSE, so a schema
 * that drifts from the interface fails in the builder tests rather than silently
 * accepting a wrong shape at runtime.
 */
const canonicalMoney = z.object({ amount: z.number(), currency: z.string() });

/**
 * An instant AS IT ACTUALLY ARRIVES — a `Date` on every path this system has,
 * and an ISO string for any transport that genuinely serialises.
 *
 * ## What was wrong, and why nothing said so
 *
 * This was narrowed to `z.iso.datetime()` on the belief — written into the
 * docblock it replaced — that "a subscriber receives JSON: the event is
 * persisted to the outbox and relayed, so `occurredAt` arrives serialised."
 *
 * **That premise is false for a Mongo-backed outbox.** The row stores the
 * envelope as `Schema.Types.Mixed` ("the event, verbatim, as the relay will
 * republish it" — `@classytic/mongokit/outbox`), so a JS `Date` persists as a
 * BSON Date and is read back as a JS `Date`. Nothing serialises it. And the
 * repositories publish TWICE — `saveToOutbox` inside the transaction plus
 * `publishToTransport` after commit — so a subscriber gets a live object on the
 * fast path too.
 *
 * Result: the builders emit `Date` (the primitive payload types declare `Date`,
 * correctly, as the in-process type), this schema demanded `string`, and the
 * consumer therefore rejected **100% of deliveries on 100% of paths**. Observed
 * live on 2026-08-16: a refund executed, the customer was refunded, `settledAt`
 * was stamped, and spine-accounting logged `posting: payload validation failed —
 * skipping` twice — once per delivery path, both `received Date`. No revenue or
 * output-VAT reversal was ever posted, and nothing threw. A refunded sale
 * overstates both and carries it into the VAT return.
 *
 * The union is what the ORIGINAL docblock described, and removing it is what
 * broke this. It is restored, and the reason it was removed is closed at source:
 * `defineRevenueEvent` now converts with `unrepresentable: 'any'`, so a shape
 * JSON Schema cannot express degrades in the DOCS instead of dictating the
 * validation contract. Measured against zod 4.4.3 — the union parses both a
 * `Date` and an ISO string, and emits a clean `anyOf` under `'any'`.
 *
 * Keep it a union rather than "just `z.date()`": a future HTTP/Kafka relay does
 * serialise, and a schema that then rejected the replayed form would reproduce
 * this bug with the paths swapped. Consumers that read the field should accept
 * both (`new Date(v)` is correct for either).
 */
const canonicalInstant = z.union([z.iso.datetime(), z.date()]);

const paymentSucceededCanonicalSchema = z.object({
  eventType: z.literal(PAYMENT_EVENT_TYPE.SUCCEEDED),
  paymentId: z.string(),
  providerRef: z.string().optional(),
  providerCode: z.string(),
  amount: canonicalMoney,
  methodKind: z.string(),
  methodCode: z.string().optional(),
  occurredAt: canonicalInstant,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const paymentFailedCanonicalSchema = paymentSucceededCanonicalSchema.extend({
  eventType: z.literal(PAYMENT_EVENT_TYPE.FAILED),
  reason: z.string(),
  reasonCode: z.string().optional(),
});

const paymentRefundedCanonicalSchema = z.object({
  eventType: z.literal(PAYMENT_EVENT_TYPE.REFUNDED),
  paymentId: z.string(),
  refundId: z.string(),
  providerRef: z.string().optional(),
  providerCode: z.string(),
  refundedAmount: canonicalMoney,
  originalAmount: canonicalMoney,
  isPartial: z.boolean(),
  reason: z.string().optional(),
  occurredAt: canonicalInstant,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
// ─── Event definitions ────────────────────────────────────────────────────

/**
 * ## Portable outcomes — the CANONICAL contract
 *
 * `PaymentSucceeded` / `PaymentFailedEvent` / `PaymentRefunded` are GONE in 4.x. They
 * declared `revenue:payment.*` names carrying revenue's own document shape, and
 * nothing emits those any more. Leaving the declarations behind would describe a
 * stream that does not exist — worse than deleting them, because a host would
 * bind a handler that never fires and nothing would error.
 *
 * The replacements below name the canonical events and validate the primitive
 * payloads, so a host keeps the same declarative wiring
 * (`event: X, payloadSchema: X.zodSchema`) while consuming a contract that does
 * not mention revenue.
 */
export const PaymentSucceeded = defineRevenueEvent({
  name: PAYMENT_EVENT_TYPE.SUCCEEDED,
  description: 'Funds confirmed received — the trigger for AR settlement and fulfilment unlocks.',
  zodSchema: paymentSucceededCanonicalSchema,
});

export const PaymentFailedEvent = defineRevenueEvent({
  name: PAYMENT_EVENT_TYPE.FAILED,
  description: 'A payment attempt failed before clearing — the obligation remains unsettled.',
  zodSchema: paymentFailedCanonicalSchema,
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
  name: PAYMENT_EVENT_TYPE.REFUNDED,
  description: 'Money returned to the customer — carries originalAmount so remaining refundable needs no lookup.',
  zodSchema: paymentRefundedCanonicalSchema,
});

export const PaymentAuthorized = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_AUTHORIZED,
  description: 'A payment authorisation hold was placed (funds NOT captured).',
  zodSchema: paymentAuthorizedSchema,
});

export const PaymentCaptured = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_CAPTURED,
  description: 'A previously-authorised payment was captured (full or partial).',
  zodSchema: paymentCapturedSchema,
});

export const PaymentAuthVoided = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_AUTH_VOIDED,
  description: 'An uncaptured payment authorisation was voided.',
  zodSchema: paymentAuthVoidedSchema,
});

export const PaymentDisputed = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_DISPUTED,
  description: 'A dispute / chargeback was opened against a payment.',
  zodSchema: paymentDisputedSchema,
});

export const PaymentDisputeWon = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_DISPUTE_WON,
  description: 'A payment dispute was resolved in the merchant\'s favour.',
  zodSchema: paymentDisputeWonSchema,
});

export const PaymentDisputeLost = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_DISPUTE_LOST,
  description: 'A payment dispute was lost — funds permanently debited.',
  zodSchema: paymentDisputeLostSchema,
});

export const PaymentSettled = defineRevenueEvent({
  name: REVENUE_EVENTS.PAYMENT_SETTLED,
  description: 'Payment funds settled to the merchant bank account.',
  zodSchema: paymentSettledSchema,
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
  PaymentSucceeded,
  PaymentFailedEvent,
  PaymentProcessing,
  PaymentRequiresAction,
  PaymentRefunded,
  PaymentAuthorized,
  PaymentCaptured,
  PaymentAuthVoided,
  PaymentDisputed,
  PaymentDisputeWon,
  PaymentDisputeLost,
  PaymentSettled,
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
