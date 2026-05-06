import { Repository, type PluginType } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { SettlementDocument } from '../models/settlement.schema.js';
import type { RevenueContext } from '../core/context.js';
import type { RevenueBridges } from '../bridges/revenue-bridges.js';
import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import type { OutboxStore } from '@classytic/primitives/outbox';
import { createEvent } from '../events/helpers.js';
import { REVENUE_EVENTS } from '../events/event-constants.js';
import { SETTLEMENT_STATUS } from '../enums/settlement.enums.js';
import { SETTLEMENT_STATE_MACHINE } from '../core/state-machines.js';
import { SettlementNotFoundError } from '../core/errors.js';

export interface SettlementRepoDeps {
  events: EventTransport;
  /** Host-owned outbox (PACKAGE_RULES §5.5 + P8). See TransactionRepoDeps. */
  outbox?: OutboxStore | undefined;
  bridges: RevenueBridges;
  logger?: { error(...args: unknown[]): void } | undefined;
}

export interface SettlementProcessingError {
  settlementId: SettlementDocument['_id'];
  error: unknown;
}

/**
 * SettlementRepository — data layer + domain verbs.
 *
 * CRUD inherited from mongokit. Domain verbs: schedule, processPending, complete, fail.
 *
 * Events are published via the injected `events` transport (arc-compatible).
 * Hosts subscribe glob-style via `revenue.events.subscribe('revenue:settlement.*', h)`.
 * See PACKAGE_RULES §13–§14.
 */
export class SettlementRepository extends Repository<SettlementDocument> {
  private deps!: SettlementRepoDeps;

