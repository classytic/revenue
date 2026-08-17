/**
 * Revenue's PORTABLE payment facts — the `@classytic/primitives/payment-events`
 * contract, constructed exactly.
 *
 * ## Why this file exists
 *
 * Revenue used to publish `revenue:payment.*` carrying its own document shape:
 *
 * ```ts
 * const transactionRef = z.object({ _id: …optional(), status: …optional(), … }).passthrough();
 * ```
 *
 * Every field optional, `.passthrough()` on the end. That is not a contract — it
 * is "whatever the Mongoose document happened to hold", and a consumer could not
 * rely on a single field being present. Invoice, order, membership and every
 * future module had to know what a revenue transaction looks like in order to
 * react to a payment, which is precisely the coupling an event is supposed to
 * remove.
 *
 * The ecosystem already had the answer. `@classytic/primitives/payment-events`
 * defines closed, discriminated payloads with `Money` amounts. This file maps
 * revenue's domain objects onto them, and the emission sites publish THESE.
 *
 * ## ONE authoritative fact — no dual publish
 *
 * Revenue 4.x emits the canonical `payment.*` names for portable outcomes and
 * NO LONGER emits `revenue:payment.*` for them. Publishing both would let a
 * consumer subscribed to each process one refund twice, and the second
 * processing looks exactly like a legitimate second refund.
 *
 * `revenue:*` survives for facts that are genuinely revenue-internal and have no
 * portable meaning — transaction imports, matching, subscription lifecycle,
 * settlement workflow. Those are not payment outcomes and no other module
 * reasons about them.
 *
 * ## Money, not numbers
 *
 * The old `refundAmount: z.number()` carried no currency. That is survivable in
 * a single-currency deployment and wrong the moment there are two — a bare
 * amount cannot be interpreted, and the consumer that assumes the deployment
 * currency is right until it is silently not. Every amount here is `Money`.
 *
 * ## Correlation
 *
 * `sourceModel` / `sourceId` travel in `metadata`, not as top-level fields: they
 * are revenue's link back to whatever the payment was FOR, and the canonical
 * contract deliberately does not model the payer's domain.
 */

import type { Money } from '@classytic/primitives/money';
import {
  PAYMENT_EVENT_TYPE,
  type PaymentFailedPayload,
  type PaymentRefundedPayload,
  type PaymentReconciledPayload,
  type PaymentReversedPayload,
  type PaymentSucceededPayload,
  type PaymentUnknownPayload,
} from '@classytic/primitives/payment-events';
import type { PaymentMethodKind } from '@classytic/primitives/payment-method-kind';
import type { ProviderUnknownCause } from '@classytic/primitives/payment-gateway';

/**
 * The transaction fields a canonical payload is built from.
 *
 * Declared as the SUBSET actually read rather than importing the document type:
 * a payload builder that accepts a whole Mongoose document invites new fields to
 * leak into events by accident, which is how the passthrough shape happened in
 * the first place.
 */
export interface CanonicalSourceTransaction {
  publicId?: string | undefined;
  _id?: unknown;
  amount: number;
  currency: string;
  methodKind: PaymentMethodKind;
  methodCode?: string | undefined;
  providerCode?: string | undefined;
  providerRef?: string | undefined;
  sourceModel?: string | undefined;
  sourceId?: unknown;
}

/**
 * The stable public identifier for a payment.
 *
 * `publicId` first — it is the id revenue exposes and the one a consumer can
 * ask about later. `_id` is the fallback for rows written before `publicId`
 * existed. THROWS when neither is present: an event whose subject cannot be
 * identified is not a fact, and emitting one with an empty id would produce a
 * consumer-side lookup that silently matches nothing.
 */
export function paymentIdOf(txn: CanonicalSourceTransaction): string {
  const id = txn.publicId ?? (txn._id == null ? undefined : String(txn._id));
  if (!id) {
    throw new Error(
      'canonical payment event: transaction has neither publicId nor _id — an event whose subject cannot be ' +
        'identified is not a portable fact',
    );
  }
  return id;
}

