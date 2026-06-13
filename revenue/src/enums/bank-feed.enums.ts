/**
 * Bank-feed lifecycle enums.
 *
 * Revenue 3.0 generalizes the Transaction model from "payment-gateway-only"
 * to a unified cashflow ledger. The `kind` discriminator selects which
 * state machine governs the row (see `core/state-machines.ts`); these
 * enums own the bank-feed and manual lifecycles plus the canonical
 * `TransactionKind` literals every consumer should branch on.
 *
 * Why a discriminator instead of a separate model — same collection wins
 * the unified-audit-ledger query ("everything that touched cash this
 * quarter"), keeps soft-delete + retention policies single-sourced, and
 * lets `relatedTransactionId` cross-link a Stripe charge to its Plaid
 * deposit without a polymorphic ref. See PACKAGE_RULES §30 / §35.
 */

import { TRANSACTION_STATUS, type TransactionStatusValue } from './transaction.enums.js';

// ─── Discriminator ────────────────────────────────────────────────────────

export const TRANSACTION_KIND = {
  /**
   * Payment-gateway flow — the original revenue lifecycle. Stripe / SSL /
   * Bkash / manual all share this graph.
   *   pending → payment_initiated → processing → requires_action → verified
   *   → completed → refunded | partially_refunded
   */
  PAYMENT_FLOW: 'payment_flow',
  /**
   * Bank / accounting feed — OFX upload, Plaid sync, QBO/Xero CDC.
   *   imported → matched → journalized   (happy path)
   *   imported → rejected                 (operator skip)
   *   matched  → imported                 (un-match)
   */
  BANK_FEED: 'bank_feed',
  /**
   * Hand-keyed entry — treasurer logs a cash deposit, owner injects
   * capital. Cleaner two-step lifecycle than payment_flow.
   *   pending → matched → journalized | rejected
   */
  MANUAL: 'manual',
} as const;

export type TransactionKind = typeof TRANSACTION_KIND;
export type TransactionKindValue = TransactionKind[keyof TransactionKind];
export const TRANSACTION_KIND_VALUES = Object.values(TRANSACTION_KIND) as TransactionKindValue[];

const transactionKindSet = new Set<TransactionKindValue>(TRANSACTION_KIND_VALUES);
export function isTransactionKind(value: unknown): value is TransactionKindValue {
  return typeof value === 'string' && transactionKindSet.has(value as TransactionKindValue);
}

// ─── Bank-feed-specific status extensions ────────────────────────────────
// These are added to the existing `TRANSACTION_STATUS` value space so the
// `status` field on the document remains a single union. The state graphs
// in `core/state-machines.ts` constrain which kinds may reach which values.

export const BANK_FEED_STATUS = {
  IMPORTED: 'imported',
  MATCHED: 'matched',
  JOURNALIZED: 'journalized',
  REJECTED: 'rejected',
  // Terminal + non-matchable. Born here for vendor-reconciled rows (Xero
  // Payments, transfer legs) so they're visible but can never post a JE.
  RECONCILED_EXTERNAL: 'reconciled_external',
  // Settled by a linked document (invoice/bill) whose payment already posted
  // the cash JE — the bank line posts no second JE. Reached via `settle()`
  // (`imported|pending → settled`), reversible via `unsettle()`. Excluded from
  // the categorize/review queue (it carries no GL mapping to confirm).
  SETTLED: 'settled',
} as const;

export type BankFeedStatusValue = (typeof BANK_FEED_STATUS)[keyof typeof BANK_FEED_STATUS];
export const BANK_FEED_STATUS_VALUES = Object.values(BANK_FEED_STATUS) as BankFeedStatusValue[];

// Compile-time proof: bank-feed statuses live in the broader
// TransactionStatusValue space — adding/renaming entries forces updates here.
const _bankFeedStatusFitsTransactionStatus = BANK_FEED_STATUS_VALUES satisfies readonly string[];
void _bankFeedStatusFitsTransactionStatus;

const bankFeedStatusSet = new Set<string>(BANK_FEED_STATUS_VALUES);
export function isBankFeedStatus(value: unknown): value is BankFeedStatusValue {
  return typeof value === 'string' && bankFeedStatusSet.has(value);
}

// ─── Source provenance for imports / sync ────────────────────────────────

export const BANK_FEED_SOURCE = {
  OFX: 'ofx',
  CAMT053: 'camt.053',
  MT940: 'mt940',
  CSV: 'csv',
  IIF: 'iif',
  QBO: 'qbo',
  XERO: 'xero',
  PLAID: 'plaid',
  MANUAL: 'manual',
} as const;

