import { Repository, type PluginType } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { SubscriptionDocument } from '../models/subscription.schema.js';
import type { RevenueContext } from '../core/context.js';
import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import type { OutboxStore } from '@classytic/primitives/outbox';
import { createEvent } from '../events/helpers.js';
import { REVENUE_EVENTS } from '../events/event-constants.js';
import { SUBSCRIPTION_STATUS } from '../enums/subscription.enums.js';
import { SUBSCRIPTION_STATE_MACHINE } from '../core/state-machines.js';
import { SubscriptionNotFoundError } from '../core/errors.js';

export interface SubscriptionRepoDeps {
  events: EventTransport;
  /** Host-owned outbox (PACKAGE_RULES §5.5 + P8). See TransactionRepoDeps. */
  outbox?: OutboxStore | undefined;
  logger?: { error(...args: unknown[]): void } | undefined;
}

/**
 * SubscriptionRepository — data layer + domain verbs.
 *
 * CRUD inherited from mongokit. Domain verbs: activate, cancel, pause, resume.
 *
 * Events: each domain verb calls `this.deps.events.publish(createEvent(...))`
 * with a fully-qualified `REVENUE_EVENTS.*` name. Hosts can subscribe glob-style
 * via `revenue.events.subscribe('revenue:subscription.*', handler)` — the
 * injected transport is arc-compatible (PACKAGE_RULES §13–§14).
 */
export class SubscriptionRepository extends Repository<SubscriptionDocument> {
  private deps!: SubscriptionRepoDeps;

  constructor(model: Model<SubscriptionDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  inject(deps: SubscriptionRepoDeps): void {
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

  // ─── Domain: Activate ───

  async activate(
    subscriptionId: string,
    options: { timestamp?: Date } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const sub = (await this.getById(subscriptionId)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(sub.status as any, SUBSCRIPTION_STATUS.ACTIVE, subscriptionId);

    const now = options.timestamp ?? new Date();
    const endDate = new Date(now);
    if (sub.planKey === 'monthly') endDate.setMonth(endDate.getMonth() + 1);
    else if (sub.planKey === 'quarterly') endDate.setMonth(endDate.getMonth() + 3);
    else if (sub.planKey === 'yearly') endDate.setFullYear(endDate.getFullYear() + 1);
    else endDate.setDate(endDate.getDate() + 30);

    const updated = await this.update(
      subscriptionId,
      {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        isActive: true,
        activatedAt: now,
        endDate,
      },
      { throwOnNotFound: true },
    );
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_ACTIVATED,
        { subscription: updated, activatedAt: now },
        ctx,
        { resource: 'subscription', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated;
  }

  // ─── Domain: Cancel ───

  async cancel(
    subscriptionId: string,
    options: { immediate?: boolean; reason?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const sub = (await this.getById(subscriptionId)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(sub.status as any, SUBSCRIPTION_STATUS.CANCELLED, subscriptionId);

    const updates: Record<string, unknown> = {
      status: SUBSCRIPTION_STATUS.CANCELLED,
      isActive: false,
      canceledAt: new Date(),
      cancellationReason: options.reason,
    };
    if (!options.immediate && sub.endDate) {
      updates.cancelAt = sub.endDate;
      updates.status = sub.status;
      updates.isActive = sub.isActive;
      delete updates.canceledAt;
    }

    const updated = await this.update(subscriptionId, updates, { throwOnNotFound: true });
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_CANCELLED,
        { subscription: updated, immediate: options.immediate, reason: options.reason },
        ctx,
        { resource: 'subscription', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated;
  }

  // ─── Domain: Pause ───

  async pause(
    subscriptionId: string,
    options: { reason?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const sub = (await this.getById(subscriptionId)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(sub.status as any, SUBSCRIPTION_STATUS.PAUSED, subscriptionId);

    const updated = await this.update(
      subscriptionId,
      {
        status: SUBSCRIPTION_STATUS.PAUSED,
        isActive: false,
        pausedAt: new Date(),
        pauseReason: options.reason,
      },
      { throwOnNotFound: true },
    );
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_PAUSED,
        { subscription: updated, reason: options.reason },
        ctx,
        { resource: 'subscription', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated;
  }

  // ─── Domain: Resume ───

  async resume(
    subscriptionId: string,
    options: { extendPeriod?: boolean } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const sub = (await this.getById(subscriptionId)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(sub.status as any, SUBSCRIPTION_STATUS.ACTIVE, subscriptionId);

    const updates: Record<string, unknown> = { status: SUBSCRIPTION_STATUS.ACTIVE, isActive: true };
    if (options.extendPeriod && sub.pausedAt && sub.endDate) {
      const pauseDuration = Date.now() - sub.pausedAt.getTime();
      updates.endDate = new Date(sub.endDate.getTime() + pauseDuration);
    }

    const updated = await this.update(subscriptionId, updates, { throwOnNotFound: true });
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_RESUMED,
        { subscription: updated, extendPeriod: options.extendPeriod },
        ctx,
        { resource: 'subscription', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated;
  }
}
