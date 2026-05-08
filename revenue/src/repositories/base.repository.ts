/**
 * RevenueRepositoryBase — shared scaffolding for every revenue repo.
 *
 * Eliminates the three places ctx-threading and event-dispatch were
 * hand-rolled (transaction / subscription / settlement) and previously
 * drifted: subscription + settlement repos forgot to forward
 * `ctx.organizationId` into their inner `getById` / `update` calls,
 * which surfaced as `Missing 'organizationId' in context for 'getById'`
 * the moment a host enabled `multiTenantPlugin` (the canonical 2026-Q2
 * bug — fixed in 2.1.1).
 *
 * Two responsibilities:
 *
 *   1. **Thread request context into mongokit options.** Every domain
 *      verb that touches the DB (read or write) ends with a mongokit
 *      method whose options bag is what `multiTenantPlugin`,
 *      `softDeletePlugin`, the audit plugins, and `withTransaction`
 *      read from. {@link optsFromCtx} centralises that translation
 *      using mongokit's typed extractor — adding a new canonical field
 *      to `RevenueContext` is now a single line, not three.
 *
 *   2. **Dispatch domain events.** Outbox-save (session-bound when the
 *      caller threads a Mongoose `ClientSession`) followed by
 *      transport-publish, with isolated try/catch so a transport
 *      failure never aborts the business write. PACKAGE_RULES P8 / §5.5.
 *
 * Subclasses inject their domain-specific deps via {@link inject}; this
 * base only requires the cross-cutting trio (events / outbox / logger)
 * which every revenue repo has.
 *
 * @typeParam TDoc - The Mongoose document type the subclass operates on.
 * @typeParam TDeps - The full deps shape (must extend `BaseRevenueRepoDeps`).
 *
 * @example
 * ```ts
 * export class SubscriptionRepository extends RevenueRepositoryBase<
 *   SubscriptionDocument,
 *   SubscriptionRepoDeps
 * > {
 *   async activate(id: string, ctx: RevenueContext = {}) {
 *     const sub = await this.getById(id, this.optsFromCtx(ctx));
 *     // ...
 *     await this.dispatch(createEvent(...), ctx);
 *     return updated;
 *   }
 * }
 * ```
 */
import { Repository, type PluginType, repoOptionsFromCtx } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import type { OutboxStore } from '@classytic/primitives/outbox';
import type { RevenueContext } from '../core/context.js';

/**
 * Cross-cutting deps that every revenue repository needs.
 *
 * Subclasses extend this with their own bridges, providers, configs:
 *
 * ```ts
 * export interface SettlementRepoDeps extends BaseRevenueRepoDeps {
 *   bridges: RevenueBridges;
 * }
 * ```
 */
export interface BaseRevenueRepoDeps {
  /**
   * Domain-event transport (in-process or arc-compatible). All four
   * `revenue:*` event families (`payment.*`, `subscription.*`,
   * `settlement.*`, `escrow.*`) flow through this single channel; hosts
   * subscribe glob-style.
   */
  events: EventTransport;
  /**
   * Optional host-owned outbox (PACKAGE_RULES §5.5 + P8). When wired,
   * every dispatched event is persisted via `outbox.save(event)` BEFORE
   * `events.publish(event)` so a host relay (arc's EventOutbox, a Postgres
   * LISTEN/NOTIFY pump, Kafka Connect, …) can replay on transport
   * failure. When absent, events fire through `events.publish` only.
   */
  outbox?: OutboxStore | undefined;
  /**
   * Optional structured logger. Outbox/transport failures are logged
   * here rather than thrown — a downstream subscriber error never
   * cancels the upstream business write.
   */
  logger?: { error(...args: unknown[]): void } | undefined;
}

/**
 * Abstract base for `TransactionRepository`, `SubscriptionRepository`,
 * `SettlementRepository`.
 *
 * Concrete subclasses MUST:
 * - declare a `Deps` interface that extends {@link BaseRevenueRepoDeps}
 * - call `super(model, plugins)` from the constructor
 * - call `inject(deps)` once during engine boot
 *
 * Subclasses SHOULD use {@link optsFromCtx} for every mongokit call
 * that takes an options bag, and {@link dispatch} for every event
 * publish.
 */
