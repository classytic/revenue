import type { PluginType } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { SettlementDocument } from '../models/settlement.schema.js';
import type { RevenueContext } from '../core/context.js';
import type { RevenueBridges } from '../bridges/revenue-bridges.js';
import { createEvent } from '../events/helpers.js';
import { REVENUE_EVENTS } from '../events/event-constants.js';
import { SETTLEMENT_STATUS } from '../enums/settlement.enums.js';
import { SETTLEMENT_STATE_MACHINE } from '../core/state-machines.js';
import { SettlementNotFoundError } from '../core/errors.js';
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

    if (options.retry) {
      await this.update(
        settlementId,
        {
          status: SETTLEMENT_STATUS.PENDING,
          retryCount: (settlement.retryCount ?? 0) + 1,
          failureReason: reason,
          failureCode: options.code,
          scheduledAt: new Date(Date.now() + 3600000),
        },
        opts,
      );
    } else {
      SETTLEMENT_STATE_MACHINE.validate(
        settlement.status as never,
        SETTLEMENT_STATUS.FAILED as never,
        settlementId,
      );
      await this.update(
        settlementId,
        {
          status: SETTLEMENT_STATUS.FAILED,
          failedAt: new Date(),
          failureReason: reason,
          failureCode: options.code,
        },
        opts,
      );
    }

    const updated = (await this.getById(settlementId, opts)) as SettlementDocument;

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

  async recipientBalance(
    recipientId: string,
    options: { recipientType?: string; currency?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<RecipientBalance> {
    const match: Record<string, unknown> = { recipientId };
    if (options.recipientType !== undefined) match.recipientType = options.recipientType;
    if (options.currency !== undefined) match.currency = options.currency;

    const now = new Date();
    const rows = await this.aggregatePipeline<{
      _id: { status: string; due: boolean };
      total: number;
      currency: string | null;
    }>(
      [
        { $match: match },
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

    const balance: RecipientBalance = {
      recipientId,
      currency: options.currency ?? null,
      pending: 0,
      held: 0,
      available: 0,
      processing: 0,
      paidOut: 0,
      failed: 0,
      lifetime: 0,
    };

    for (const row of rows) {
      switch (row._id.status) {
        case SETTLEMENT_STATUS.PENDING:
          balance.pending += row.total;
          if (row._id.due) balance.available += row.total;
          else balance.held += row.total;
          break;
        case SETTLEMENT_STATUS.PROCESSING:
          balance.processing += row.total;
          break;
        case SETTLEMENT_STATUS.COMPLETED:
          balance.paidOut += row.total;
          break;
        case SETTLEMENT_STATUS.FAILED:
          balance.failed += row.total;
          break;
        default:
          break; // cancelled and any future status don't count toward the wallet
      }
      if (row.currency && !balance.currency) balance.currency = row.currency;
    }

    balance.lifetime = balance.pending + balance.processing + balance.paidOut;
    return balance;
  }
}
