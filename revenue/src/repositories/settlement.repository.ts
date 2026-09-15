import type { PluginType } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { SettlementDocument } from '../models/settlement.schema.js';
import type { RevenueContext } from '../core/context.js';
import type { RevenueBridges } from '../bridges/revenue-bridges.js';
import { createEvent } from '../events/helpers.js';
import { REVENUE_EVENTS } from '../events/event-constants.js';
import { SETTLEMENT_STATUS } from '../enums/settlement.enums.js';
import { SETTLEMENT_STATE_MACHINE } from '../core/state-machines.js';
import { InvalidStateTransitionError, SettlementNotFoundError } from '../core/errors.js';
import { RevenueRepositoryBase, type BaseRevenueRepoDeps } from './base.repository.js';

/**
 * Deps for {@link SettlementRepository}. Adds the optional
 * `RevenueBridges` (ledger / notification ports) on top of
 * {@link BaseRevenueRepoDeps}.
 */
export interface SettlementRepoDeps extends BaseRevenueRepoDeps {
  bridges: RevenueBridges;
}

export interface SettlementProcessingError {
  settlementId: SettlementDocument['_id'];
  error: unknown;
}

/**
 * A recipient's payout balance — the amounts the platform has scheduled,
 * is processing, has paid, or failed to pay, in minor units. The "wallet"
 * view a marketplace shows a seller/creator. Derived from settlement status;
 * tenant-scoped.
 */
export interface RecipientBalance {
  recipientId: string;
  currency: string | null;
  /** Scheduled, awaiting payout (status: pending) = held + available. */
  pending: number;
  /** Pending but still in the clearance window (`scheduledAt` in the future) — escrowed, not yet payable. */
  held: number;
  /** Pending and due (`scheduledAt <= now`) — cleared, ready to pay out. */
  available: number;
  /** Payout in flight (status: processing). */
  processing: number;
  /** Paid out, lifetime (status: completed). */
  paidOut: number;
  /** Failed payouts (status: failed). */
  failed: number;
  /** pending + processing + paidOut — the total the platform has committed to this recipient. */
  lifetime: number;
}

/**
 * Settlement money-state for an arbitrary filter (a recipient, an org, or the
 * whole platform) — the same status+due rollup as {@link RecipientBalance} but
 * not tied to a single recipient. The reusable shape behind `summary`.
 */
export type SettlementSummary = Omit<RecipientBalance, 'recipientId'>;

/**
 * How many recipients {@link SettlementRepository.breakdownByRecipient} returns
 * when the caller names no limit. Enough for any screen; far short of a payee
 * table.
 */
export const DEFAULT_BREAKDOWN_LIMIT = 200;
/** Hard ceiling on a bounded breakdown — above this, say `all: true` and mean it. */
export const MAX_BREAKDOWN_LIMIT = 1_000;

/** Paging + scan control for {@link SettlementRepository.breakdownByRecipient}. */
export interface BreakdownOptions {
  /** Recipients per call. Clamped to {@link MAX_BREAKDOWN_LIMIT}. */
  limit?: number;
  /** The last `recipientId` of the previous page. Results are ordered by it. */
  after?: string;
  /**
   * Scan EVERY matching row — reconciliation, not a screen. Enables disk
   * spilling so a large group cannot die at MongoDB's 100MB limit, and cannot
   * be combined with `limit`.
   */
  all?: boolean;
}

/** One row of {@link SettlementRepository.breakdownByRecipient}. */
export interface RecipientBreakdown extends RecipientBalance {
  recipientType: string;
  /** First-seen settlement role (creator_earning | co_instructor | referrer | …). */
  role: string | null;
}

function emptySettlementSummary(): SettlementSummary {
  return {
    currency: null,
    pending: 0,
    held: 0,
    available: 0,
    processing: 0,
    paidOut: 0,
    failed: 0,
    lifetime: 0,
  };
}

/** Bucket one aggregated (status, due, total) row into a running summary. */
function foldSettlementStatus(
  s: SettlementSummary,
  status: string,
  due: boolean,
  total: number,
): void {
  switch (status) {
    case SETTLEMENT_STATUS.PENDING:
      s.pending += total;
      if (due) s.available += total;
      else s.held += total;
      break;
    case SETTLEMENT_STATUS.PROCESSING:
      s.processing += total;
      break;
    case SETTLEMENT_STATUS.COMPLETED:
      s.paidOut += total;
      break;
    case SETTLEMENT_STATUS.FAILED:
      s.failed += total;
      break;
    default:
      break; // cancelled + any future status don't count toward the wallet
  }
}