/**
 * Provider identity.
 *
 * REQUIRED by the contract, so a missing value is normalised to `'unknown'`
 * rather than omitted — a payload that fails its own type is worse than one
 * that says the provider was not recorded, and `'unknown'` is greppable in a
 * way that an absent key is not.
 */
const providerCodeOf = (txn: CanonicalSourceTransaction): string => txn.providerCode ?? 'unknown';

const moneyOf = (amount: number, currency: string): Money => ({ amount, currency }) as Money;

/**
 * Correlation back to whatever the payment was FOR.
 *
 * In `metadata` deliberately: the canonical contract does not model the payer's
 * domain, and promoting `sourceModel`/`sourceId` to top-level fields would make
 * every consumer of a payment event carry revenue's notion of a source.
 */
function correlation(txn: CanonicalSourceTransaction, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(txn.sourceModel !== undefined ? { sourceModel: txn.sourceModel } : {}),
    ...(txn.sourceId != null ? { sourceId: String(txn.sourceId) } : {}),
    /**
     * Revenue's own ROW id, for consumers that still read the transaction.
     *
     * `paymentId` is the PORTABLE identity and prefers `publicId`, which is a
     * `customIdPlugin` field — so a consumer calling `getById(paymentId)`
     * without an explicit `idField` may match nothing and skip silently. That
     * is the trap `@classytic/order` documents for `orderNumber`.
     *
     * Carrying `_id` here keeps an existing lookup exact during migration
     * WITHOUT promoting a revenue implementation detail into the portable
     * contract. A consumer that needs nothing from the row ignores it.
     */
    ...(txn._id != null ? { transactionId: String(txn._id) } : {}),
    ...(extra ?? {}),
  };
}

/** Funds confirmed received. The trigger for AR settlement and fulfilment unlocks. */
export function toPaymentSucceeded(
  txn: CanonicalSourceTransaction,
  occurredAt: Date,
): PaymentSucceededPayload {
  return {
    eventType: PAYMENT_EVENT_TYPE.SUCCEEDED,
    paymentId: paymentIdOf(txn),
    providerCode: providerCodeOf(txn),
    ...(txn.providerRef !== undefined ? { providerRef: txn.providerRef } : {}),
    amount: moneyOf(txn.amount, txn.currency),
    methodKind: txn.methodKind,
    ...(txn.methodCode !== undefined ? { methodCode: txn.methodCode } : {}),
    occurredAt,
    metadata: correlation(txn),
  };
}

/**
 * The attempt failed and the obligation REMAINS UNSETTLED.
 *
 * `reason` is required by the contract and must be a normalised string, never a
 * raw vendor error — those embed request URLs, tokens and body fragments, and
 * this value is persisted and displayed.
 */
export function toPaymentFailed(
  txn: CanonicalSourceTransaction,
  reason: string,
  occurredAt: Date,
  reasonCode?: string,
): PaymentFailedPayload {
  return {
    eventType: PAYMENT_EVENT_TYPE.FAILED,
    paymentId: paymentIdOf(txn),
    providerCode: providerCodeOf(txn),
    ...(txn.providerRef !== undefined ? { providerRef: txn.providerRef } : {}),
    amount: moneyOf(txn.amount, txn.currency),
    methodKind: txn.methodKind,
    ...(txn.methodCode !== undefined ? { methodCode: txn.methodCode } : {}),
    reason,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    occurredAt,
    metadata: correlation(txn),
  };
}

/**
 * Money returned to the customer.
 *
 * `originalAmount` and `isPartial` are carried so a consumer can compute the
 * remaining refundable WITHOUT reading revenue's transaction — the whole point
 * of a portable fact. `isPartial` is DERIVED here rather than accepted from the
 * caller: two sources for one boolean is one that can disagree.
 */