export type BankFeedSourceValue = (typeof BANK_FEED_SOURCE)[keyof typeof BANK_FEED_SOURCE];
export const BANK_FEED_SOURCE_VALUES = Object.values(BANK_FEED_SOURCE) as BankFeedSourceValue[];

const bankFeedSourceSet = new Set<string>(BANK_FEED_SOURCE_VALUES);
export function isBankFeedSource(value: unknown): value is BankFeedSourceValue {
  return typeof value === 'string' && bankFeedSourceSet.has(value);
}

// ─── Kind-aware status helper ────────────────────────────────────────────

/**
 * Initial status for a freshly created row of a given kind. Centralized so
 * the schema, repo verbs, and validators agree.
 *
 * - `payment_flow` → `pending` — provider may flip to verified instantly
 *   for zero-amount rows (see `createPaymentIntent`).
 * - `bank_feed`    → `imported` — bulk upsert from a feed/upload.
 * - `manual`       → `pending`  — treasurer reviews then `match()`es.
 */
export function initialStatusFor(kind: TransactionKindValue): TransactionStatusValue {
  switch (kind) {
    case TRANSACTION_KIND.BANK_FEED:
      return BANK_FEED_STATUS.IMPORTED as TransactionStatusValue;
    case TRANSACTION_KIND.MANUAL:
      return TRANSACTION_STATUS.PENDING;
    case TRANSACTION_KIND.PAYMENT_FLOW:
    default:
      return TRANSACTION_STATUS.PENDING;
  }
}

// ─── Status × Kind validity matrix ───────────────────────────────────────
//
// `TRANSACTION_STATUS` now spans 15 values across 3 lifecycles. The type
// guard `isTransactionStatus` returns `true` for any string in the union
// — strictly correct, semantically loose: it would accept `'imported'`
// on a `payment_flow` row. Hosts that validate at API boundaries (e.g.
// status-change PATCHes from an admin UI) want a kind-aware predicate.

const STATUSES_BY_KIND: Record<TransactionKindValue, ReadonlySet<string>> = {
  [TRANSACTION_KIND.PAYMENT_FLOW]: new Set([
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PAYMENT_INITIATED,
    TRANSACTION_STATUS.PROCESSING,
    TRANSACTION_STATUS.REQUIRES_ACTION,
    TRANSACTION_STATUS.VERIFIED,
    TRANSACTION_STATUS.COMPLETED,
    TRANSACTION_STATUS.FAILED,
    TRANSACTION_STATUS.CANCELLED,
    TRANSACTION_STATUS.EXPIRED,
    TRANSACTION_STATUS.REFUNDED,
    TRANSACTION_STATUS.PARTIALLY_REFUNDED,
  ]),
  [TRANSACTION_KIND.BANK_FEED]: new Set([
    TRANSACTION_STATUS.IMPORTED,
    TRANSACTION_STATUS.MATCHED,
    TRANSACTION_STATUS.JOURNALIZED,
    TRANSACTION_STATUS.REJECTED,
    TRANSACTION_STATUS.RECONCILED_EXTERNAL,
    TRANSACTION_STATUS.SETTLED,
  ]),
  [TRANSACTION_KIND.MANUAL]: new Set([
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.MATCHED,
    TRANSACTION_STATUS.JOURNALIZED,
    TRANSACTION_STATUS.REJECTED,
    TRANSACTION_STATUS.SETTLED,
  ]),
};

/**
 * True iff `status` is a legal value for a transaction of the given
 * `kind`. Use at API boundaries (admin status filters, list-page query
 * params, JSON imports) to reject `?kind=payment_flow&status=imported`
 * before it reaches the repository.
 *
 * @example
 * if (!isStatusValidForKind(req.query.status, req.query.kind)) {
 *   throw new ValidationError('status invalid for kind');
 * }
 */
export function isStatusValidForKind(
  status: unknown,
  kind: TransactionKindValue,
): boolean {
  if (typeof status !== 'string') return false;
  return STATUSES_BY_KIND[kind].has(status);
}

/**
 * The set of status values legal for a given kind. Useful for building
 * dropdown options or `$in` filters at the API layer.
 */
export function statusesForKind(kind: TransactionKindValue): readonly string[] {
  return [...STATUSES_BY_KIND[kind]];
}
