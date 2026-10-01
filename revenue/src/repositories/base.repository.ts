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
 *      the audit plugins, and `withTransaction`
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
import { UnmanagedSessionError } from '../core/errors.js';
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
  /**
   * Who delivers an outbox-backed event — the engine's policy, the order kernel's contract:
   *   'relay'  — the row is the delivery; nothing is published live.
   *   'inline' — publish live, then acknowledge the row so the relay does not deliver it again.
   * Absent means 'inline'.
   */
  dispatch?: RevenueDispatchMode | undefined;
  /** Fired once an event's row has committed — the host nudges its relay here. Never throws into the caller. */
  afterCommit?: ((info: { events: readonly DomainEvent[]; dispatch: RevenueDispatchMode }) => void) | undefined;
}

/** See {@link BaseRevenueRepoDeps.dispatch}. */
export type RevenueDispatchMode = 'inline' | 'relay';

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
   * instance during {@link defineRevenue} bootstrap. Subclasses with
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
    // Superadmin cross-org bypass. `RevenueContext._bypassTenant` is a caller-facing
    // convenience; it maps to mongokit's CANONICAL per-call escape hatch `bypassTenant`
    // (what `systemContext()` also emits), so the multi-tenant plugin's native handling
    // applies — no revenue-local `skipWhen` callback duplicating that policy. Trusted
    // maintenance paths (the reconciliation scanner) pass `systemContext()` directly.
    if (ctx._bypassTenant === true) out.bypassTenant = true;
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
    // §P8.1 guard: a host session with NO outbox has no correct delivery
    // path — publishing now would leak ghost events on rollback.
    if (ctx.session && !this.deps.outbox) throw new UnmanagedSessionError();

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
    // Inside the host's transaction nothing is delivered — it may still roll back;
    // the relay delivers the committed row.
    if (ctx.session) return;
    await this.deliver(event);
  }

  /**
   * Deliver an event whose row (if any) has COMMITTED, per `deps.dispatch`. The one
   * delivery path — `dispatch()` and the phased post-commit publish both end here, so
   * the two cannot deliver differently.
   */
  protected async deliver(event: DomainEvent): Promise<void> {
    await this.deliverAll([event]);
  }

  /** Deliver one commit's events, then tell `afterCommit` ONCE — as the order kernel does per unit of work. */
  protected async deliverAll(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const mode: RevenueDispatchMode = this.deps.dispatch ?? 'inline';
    if (!(this.deps.outbox && mode === 'relay')) {
      for (const event of events) await this.publishLive(event);
    }
    this.notifyCommitted(events, mode);
  }

  private async publishLive(event: DomainEvent): Promise<void> {
    try {
      await this.deps.events.publish(event);
    } catch (err) {
      // The row (if any) stays pending — the relay is the retry.
      this.deps.logger?.error('[revenue] events.publish failed for', event.type, err);
      return;
    }
    if (!this.deps.outbox) return;
    try {
      await this.deps.outbox.acknowledge(event.meta.id);
    } catch (err) {
      this.deps.logger?.error('[revenue] outbox acknowledge failed for', event.type, event.meta.id, err);
    }
  }

  private notifyCommitted(events: readonly DomainEvent[], mode: RevenueDispatchMode): void {
    if (!this.deps.afterCommit) return;
    try {
      this.deps.afterCommit({ events, dispatch: mode });
    } catch (err) {
      this.deps.logger?.error('[revenue] afterCommit hook threw — ignored, the write is committed:', err);
    }
  }
}