export function toPaymentRefunded(input: {
  original: CanonicalSourceTransaction;
  refund: CanonicalSourceTransaction;
  refundedAmount: number;
  occurredAt: Date;
  reason?: string | undefined;
}): PaymentRefundedPayload {
  const { original, refund, refundedAmount, occurredAt } = input;
  return {
    eventType: PAYMENT_EVENT_TYPE.REFUNDED,
    paymentId: paymentIdOf(original),
    refundId: paymentIdOf(refund),
    providerCode: providerCodeOf(original),
    ...(original.providerRef !== undefined ? { providerRef: original.providerRef } : {}),
    refundedAmount: moneyOf(refundedAmount, original.currency),
    originalAmount: moneyOf(original.amount, original.currency),
    isPartial: refundedAmount < original.amount,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    occurredAt,
    metadata: correlation(original, { refundTransactionId: paymentIdOf(refund) }),
  };
}

/**
 * The settlement is being UNWOUND — distinct from a refund.
 *
 * A refund returns money to the customer after settlement; a reversal undoes the
 * settlement itself (operator error, duplicate capture, pre-clearing cancel).
 * Consumers must unwind allocations, which is not what they do for a refund — so
 * approximating one as the other corrupts AR in a way that still balances.
 */
export function toPaymentReversed(input: {
  original: CanonicalSourceTransaction;
  reversedAmount: number;
  reason: string;
  occurredAt: Date;
}): PaymentReversedPayload {
  const { original, reversedAmount, reason, occurredAt } = input;
  return {
    eventType: PAYMENT_EVENT_TYPE.REVERSED,
    paymentId: paymentIdOf(original),
    providerCode: providerCodeOf(original),
    ...(original.providerRef !== undefined ? { providerRef: original.providerRef } : {}),
    reversedAmount: moneyOf(reversedAmount, original.currency),
    originalAmount: moneyOf(original.amount, original.currency),
    isPartial: reversedAmount < original.amount,
    reason,
    occurredAt,
    metadata: correlation(original),
  };
}

/**
 * An ALLOCATION was matched to a bank line or processor settlement record.
 *
 * Keyed on `allocationId`, not `paymentId` — one payment can have many
 * allocations, and reconciling one says nothing about the others. Emitting this
 * per payment would close an audit loop that is still open.
 */
export function toPaymentReconciled(input: {
  allocationId: string;
  paymentId: string;
  externalRef: string;
  reconciledAt: Date;
  reconciledBy: string;
  metadata?: Record<string, unknown> | undefined;
}): PaymentReconciledPayload {
  return {
    eventType: PAYMENT_EVENT_TYPE.RECONCILED,
    allocationId: input.allocationId,
    paymentId: input.paymentId,
    externalRef: input.externalRef,
    reconciledAt: input.reconciledAt,
    reconciledBy: input.reconciledBy,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

/**
 * NO OBSERVABLE OUTCOME — the third value, and the reason this migration matters
 * most.
 *
 * The provider port is three-valued (`confirmed | declined | unknown`) while
 * revenue's event vocabulary was two-valued, so an adapter that hit the third
 * case had to pick a lie. Reporting `failed` is the dangerous direction: it
 * licenses a retry, and if the first attempt actually succeeded that retry is a
 * double charge. The reverse mistake costs a reconciliation that finds nothing —
 * the asymmetry is the whole design.
 *
 * `causeCode` is a NORMALISED cause, never a raw vendor error: this value is
 * persisted and displayed, and vendor errors embed request URLs and tokens.
 */
export function toPaymentUnknown(input: {
  txn: CanonicalSourceTransaction;
  operation: PaymentUnknownPayload['operation'];
  causeCode: ProviderUnknownCause;
  occurredAt: Date;
  idempotencyKey?: string | undefined;
  includeAmount?: boolean | undefined;
}): PaymentUnknownPayload {
  const { txn } = input;
  return {
    eventType: PAYMENT_EVENT_TYPE.UNKNOWN,
    paymentId: paymentIdOf(txn),
    providerCode: providerCodeOf(txn),
    ...(txn.providerRef !== undefined ? { providerRef: txn.providerRef } : {}),
    operation: input.operation,
    ...(input.includeAmount === false ? {} : { amount: moneyOf(txn.amount, txn.currency) }),
    methodKind: txn.methodKind,
    ...(txn.methodCode !== undefined ? { methodCode: txn.methodCode } : {}),
    causeCode: input.causeCode,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    occurredAt: input.occurredAt,
    metadata: correlation(txn),
  };
}
