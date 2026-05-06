import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import type { ApprovalChain } from '@classytic/primitives/approval';
import { TRANSACTION_KIND, type TransactionKindValue, TRANSACTION_KIND_VALUES } from '../enums/bank-feed.enums.js';

/**
 * The Transaction document carries an optional `approvals` value object
 * when the host wires a maker-checker review. Per `PACKAGE_RULES.md §P7`,
 * every package that supports a review step uses `approvals?: ApprovalChain`
 * from `@classytic/primitives/approval` — no parallel chain shape, no
 * engine opt-in flag. Hosts that don't gate manual transactions simply
 * leave the field undefined; Mongoose treats it as absent.
 */
export type TransactionApprovals = ApprovalChain;

/**
 * Resolved bank-feed index flags as the schema sees them. Lives here
 * (not in `engine-types.ts`) because models can be built standalone
 * without the engine. The engine factory resolves
 * `modules.bankFeed.indexes` into this shape and forwards it.
 */
export interface ResolvedBankFeedIndexes {
  idempotentImport: boolean;
  byAccount: boolean;
  matchCandidates: boolean;
}

export const NO_BANK_FEED_INDEXES: ResolvedBankFeedIndexes = {
  idempotentImport: false,
  byAccount: false,
  matchCandidates: false,
};

export interface RevenueSchemaConfig {
  scoped: boolean;
  extraFields?: Record<string, unknown>;
  extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }>;
  /** Per-index flags for the bank-feed lifecycle. */
  bankFeedIndexes?: ResolvedBankFeedIndexes;
}

/**
 * Counterparty on a bank-feed entry. Untyped Mixed at the Mongoose level
 * (banks populate different fields), but typed here so consumers and
 * validators can introspect.
 */
export interface TransactionCounterparty {
  name?: string;
  identifier?: string;
  iban?: string;
  accountNumber?: string;
  bic?: string;
  routingNumber?: string;
}

/**
 * Polymorphic ledger journal-entry reference. String-typed (PACKAGE_RULES
 * §7) so it works for ledger documents stored in another connection,
 * Postgres ledgers, or external accounting systems (QBO Journal IDs).
 */
export interface JournalEntryRef {
  type: string;
  id: string;
}

export interface TransactionDocument {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  organizationId?: string;
  customerId?: string | null;

  // ─── Discriminator (3.0) ───
  /**
   * Selects the state machine that governs this row's `status` field.
   * Defaults to `'payment_flow'` so existing data reads identically.
   * See `core/state-machines.ts:smFor()`.
   */
  kind: TransactionKindValue;

  // ─── Business categorization ───
  type: string;
  flow: 'inflow' | 'outflow';
  tags: string[];

  // ─── Money ───
  amount: number;
  currency: string;
  fee: number;
  tax: number;
  net: number;
  taxDetails?: { type?: string; rate?: number; isInclusive?: boolean };
  /**
   * Multi-currency reconciliation (3.0). When the bank deposit clears
   * in a currency different from the originating charge, store the
   * other side here. Cross-currency `findMatchCandidates` reads these
   * to compare same-currency-equivalent amounts.
   */
  fxRate?: number;
  originalAmount?: number;
  originalCurrency?: string;

  method: string;
  status: string;
  /**
   * Optional embedded approval chain — P7. Hosts that gate manual /
   * non-gateway transactions on a maker-checker review attach a chain via
   * `createChain()` from `@classytic/primitives/approval`; the host's
   * approval action checks `isApproved(doc.approvals)` before flipping
   * status to `succeeded`. Auto-gateway transactions (Stripe, SSLCommerz,
   * etc.) bypass this entirely — synchronous gateway success is the gate.
   *
   * Use cases:
   *   - Manual cash receipts (front desk → bookkeeper verify)
   *   - Manual bank transfers (supplier-paid → finance verify)
   *   - Cheque deposits (queued until cleared)
   *   - **Refunds especially** — the audit-defining moment
   */
  approvals?: ApprovalChain;

  // ─── Payment-gateway fields (kind: 'payment_flow') ───
  gateway?: {
    type: string;
    sessionId?: string;
    paymentIntentId?: string;
    chargeId?: string;
    metadata?: Record<string, unknown>;
    verificationData?: Record<string, unknown>;
  };
  paymentDetails?: Record<string, unknown>;
  commission?: {
    rate: number;
    grossAmount: number;
    gatewayFeeRate: number;
    gatewayFeeAmount: number;
    netAmount: number;
    status: string;
  };
  splits?: Array<{
    type: string;
    recipientId: string;
    recipientType: string;
    rate: number;
    grossAmount: number;
    gatewayFeeRate: number;
    gatewayFeeAmount: number;
    netAmount: number;
    status: string;
  }>;
  hold?: {
    status: string;
    heldAmount: number;
    releasedAmount: number;
    reason: string;
    heldAt: Date;
    holdUntil?: Date;
    releasedAt?: Date;
    cancelledAt?: Date;
    releases: Array<{
      amount: number;
      recipientId: string;
      recipientType: string;
      releasedAt: Date;
      releasedBy?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    }>;
    metadata?: Record<string, unknown>;
  };

