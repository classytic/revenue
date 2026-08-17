/**
 * Shared types for the transaction repository lifecycle layers
 * (bank-feed → refund → transaction). Kept separate so every layer references ONE
 * declaration of the deps + read-model shapes instead of re-importing across the chain.
 */
import type { CurrencyCode } from '@classytic/primitives/currency';
import type { BaseRevenueRepoDeps } from '../base.repository.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { BankFeedProviderRegistry } from '../../providers/bank-feed.js';
import type { RevenueBridges } from '../../bridges/revenue-bridges.js';
import type { CommissionConfig } from '../../engine/engine-types.js';
import type { PaymentAttemptRepository } from '../payment-attempt.repository.js';

/**
 * Deps for the transaction repository. Extends {@link BaseRevenueRepoDeps}
 * (events / outbox? / logger?) with provider/bridge/config wiring specific
 * to the payment-flow + bank-feed lifecycles.
 */
export interface TransactionRepoDeps extends BaseRevenueRepoDeps {
  providers: ProviderRegistry;
  /**
   * Bank-feed provider registry (3.0). Optional — when omitted, the
   * `drainSync` and `parseAndImport` verbs throw on use. The host typically
   * wires Plaid / fin-io / a custom CSV provider here.
   */
  bankFeedProviders?: BankFeedProviderRegistry | undefined;
  bridges: RevenueBridges;
  commission?: CommissionConfig;
  /** Validated + branded once by defineRevenue at bind; never re-parsed here. */
  defaultCurrency: CurrencyCode;
  /**
   * Whether field-strategy tenant scoping is active on this engine
   * (`scope.enabled && scope.strategy === 'field'`). When `true`, verbs
   * that upsert without going through the multi-tenant plugin's required
   * check — `import()` builds raw `bulkWrite` filters — MUST refuse a
   * missing `ctx.organizationId` rather than silently write an unscoped
   * row. Set once by `defineRevenue` at inject time. Defaults to `false`
   * (single-tenant / scoping-off) when omitted.
   */
  tenantScopeEnabled?: boolean;
  /**
   * Scoped, CAS-capable attempt repository (phase 3). The SINGLE persistence path
   * for every PaymentAttempt write — create (the unique-index create-or-load race),
   * outcome stamps, transaction linking, the atomic reconciliation `claim()`, the
   * cross-branch stale scan, and the refund read model. Going through the repository
   * (never a raw model) keeps tenant scope, soft-delete, audit hooks and transaction
   * options consistent — two persistence paths would drift. Core: always injected by
   * `defineRevenue`; the create/refund paths require it.
   */
  paymentAttempts?: PaymentAttemptRepository;
}

/**
 * A single entry in the Refund READ MODEL (phase 3). A projection, never a stored
 * row: `source:'transaction'` = a confirmed refund child; `source:'attempt'` = an
 * in-flight / failed refund `PaymentAttempt` (pending / unknown / declined).
 */
export interface RefundView {
  id: string;
  source: 'transaction' | 'attempt';
  amount: number;
  currency: string;
  status: 'succeeded' | 'pending' | 'unknown' | 'declined';
  createdAt: Date;
  reason?: string;
  providerReference?: string;
  causeCode?: string;
  idempotencyKey?: string;
}

/**
 * One provider round-trip on a payment — the row that makes "three declines then a
 * success" expressible at all.
 *
 * The embedded `gateway` block on `Transaction` holds only the LAST attempt, so before
 * this the history was structurally unrepresentable, not merely unrecorded.
 *
 * `declineReason` is deliberately ABSENT from this view. It carries the provider's raw
 * text, and raw vendor strings must not reach a persisted or displayed field — the
 * closed `causeCode` is what a caller branches on, and the detail stays in the logs
 * (AGENTS.md, "keep raw vendor errors out of persisted/displayed fields").
 */
export interface PaymentAttemptView {
  id: string;
  operation: 'create-intent' | 'refund';
  provider: string;
  methodKind?: string;
  /** `unknown` is a REAL outcome, not a failure — see the three-valued result contract. */
  outcome: 'pending' | 'confirmed' | 'declined' | 'unknown';
  amount: number;
  currency: string;
  /** Closed code a caller may branch on. The provider's raw text is not exposed. */
  causeCode?: string;
  providerReference?: string;
  idempotencyKey?: string;
  createdAt: Date;
}

/**
 * A payment's attempt history, oldest first, plus the counts a caller needs to decide
 * whether anything is still in flight.
 *
 * `unknownCount` is separated from `declinedCount` ON PURPOSE: an unobserved outcome is
 * not a negative one. Collapsing them is what licenses a retry against a charge that may
 * have succeeded — the exact asymmetry the three-valued `ProviderCommandResult` exists
 * to preserve, surfaced here so a UI cannot re-collapse it.
 */
export interface PaymentAttemptHistory {
  attempts: PaymentAttemptView[];
  confirmedCount: number;
  declinedCount: number;
  unknownCount: number;
  pendingCount: number;
}

export interface RefundSummary {
  /** Confirmed refunded total (minor units). */
  refundedAmount: number;
  /** Reserved-but-unconfirmed refund total (minor units). */
  pendingRefundAmount: number;
  refunds: RefundView[];
}