/**
 * SettlementRepository — payouts to recipients (organizations, vendors,
 * affiliates).
 *
 * **CRUD inherited** via {@link RevenueRepositoryBase}. **Domain verbs:**
 * `schedule`, `processPending`, `complete`, `fail`. State machine:
 * `pending → processing → completed | failed`; `failed` with
 * `retry: true` resets to `pending` with a delayed `scheduledAt`.
 *
 * **Multi-tenant correctness.** Every read/write threads `ctx` through
 * {@link RevenueRepositoryBase.optsFromCtx} so `multiTenantPlugin`
 * scope filters apply. 2.1.0 had several `getById`/`update` calls that
 * dropped ctx — fixed in 2.1.1+.
 *
 * Bridges (`ledger`, `notification`) fire on `complete()` so a host
 * can pin double-entry book-keeping or push a "you got paid" email
 * without the repo knowing about either subsystem.
 */
export class SettlementRepository extends RevenueRepositoryBase<
  SettlementDocument,
  SettlementRepoDeps
> {
  constructor(model: Model<SettlementDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  // ─── Domain: Schedule ───────────────────────────────────────────────────
  //
  // Create a `pending` settlement targeted at `recipientId`. Defaults
  // `scheduledAt` to now (process-pending sweep picks it up immediately);
  // pass a future date to defer (e.g. weekly payout cycles).

  async schedule(
    params: {
      organizationId: string;
      recipientId: string;
      recipientType: string;
      type: string;
      amount: number;
      currency: string;
      payoutMethod: string;
      sourceTransactionIds?: string[];
      sourceSplitIds?: string[];
      scheduledAt?: Date;
      bankTransferDetails?: Record<string, unknown>;
      mobileWalletDetails?: Record<string, unknown>;
      cryptoDetails?: Record<string, unknown>;
      notes?: string;
      metadata?: Record<string, unknown>;
    },
    ctx: RevenueContext = {},
  ): Promise<SettlementDocument> {
    const settlement = (await this.create(
      {
        ...params,
        status: SETTLEMENT_STATUS.PENDING,
        scheduledAt: params.scheduledAt ?? new Date(),
        retryCount: 0,
      } as never,
      this.optsFromCtx(ctx),
    )) as SettlementDocument;

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SETTLEMENT_SCHEDULED,
        { settlement, scheduledAt: (settlement as { scheduledAt?: Date }).scheduledAt },
        ctx,
        { resource: 'settlement', resourceId: (settlement as { publicId?: string }).publicId },
      ),
      ctx,
    );
    return settlement;
  }

  // ─── Domain: Process Pending ────────────────────────────────────────────
  //
  // Sweep all settlements due (`scheduledAt <= now`, `status: pending`)
  // and flip them to `processing`. Returns counters + a list of any
  // per-settlement errors so the caller can report partial success.
  // Hosts typically run this on a cron (every 5 min in prod, every 30s in
  // dev). `dryRun: true` returns the candidate list without touching state.

  async processPending(
    options: {
      limit?: number;
      organizationId?: string;
      payoutMethod?: string;
      /** Restrict the sweep to a single recipient — pay one seller/participant. */
      recipientId?: string;
      dryRun?: boolean;
    } = {},
    ctx: RevenueContext = {},
  ): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    settlements: SettlementDocument[];
    errors: SettlementProcessingError[];
  }> {
    const query: Record<string, unknown> = {
      status: 'pending',
      scheduledAt: { $lte: new Date() },
    };
    if (options.organizationId) query.organizationId = options.organizationId;
    if (options.payoutMethod) query.payoutMethod = options.payoutMethod;
    if (options.recipientId) query.recipientId = options.recipientId;

    const result = await this.getAll(
      { filters: query, limit: options.limit ?? 50, sort: { scheduledAt: 1 } },
      this.optsFromCtx(ctx),
    );
    const pending = ((result as { data?: SettlementDocument[] }).data ?? []) as SettlementDocument[];

    if (options.dryRun) {
      return { processed: pending.length, succeeded: 0, failed: 0, settlements: pending, errors: [] };
    }

    const out = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      settlements: [] as SettlementDocument[],
      errors: [] as SettlementProcessingError[],
    };

    for (const settlement of pending) {
      try {
        SETTLEMENT_STATE_MACHINE.validate(
          settlement.status as never,
          SETTLEMENT_STATUS.PROCESSING as never,
          String(settlement._id),
        );
        await this.update(
          settlement._id,
          { status: SETTLEMENT_STATUS.PROCESSING, processedAt: new Date() },
          this.optsFromCtx(ctx),
        );
        out.succeeded++;
        out.settlements.push(settlement);

        await this.dispatch(
          createEvent(
            REVENUE_EVENTS.SETTLEMENT_PROCESSING,
            { settlement, processedAt: new Date() },
            ctx,
            { resource: 'settlement', resourceId: (settlement as { publicId?: string }).publicId },
          ),
          ctx,
        );
      } catch (err) {
        out.failed++;
        out.errors.push({ settlementId: settlement._id, error: err });
      }
      out.processed++;
    }

    return out;
  }

  // ─── Domain: Complete ───────────────────────────────────────────────────
  //
  // processing → completed. Stamps the transfer reference (bank/wallet/
  // crypto-tx-hash) and fires the ledger + notification bridges. Bridge
  // failures don't roll back the status flip — a separate alert path
  // surfaces them.

  async complete(
    settlementId: string,
    details: {
      transferReference?: string;
      transferredAt?: Date;
      transactionHash?: string;
      notes?: string;
      metadata?: Record<string, unknown>;
    } = {},
    ctx: RevenueContext = {},
  ): Promise<SettlementDocument> {
    const opts = this.optsFromCtx(ctx);
    const settlement = (await this.getById(settlementId, opts)) as SettlementDocument | null;
    if (!settlement) throw new SettlementNotFoundError(settlementId);

    SETTLEMENT_STATE_MACHINE.validate(
      settlement.status as never,
      SETTLEMENT_STATUS.COMPLETED as never,
      settlementId,
    );

    const updates: Record<string, unknown> = {
      status: SETTLEMENT_STATUS.COMPLETED,
      completedAt: new Date(),
      notes: details.notes,
      metadata: { ...settlement.metadata, ...details.metadata },
    };
    if (details.transferReference) {
      updates.bankTransferDetails = {
        ...(settlement.bankTransferDetails as Record<string, unknown> | undefined),
        transferReference: details.transferReference,
        transferredAt: details.transferredAt ?? new Date(),
      };
    }
    if (details.transactionHash) {
      updates.cryptoDetails = {
        ...(settlement.cryptoDetails as Record<string, unknown> | undefined),
        transactionHash: details.transactionHash,
        transferredAt: details.transferredAt ?? new Date(),
      };
    }

    const updated = await this.update(
      settlementId,
      updates,
      this.optsFromCtx(ctx, { throwOnNotFound: true }),
    );
    if (!updated) throw new SettlementNotFoundError(settlementId);

    await this.deps.bridges.ledger?.onSettlementCompleted?.(updated as never, ctx);
    await this.deps.bridges.notification?.onSettlementCompleted?.(updated as never, ctx);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SETTLEMENT_COMPLETED,
        { settlement: updated, completedAt: new Date() },
        ctx,
        { resource: 'settlement', resourceId: (updated as { publicId?: string })?.publicId },
      ),
      ctx,
    );
    return updated;
  }

  // ─── Domain: Fail ───────────────────────────────────────────────────────
  //
  // Two flavours:
  // - `retry: true` resets to `pending` with `scheduledAt = now + 1h`
  //   and increments `retryCount`. The next sweep picks it back up.
  // - default (terminal) flips to `failed` with `failureReason` /
  //   `failureCode` recorded for ops to investigate.

  async fail(
    settlementId: string,
    reason: string,
    options: { code?: string; retry?: boolean } = {},
    ctx: RevenueContext = {},
  ): Promise<SettlementDocument> {
    const opts = this.optsFromCtx(ctx);
    const settlement = (await this.getById(settlementId, opts)) as SettlementDocument | null;
    if (!settlement) throw new SettlementNotFoundError(settlementId);

    /**
     * CAS on the status this call OBSERVED — the validate above is read-then-write.
     *
     * A settlement moves PROCESSING → COMPLETED or → FAILED. Both `complete()` and
     * `fail()` read, decide, then write unconditionally, so a `fail()` racing a
     * `complete()` overwrote a COMPLETED settlement with FAILED and dispatched
     * SETTLEMENT_FAILED for a payout that had already gone out. Nothing threw: the
     * state machine had validated against a status that was true a moment earlier.
     *
     * `from: settlement.status` pins the observed state without changing WHICH
     * transitions are legal — the machine above still decides that. The retry branch
     * deliberately keeps its existing behaviour (it bypasses the machine by design),
     * but its counter becomes an atomic `$inc`: two concurrent retries previously both
     * read the same `retryCount` and wrote the same +1, so the retry budget under-
     * counted exactly when retries were flying.
     */
    const target = options.retry ? SETTLEMENT_STATUS.PENDING : SETTLEMENT_STATUS.FAILED;
    let patch: Record<string, unknown>;

    if (options.retry) {
      patch = {
        $inc: { retryCount: 1 },
        $set: {
          failureReason: reason,
          failureCode: options.code,
          scheduledAt: new Date(Date.now() + 3600000),
        },
      };
    } else {
      SETTLEMENT_STATE_MACHINE.validate(
        settlement.status as never,
        SETTLEMENT_STATUS.FAILED as never,
        settlementId,
      );
      patch = {
        $set: { failedAt: new Date(), failureReason: reason, failureCode: options.code },
      };
    }

    /**
     * `from` is the machine's OWN reverse lookup, not the status this call happened to
     * read. Any legal predecessor may win and the database authorizes the transition,
     * so there is no read-then-write window at all — primitives documents exactly this
     * pairing on `validSources`. The retry branch keeps `from: settlement.status`
     * because it deliberately bypasses the machine (PROCESSING → PENDING is not a
     * declared transition), so the machine has no opinion to borrow there.
     */
    const legalFrom = options.retry
      ? [settlement.status as never]
      : SETTLEMENT_STATE_MACHINE.validSources(SETTLEMENT_STATUS.FAILED as never);

    const claimed = await this.claim(settlementId, { from: legalFrom, to: target }, patch, opts);

    if (!claimed) {
      const current = (await this.getById(settlementId, opts)) as SettlementDocument | null;
      if (!current) throw new SettlementNotFoundError(settlementId);
      // Already where this call wanted it — a retried caller, not a conflict. Return
      // WITHOUT re-dispatching; a second SETTLEMENT_FAILED is the duplicated fact.
      if (current.status === target) return current;
      throw new InvalidStateTransitionError(
        'settlement',
        settlementId,
        String(current.status),
        String(target),
      );
    }

    const updated = claimed as SettlementDocument;

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SETTLEMENT_FAILED,
        { settlement: updated, reason, code: options.code, retry: options.retry },
        ctx,
        { resource: 'settlement', resourceId: (updated as { publicId?: string })?.publicId },
      ),
      ctx,
    );

    return updated;
  }

  // ─── Query: recipient balance ───────────────────────────────────────────
  //
  // The "wallet" rollup: how much the platform owes / has paid a recipient,
  // bucketed by settlement status. One tenant-scoped aggregation (the
  // `{ recipientId, status }` index backs the `$match`), so a host never
  // hand-rolls a raw `Model.aggregate` that would bypass multi-tenant scope.

  /**
   * Settlement money-state for an ARBITRARY filter — a recipient, an org, or
   * the whole platform (pass `_bypassTenant` in ctx to span every org). One
   * tenant-scoped `aggregatePipeline` (the `{ recipientId, status }` index backs
   * the `$match`), never a raw `Model.aggregate`. The reusable rollup behind
   * `recipientBalance`, platform reconciliation, and cross-org earnings.
   */
  async summary(
    filter: Record<string, unknown> = {},
    ctx: RevenueContext = {},
  ): Promise<SettlementSummary> {
    const now = new Date();
    const rows = await this.aggregatePipeline<{
      _id: { status: string; due: boolean };
      total: number;
      currency: string | null;
    }>(
      [
        { $match: filter },
        {
          $group: {
            // `due` only matters for pending — it splits escrowed (held,
            // scheduledAt in the future) from cleared (available, due now).
            _id: { status: '$status', due: { $lte: ['$scheduledAt', now] } },
            total: { $sum: '$amount' },
            currency: { $first: '$currency' },
          },
        },
      ],
      this.optsFromCtx(ctx),
    );

    const out = emptySettlementSummary();
    for (const row of rows) {
      foldSettlementStatus(out, row._id.status, row._id.due, row.total);
      if (row.currency && !out.currency) out.currency = row.currency;
    }
    out.lifetime = out.pending + out.processing + out.paidOut;
    return out;
  }

  /**
   * Per-recipient settlement rollup — one {@link RecipientBreakdown} per
   * distinct (recipientId, recipientType) matching `filter`. The list behind a
   * "who is owed what" view; pass `_bypassTenant` in ctx to span every org.
   *
   * ## Bounded by default, and why
   *
   * This groups every settlement row the filter matches. `$match` is
   * index-backed, but the `$group` that follows is O(matching rows) in time and
   * holds one bucket per distinct recipient in memory — and MongoDB kills a
   * `$group` at 100MB unless it is allowed to spill to disk. A platform with a
   * hundred thousand payees and years of history is exactly the deployment that
   * wants this view and exactly the one it falls over on. Worse, the failure
   * arrives late: it is fine in staging, fine for a year, and then it is not.
   *
   * So the pipeline carries its own `$sort` + `$limit` and returns at most
   * {@link DEFAULT_BREAKDOWN_LIMIT} recipients. Page with `after` (the last
   * `recipientId` you saw); a full result is one whose length is below the
   * limit. Ordering is by `recipientId` so the cursor is stable.
   *
   * Reconciliation genuinely does need every row, so `all: true` opts into the
   * unbounded scan and turns on disk spilling for it — deliberate, greppable,
   * and never what a dashboard does by accident.
   */
  async breakdownByRecipient(
    filter: Record<string, unknown> = {},
    ctx: RevenueContext = {},
    options: BreakdownOptions = {},
  ): Promise<RecipientBreakdown[]> {
    const now = new Date();
    const all = options.all === true;
    const limit = all
      ? undefined
      : Math.max(1, Math.min(options.limit ?? DEFAULT_BREAKDOWN_LIMIT, MAX_BREAKDOWN_LIMIT));
    if (all && options.limit !== undefined) {
      // Two contradictory instructions, and guessing which one the caller meant
      // is how an unbounded scan ships behind a limit that reads as a bound.
      throw new Error(
        '[revenue] breakdownByRecipient: pass either `all: true` or `limit`, not both.',
      );
    }
    const scoped =
      options.after !== undefined
        ? { $and: [filter, { recipientId: { $gt: options.after } }] }
        : filter;
    const rows = await this.aggregatePipeline<{
      _id: { recipientId: string; recipientType: string };
      buckets: Array<{ status: string; due: boolean; total: number }>;
      currency: string | null;
      role: string | null;
    }>(
      [
        { $match: scoped },
        /**
         * Per (recipient, status, due) — `due` splits pending into escrowed
         * (scheduled ahead) and cleared (payable now).
         */
        {
          $group: {
            _id: {
              recipientId: '$recipientId',
              recipientType: '$recipientType',
              status: '$status',
              due: { $lte: ['$scheduledAt', now] },
            },
            total: { $sum: '$amount' },
            currency: { $first: '$currency' },
            role: { $first: '$metadata.role' },
          },
        },
        /**
         * Collapse to ONE document per recipient before limiting.
         *
         * Without this second stage the `$limit` below would cut a recipient
         * in half — the first group emits a row per status, so "the first 200
         * rows" is not "the first 200 recipients" and the last one returned
         * would be missing whichever statuses fell past the boundary. Silently:
         * the row is present and its numbers are simply too low.
         */
        {
          $group: {
            _id: { recipientId: '$_id.recipientId', recipientType: '$_id.recipientType' },
            buckets: {
              $push: { status: '$_id.status', due: '$_id.due', total: '$total' },
            },
            currency: { $first: '$currency' },
            role: { $first: '$role' },
          },
        },
        // By recipientId, so `after` is a stable cursor rather than a guess at
        // whatever order the group happened to emit.
        { $sort: { '_id.recipientId': 1 } },
        ...(limit !== undefined ? [{ $limit: limit }] : []),
      ],
      {
        ...this.optsFromCtx(ctx),
        // Only for the deliberate full scan. A bounded call that needs disk is
        // a bounded call whose bound is wrong, and should fail saying so.
        ...(all ? { allowDiskUse: true } : {}),
      },
    );

    return rows.map((row) => {
      const out: RecipientBreakdown = {
        recipientId: row._id.recipientId,
        recipientType: row._id.recipientType,
        role: row.role ?? null,
        ...emptySettlementSummary(),
      };
      for (const bucket of row.buckets) {
        foldSettlementStatus(out, bucket.status, bucket.due, bucket.total);
      }
      if (row.currency && !out.currency) out.currency = row.currency;
      out.lifetime = out.pending + out.processing + out.paidOut;
      return out;
    });
  }

  /** One recipient's wallet — a thin `summary` over `{ recipientId, … }`. */
  async recipientBalance(
    recipientId: string,
    options: { recipientType?: string; currency?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<RecipientBalance> {
    const filter: Record<string, unknown> = { recipientId };
    if (options.recipientType !== undefined) filter.recipientType = options.recipientType;
    if (options.currency !== undefined) filter.currency = options.currency;
    const s = await this.summary(filter, ctx);
    return { recipientId, ...s, currency: options.currency ?? s.currency };
  }
}