  // ─── Bank-feed / accounting-feed fields (kind: 'bank_feed' | 'manual') ───
  /**
   * Vendor-stable id from the upstream feed (FITID, NtryRef, qbo Id,
   * Plaid transaction_id). Used to enforce idempotent re-import via the
   * `(orgId, bankAccountId, externalId)` partial unique index.
   *
   * Distinct from `idempotencyKey` (host-chosen, request-scoped). See
   * `@classytic/primitives/bank-transaction` and PACKAGE_RULES §8.
   */
  externalId?: string;
  /** When the bank booked the entry. */
  postedDate?: Date;
  /** When funds clear / become available. */
  valueDate?: Date;
  /** Free-text bank description. */
  description?: string;
  counterparty?: TransactionCounterparty;
  /** Check number, payment reference, end-to-end ID. */
  reference?: string;
  /** Running balance on the account after this entry, if the format provides it. */
  balanceAfter?: number;
  /** Bank's own category (rare in OFX, common in Plaid / Mint exports). */
  vendorCategory?: string;
  /**
   * Polymorphic external ref to the bank account this row belongs to.
   * String per PACKAGE_RULES §7 — accepts ObjectId hex, UUID, external
   * IDs (Plaid `account_id`, QBO Account Id). Distinct from
   * `customerId`; the `bankAccount` resource lives on the host side.
   */
  bankAccountId?: string;
  /**
   * Provenance — which feed produced this row. One of the values from
   * `BANK_FEED_SOURCE` (`'ofx'`, `'plaid'`, `'qbo'`, …). Drives admin UI
   * filtering and duplicate-detection rules.
   */
  source?: string;
  /**
   * Bidirectional link to the journal entry that posted this row to the
   * GL. Stamped by `journalize()` after the host's LedgerBridge confirms
   * the JE was created. Polymorphic — `type` names the foreign model
   * (`'JournalEntry'`, `'QboJournalEntry'`, …).
   */
  journalEntryRef?: JournalEntryRef;
  /**
   * Operator-supplied mapping from bank line → GL accounts. Stored at
   * match time so re-running the journalize step is deterministic.
   */
  matching?: {
    debitAccount?: string;
    creditAccount?: string;
    notes?: string;
    matchedAt?: Date;
    matchedBy?: string;
  };

  // ─── Polymorphic source (existing, unchanged) ───
  sourceId?: string;
  sourceModel?: string;

  // ─── Refunds + cross-references (unchanged) ───
  relatedTransactionId?: mongoose.Types.ObjectId;
  refundedAmount?: number;
  refundedAt?: Date;
  failureReason?: string;
  failedAt?: Date;
  verifiedAt?: Date;
  verifiedBy?: string;

  // ─── Webhook + idempotency (unchanged) ───
  webhook?: {
    eventId: string;
    eventType: string;
    receivedAt: Date;
    processedAt: Date;
    data: Record<string, unknown>;
  };
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;

