import type { PluginType } from '@classytic/mongokit';
import { addDays, addMonths, addYears } from '@classytic/primitives/calendar';
import type { Model } from 'mongoose';
import type { SubscriptionDocument } from '../models/subscription.schema.js';
import type { RevenueContext } from '../core/context.js';
import { createEvent } from '../events/helpers.js';
import { REVENUE_EVENTS } from '../events/event-constants.js';
import { SUBSCRIPTION_STATUS } from '../enums/subscription.enums.js';
import { SUBSCRIPTION_STATE_MACHINE } from '../core/state-machines.js';
import { SubscriptionNotFoundError } from '../core/errors.js';
import { RevenueRepositoryBase, type BaseRevenueRepoDeps } from './base.repository.js';

/**
 * Deps for {@link SubscriptionRepository}. Currently identical to
 * {@link BaseRevenueRepoDeps} (events / outbox? / logger?). Kept as its
 * own type alias so future subscription-specific deps (e.g. a billing
 * engine handle) can land without touching every callsite — and so the
 * `inject(deps)` signature reads as `SubscriptionRepoDeps` at the
 * engine factory.
 */
export type SubscriptionRepoDeps = BaseRevenueRepoDeps;

/**
 * SubscriptionRepository — data layer + domain verbs for the recurring-
 * billing lifecycle.
 *
 * **CRUD inherited** from mongokit (via {@link RevenueRepositoryBase}):
 * `getById`, `getByQuery`, `getAll`, `create`, `update`, `delete`,
 * `findOneAndUpdate`, `count`, `exists`, `claim`, `cursor`, `updateMany`,
 * `deleteMany`. All participate in `multiTenantPlugin` scope filtering
 * when wired.
 *
 * **Domain verbs (state transitions):** `activate`, `cancel`, `pause`,
 * `resume`. Each runs the state-machine guard (`SUBSCRIPTION_STATE_MACHINE`
 * — invalid transitions throw, never silently no-op), persists the
 * resulting writes through {@link RevenueRepositoryBase.optsFromCtx} so
 * tenant scope is preserved end-to-end, then dispatches its
 * `revenue:subscription.*` event via {@link RevenueRepositoryBase.dispatch}.
 *
 * **Multi-tenant correctness.** Every internal `getById`/`update` call
 * threads `ctx.organizationId` through `optsFromCtx(ctx)`. Without this
 * threading the inner read would either throw
 * `Missing 'organizationId' in context` (when `multiTenantPlugin` is
 * required) or — worse — return another tenant's subscription matching
 * the same `_id` shape (when `required: false`). 2.1.0 had this bug; 2.1.1+
 * is correct.
 *
 * @example Activate a pending sub
 * ```ts
 * const ctx = { organizationId: 'org_42', actorId: 'user_99' };
 * const sub = await subRepo.create(
 *   { customerId: 'cust_1', planKey: 'monthly', amount: 999, currency: 'USD',
 *     status: SUBSCRIPTION_STATUS.PENDING, isActive: false },
 *   ctx,
 * );
 * await subRepo.activate(String(sub._id), {}, ctx);
 * ```
 */
export class SubscriptionRepository extends RevenueRepositoryBase<
  SubscriptionDocument,
  SubscriptionRepoDeps