  constructor(model: Model<SettlementDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  inject(deps: SettlementRepoDeps): void {
    this.deps = deps;
  }

  /**
   * Host-owned outbox save → in-process transport publish (PACKAGE_RULES P8).
   * Session-bound when `ctx.session` is present (atomic outbox row write).
   */
  private async dispatch(event: DomainEvent, ctx: RevenueContext = {}): Promise<void> {
    if (this.deps.outbox) {
      try {
        await this.deps.outbox.save(event, ctx.session !== undefined ? { session: ctx.session } : {});
      } catch (err) {
        this.deps.logger?.error('[revenue] outbox.save failed for', event.type, err);
      }
    }
    try {
      await this.deps.events.publish(event);
    } catch (err) {
      this.deps.logger?.error('[revenue] events.publish failed for', event.type, err);
    }
  }

  // ─── Domain: Schedule ───

  async schedule(params: {
    organizationId: string; recipientId: string; recipientType: string;
    type: string; amount: number; currency: string; payoutMethod: string;
    sourceTransactionIds?: string[]; sourceSplitIds?: string[];
    scheduledAt?: Date; bankTransferDetails?: Record<string, unknown>;
    mobileWalletDetails?: Record<string, unknown>; cryptoDetails?: Record<string, unknown>;
    notes?: string; metadata?: Record<string, unknown>;
  }, ctx: RevenueContext = {}): Promise<SettlementDocument> {
    const settlement = await this.create({
      ...params, status: SETTLEMENT_STATUS.PENDING,
      scheduledAt: params.scheduledAt ?? new Date(), retryCount: 0,
    } as any);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SETTLEMENT_SCHEDULED,
        { settlement, scheduledAt: (settlement as any).scheduledAt },
        ctx,
        { resource: 'settlement', resourceId: (settlement as any).publicId },
      ),
      ctx,
    );
    return settlement;
  }

  // ─── Domain: Process Pending ───

  async processPending(options: { limit?: number; organizationId?: string; payoutMethod?: string; dryRun?: boolean } = {}, ctx: RevenueContext = {}): Promise<{ processed: number; succeeded: number; failed: number; settlements: SettlementDocument[]; errors: SettlementProcessingError[] }> {
    const query: Record<string, unknown> = { status: 'pending', scheduledAt: { $lte: new Date() } };
    if (options.organizationId) query.organizationId = options.organizationId;
    if (options.payoutMethod) query.payoutMethod = options.payoutMethod;
    const result = await this.getAll({ filters: query, limit: options.limit ?? 50, sort: { scheduledAt: 1 } });
    const pending = (result as any).data ?? [];

    if (options.dryRun) return { processed: pending.length, succeeded: 0, failed: 0, settlements: pending, errors: [] };

    const results: { processed: number; succeeded: number; failed: number; settlements: SettlementDocument[]; errors: SettlementProcessingError[] } = {
      processed: 0, succeeded: 0, failed: 0, settlements: [], errors: [],
    };

    for (const settlement of pending) {
      try {
        SETTLEMENT_STATE_MACHINE.validate(settlement.status as any, SETTLEMENT_STATUS.PROCESSING as any, String(settlement._id));
        await this.update(settlement._id, { status: SETTLEMENT_STATUS.PROCESSING, processedAt: new Date() });
        results.succeeded++;
        results.settlements.push(settlement);

        await this.dispatch(
          createEvent(
            REVENUE_EVENTS.SETTLEMENT_PROCESSING,
            { settlement, processedAt: new Date() },
            ctx,
            { resource: 'settlement', resourceId: (settlement as any).publicId },
          ),
          ctx,
        );
      } catch (err) {
        results.failed++;
        results.errors.push({ settlementId: settlement._id, error: err });
      }
      results.processed++;
    }

    return results;
  }

  // ─── Domain: Complete ───

  async complete(settlementId: string, details: {
    transferReference?: string; transferredAt?: Date; transactionHash?: string; notes?: string; metadata?: Record<string, unknown>;
  } = {}, ctx: RevenueContext = {}): Promise<SettlementDocument> {
    const settlement = await this.getById(settlementId) as SettlementDocument | null;
    if (!settlement) throw new SettlementNotFoundError(settlementId);

    SETTLEMENT_STATE_MACHINE.validate(settlement.status as any, SETTLEMENT_STATUS.COMPLETED as any, settlementId);

    const updates: Record<string, unknown> = {
      status: SETTLEMENT_STATUS.COMPLETED, completedAt: new Date(),
      notes: details.notes, metadata: { ...settlement.metadata, ...details.metadata },
    };
    if (details.transferReference) {
      updates.bankTransferDetails = { ...(settlement.bankTransferDetails as any), transferReference: details.transferReference, transferredAt: details.transferredAt ?? new Date() };
    }
    if (details.transactionHash) {
      updates.cryptoDetails = { ...(settlement.cryptoDetails as any), transactionHash: details.transactionHash, transferredAt: details.transferredAt ?? new Date() };
    }

    const updated = await this.update(settlementId, updates, { throwOnNotFound: true });
    if (!updated) throw new SettlementNotFoundError(settlementId);

    await this.deps.bridges.ledger?.onSettlementCompleted?.(updated as any, ctx);
    await this.deps.bridges.notification?.onSettlementCompleted?.(updated as any, ctx);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SETTLEMENT_COMPLETED,
        { settlement: updated, completedAt: new Date() },
        ctx,
        { resource: 'settlement', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );
    return updated;
  }

  // ─── Domain: Fail ───

  async fail(settlementId: string, reason: string, options: { code?: string; retry?: boolean } = {}, ctx: RevenueContext = {}): Promise<SettlementDocument> {
    const settlement = await this.getById(settlementId) as SettlementDocument | null;
    if (!settlement) throw new SettlementNotFoundError(settlementId);

    if (options.retry) {
      await this.update(settlementId, {
        status: SETTLEMENT_STATUS.PENDING,
        retryCount: (settlement.retryCount ?? 0) + 1,
        failureReason: reason, failureCode: options.code,
        scheduledAt: new Date(Date.now() + 3600000),
      });
    } else {
      SETTLEMENT_STATE_MACHINE.validate(settlement.status as any, SETTLEMENT_STATUS.FAILED as any, settlementId);
      await this.update(settlementId, {
        status: SETTLEMENT_STATUS.FAILED, failedAt: new Date(),
        failureReason: reason, failureCode: options.code,
      });
    }

    const updated = await this.getById(settlementId) as SettlementDocument;

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SETTLEMENT_FAILED,
        { settlement: updated, reason, code: options.code, retry: options.retry },
        ctx,
        { resource: 'settlement', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated;
  }
}