export abstract class RevenueRepositoryBase<
  TDoc,
  TDeps extends BaseRevenueRepoDeps,
> extends Repository<TDoc> {
  /**
   * Subclass-specific deps. `!` because the engine wires this once via
   * `inject(deps)` immediately after construction; calling any domain
   * verb before injection is a programming error and the runtime
   * will fail-loud with `Cannot read properties of undefined`.
   */
  protected deps!: TDeps;

  constructor(model: Model<TDoc>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  /**
   * Wire engine-managed deps. Called exactly once per repository
   * instance during {@link createRevenue} bootstrap. Subclasses with
   * extra steps (caching, prebuilding state machine maps) override and
   * call `super.inject(deps)`.
   */
  inject(deps: TDeps): void {
    this.deps = deps;
  }

  /**
   * Translate {@link RevenueContext} into a mongokit options bag.
   *
   * Forwards every canonical field mongokit's bundled plugins read —
   * `organizationId` (multiTenant), `userId` / `user` (audit),
   * `session` (transactions), `requestId` (observability) — plus
   * the revenue-specific `_bypassTenant` flag for platform-admin
   * cross-org reads.
   *
   * Pass `extra` for caller-specific options like `throwOnNotFound`,
   * `lean`, `populate`, `select` — the spread is `extra`-first so
   * ctx wins on a key collision (intentional: callers shouldn't
   * be smuggling tenant fields through `extra`).
   *
   * @param ctx - The request-scoped revenue context.
   * @param extra - Additional mongokit options merged in.
   */
  protected optsFromCtx(
    ctx: RevenueContext = {},
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      ...extra,
      ...repoOptionsFromCtx(ctx as unknown as Record<string, unknown>),
    };
    // Revenue-specific flag — not part of mongokit's canonical set, but
    // the multi-tenant plugin's `skipWhen` reads it to allow superadmin
    // cross-org reads.
    if (ctx._bypassTenant === true) out._bypassTenant = true;
    return out;
  }

  /**
   * Persist an event to the host outbox, then publish to the in-process
   * transport. The two sides have asymmetric failure handling — see
   * PACKAGE_RULES §P8.
   *
   * When `ctx.session` is set, the outbox `save` runs inside the same
   * Mongoose transaction (true P8 session-bound write); when absent, the
   * outbox row lands after commit — still durable via the host's relay,
   * with only a small at-most-once window on process crash.
   *
   *   1. **`outbox.save` failures PROPAGATE.** If we can't durably record
   *      the event, the caller's transaction MUST roll back so the
   *      business doc and the event row land atomically (or neither
   *      lands). Swallowing a save failure breaks the transactional-
   *      outbox correctness argument — the parent doc would land while
   *      the event vanishes.
   *
   *   2. **`events.publish` failures are SWALLOWED.** The host's outbox
   *      relay re-publishes from the durable row on its next poll. Even
   *      without an outbox, in-process subscribers shouldn't be able to
   *      break the business operation — they're best-effort consumers.
   *
   * @param event - Pre-built domain event (use `createEvent(REVENUE_EVENTS.X, payload, ctx, meta)`).
   * @param ctx - The same context that produced the business write.
   */
  protected async dispatch(event: DomainEvent, ctx: RevenueContext = {}): Promise<void> {
    if (this.deps.outbox) {
      try {
        await this.deps.outbox.save(
          event,
          ctx.session !== undefined ? { session: ctx.session } : {},
        );
      } catch (err) {
        this.deps.logger?.error('[revenue] outbox.save failed for', event.type, err);
        throw err;
      }
    }
    try {
      await this.deps.events.publish(event);
    } catch (err) {
      this.deps.logger?.error('[revenue] events.publish failed for', event.type, err);
    }
  }
}