  // ─── Soft-delete + timestamps (unchanged) ───
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildTransactionSchema(config: RevenueSchemaConfig): Schema<TransactionDocument> {
  const fields: Record<string, unknown> = {
    publicId: { type: String },
    customerId: { type: String, default: null },

    // 3.0 discriminator — drives state-machine selection in repo verbs.
    kind: {
      type: String,
      enum: TRANSACTION_KIND_VALUES,
      default: TRANSACTION_KIND.PAYMENT_FLOW,
      required: true,
      index: true,
    },

    type: { type: String, required: true },
    flow: { type: String, enum: ['inflow', 'outflow'], required: true },
    tags: [{ type: String }],

    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    fee: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    taxDetails: { type: Schema.Types.Mixed },
    fxRate: { type: Number },
    originalAmount: { type: Number },
    originalCurrency: { type: String },

    method: { type: String, required: true },
    status: { type: String, default: 'pending' },
    // P7 — embedded ApprovalChain VO (primitives owns the shape). Hosts
    // running a maker-checker workflow (manual receipts, refunds, bank
    // transfers, cheques) attach a chain via `createChain()` and gate
    // the approval action on `isApproved(doc.approvals)`. Auto-gateway
    // transactions leave it undefined — gateway success is the gate.
    approvals: { type: Schema.Types.Mixed, default: null },

    gateway: { type: Schema.Types.Mixed },
    paymentDetails: { type: Schema.Types.Mixed },
    commission: { type: Schema.Types.Mixed },
    splits: [{ type: Schema.Types.Mixed }],
    hold: { type: Schema.Types.Mixed },

    // ─── Bank-feed fields (3.0) ───
    externalId: { type: String },
    postedDate: { type: Date },
    valueDate: { type: Date },
    description: { type: String },
    counterparty: { type: Schema.Types.Mixed },
    reference: { type: String },
    balanceAfter: { type: Number },
    vendorCategory: { type: String },
    // Polymorphic — accepts ObjectId hex / UUID / external feed account id.
    bankAccountId: { type: String },
    source: { type: String },
    journalEntryRef: { type: Schema.Types.Mixed },
    matching: { type: Schema.Types.Mixed },

    // ─── Polymorphic source (PACKAGE_RULES §7) ───
    //   • ObjectId hex   ('507f1f77bcf86cd799439011')
    //   • UUID           ('550e8400-e29b-41d4-a716-446655440000')
    //   • External ID    ('order_abc123', 'pi_3OqXyZ', 'stripe_charge_xxx')
    sourceId: { type: String },
    sourceModel: { type: String },

    // Self-reference — refund / split / release children + bank↔gateway cross-link.
    relatedTransactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    refundedAmount: { type: Number },
    refundedAt: { type: Date },
    failureReason: { type: String },
    failedAt: { type: Date },
    verifiedAt: { type: Date },
    verifiedBy: { type: String },
    webhook: { type: Schema.Types.Mixed },
    idempotencyKey: { type: String },
    metadata: { type: Schema.Types.Mixed },
    deletedAt: { type: Date, default: null },
  };

  if (config.extraFields) {
    Object.assign(fields, config.extraFields);
  }

  const schema = new Schema<TransactionDocument>(fields as any, { timestamps: true });

  // ─── Indexes (PACKAGE_RULES §31 — every index names its query) ───
  // tenant field is auto-prepended by `injectTenantField` when scoped.

  // Status + recency — admin dashboards, "show me everything pending"
  schema.index({ status: 1, createdAt: -1 });
  // Customer transaction history
  schema.index({ customerId: 1, createdAt: -1 });
  // Polymorphic source lookup — "find the txn for order X"
  schema.index({ sourceId: 1, sourceModel: 1 });

  // 3.0: kind + status + recency — admin UI filters by lifecycle.
  // Always built — the discriminator-aware admin list is the canonical
  // entry point regardless of which module(s) are active.
  schema.index({ kind: 1, status: 1, createdAt: -1 });

  // Always-on cross-reference hops — `relatedTransactionId` is used by
  // refund children + escrow split children too, not just bank-feed.
  schema.index({ relatedTransactionId: 1 }, { sparse: true });

  // ─── Opt-in bank-feed indexes ───
  // Each is gated by an explicit flag on `bankFeedIndexes`. A pure
  // payment-flow host with `modules.bankFeed: false` builds NONE of
  // these — same disk footprint as revenue 2.x.
  const bfi = config.bankFeedIndexes ?? NO_BANK_FEED_INDEXES;

  if (bfi.byAccount) {
    // Treasurer dashboard — bank-feed listing for one account.
    // Partial filter excludes payment_flow rows so the index stays compact.
    schema.index(
      { bankAccountId: 1, postedDate: -1 },
      {
        partialFilterExpression: { bankAccountId: { $type: 'string' } },
        name: 'bank_feed_by_account',
      },
    );
  }

  if (bfi.matchCandidates) {
    // findMatchCandidates() — Stripe charge ↔ bank deposit cross-ref.
    // The verb queries `(kind, status ∈ {…}, amount BETWEEN, postedDate OR
    // createdAt BETWEEN)`. Two compound indexes back the $or branches.
    // Keep `kind` first (not `status`) — `kind` is high-cardinality-stable;
    // `$in` over four statuses is poor index selectivity. Tenant prefix
    // added by `injectTenantField` when scoped.
    schema.index(
      { kind: 1, amount: 1, postedDate: -1 },
      { name: 'match_candidates_by_amount_date' },
    );
    schema.index(
      { kind: 1, amount: 1, createdAt: -1 },
      { name: 'match_candidates_by_amount_createdat' },
    );
  }

  if (config.extraIndexes) {
    for (const idx of config.extraIndexes) {
      schema.index(idx.fields, idx.options);
    }
  }

  return schema;
}

export function createTransactionModel(
  connection: Connection,
  config: RevenueSchemaConfig,
): Model<TransactionDocument> {
  return connection.model<TransactionDocument>('Transaction', buildTransactionSchema(config));
}