> {
  constructor(model: Model<SubscriptionDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  // ─── Domain: Activate ───────────────────────────────────────────────────
  //
  // pending|trialing → active. Stamps `activatedAt` and computes `endDate`
  // from the plan cycle; `monthly` adds 1 month, `quarterly` 3 months,
  // `yearly` 1 year, anything else (e.g. custom) defaults to 30 days.
  // Resume from `paused` is handled separately by `resume()` — calling
  // `activate` on an already-active sub is a state-machine error.

  async activate(
    subscriptionId: string,
    options: { timestamp?: Date } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const opts = this.optsFromCtx(ctx);
    const sub = (await this.getById(subscriptionId, opts)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(
      sub.status as never,
      SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionId,
    );

    const now = options.timestamp ?? new Date();
    // Calendar math via primitives (never local `setMonth`): UTC-stable
    // regardless of the deploy machine's TZ, and month-ends clamp instead of
    // overflowing (Jan 31 + 1 month → Feb 28/29, NOT Mar 2/3).
    const endDate =
      sub.planKey === 'monthly' ? addMonths(now, 1)
      : sub.planKey === 'quarterly' ? addMonths(now, 3)
      : sub.planKey === 'yearly' ? addYears(now, 1)
      : addDays(now, 30);

    const updated = await this.update(
      subscriptionId,
      {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        isActive: true,
        activatedAt: now,
        endDate,
      },
      this.optsFromCtx(ctx, { throwOnNotFound: true }),
    );
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_ACTIVATED,
        { subscription: updated, activatedAt: now },
        ctx,
        { resource: 'subscription', resourceId: (updated as { publicId?: string })?.publicId },
      ),
      ctx,
    );

    return updated;
  }

  // ─── Domain: Cancel ─────────────────────────────────────────────────────
  //
  // Two flavours:
  // - `immediate: true` flips status to `cancelled` right now and stops billing.
  // - default queues a "cancel at period end" — sub stays active until
  //   `endDate`, then a separate sweep flips it (host responsibility).
  //
  // Either way, `cancellationReason` is recorded. Reactivating a queued
  // cancel pre-`endDate` is a separate user flow (call `update` to clear
  // `cancelAt`); we don't expose a verb because the use case is rare.

  async cancel(
    subscriptionId: string,
    options: { immediate?: boolean; reason?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const opts = this.optsFromCtx(ctx);
    const sub = (await this.getById(subscriptionId, opts)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(
      sub.status as never,
      SUBSCRIPTION_STATUS.CANCELLED,
      subscriptionId,
    );

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

    const updated = await this.update(
      subscriptionId,
      updates,
      this.optsFromCtx(ctx, { throwOnNotFound: true }),
    );
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_CANCELLED,
        { subscription: updated, immediate: options.immediate, reason: options.reason },
        ctx,
        { resource: 'subscription', resourceId: (updated as { publicId?: string })?.publicId },
      ),
      ctx,
    );

    return updated;
  }

  // ─── Domain: Pause ──────────────────────────────────────────────────────
  //
  // active → paused. Stops billing without ending the sub. Stamps
  // `pausedAt` so `resume({ extendPeriod: true })` can compute the lost
  // window and shift `endDate` forward — keeping the customer's full
  // remaining period intact across the pause.

  async pause(
    subscriptionId: string,
    options: { reason?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const opts = this.optsFromCtx(ctx);
    const sub = (await this.getById(subscriptionId, opts)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(
      sub.status as never,
      SUBSCRIPTION_STATUS.PAUSED,
      subscriptionId,
    );

    const updated = await this.update(
      subscriptionId,
      {
        status: SUBSCRIPTION_STATUS.PAUSED,
        isActive: false,
        pausedAt: new Date(),
        pauseReason: options.reason,
      },
      this.optsFromCtx(ctx, { throwOnNotFound: true }),
    );
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_PAUSED,
        { subscription: updated, reason: options.reason },
        ctx,
        { resource: 'subscription', resourceId: (updated as { publicId?: string })?.publicId },
      ),
      ctx,
    );

    return updated;
  }

  // ─── Domain: Resume ─────────────────────────────────────────────────────
  //
  // paused → active. With `extendPeriod: true`, shifts `endDate` forward
  // by the pause duration so the customer keeps the full remainder of
  // their period (the typical "vacation mode" UX). Without it, the sub
  // simply re-activates and the original `endDate` ticks down through
  // the pause — billing resumes early. Most SaaS uses extend; pre-paid
  // gym memberships sometimes use the strict variant.

  async resume(
    subscriptionId: string,
    options: { extendPeriod?: boolean } = {},
    ctx: RevenueContext = {},
  ): Promise<SubscriptionDocument> {
    const opts = this.optsFromCtx(ctx);
    const sub = (await this.getById(subscriptionId, opts)) as SubscriptionDocument | null;
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    SUBSCRIPTION_STATE_MACHINE.validate(
      sub.status as never,
      SUBSCRIPTION_STATUS.ACTIVE,
      subscriptionId,
    );

    const updates: Record<string, unknown> = {
      status: SUBSCRIPTION_STATUS.ACTIVE,
      isActive: true,
    };
    if (options.extendPeriod && sub.pausedAt && sub.endDate) {
      const pauseDuration = Date.now() - sub.pausedAt.getTime();
      updates.endDate = new Date(sub.endDate.getTime() + pauseDuration);
    }

    const updated = await this.update(
      subscriptionId,
      updates,
      this.optsFromCtx(ctx, { throwOnNotFound: true }),
    );
    if (!updated) throw new SubscriptionNotFoundError(subscriptionId);

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.SUBSCRIPTION_RESUMED,
        { subscription: updated, extendPeriod: options.extendPeriod },
        ctx,
        { resource: 'subscription', resourceId: (updated as { publicId?: string })?.publicId },
      ),
      ctx,
    );

    return updated;
  }
}
