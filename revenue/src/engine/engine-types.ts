import type { Connection } from 'mongoose';
import type { RevenueContext } from '../core/context.js';
import type { RevenueBridges } from '../bridges/revenue-bridges.js';
import type { PaymentProvider } from '../providers/base.js';
import type { RevenueModels, RevenueSchemaOptions } from '../models/create-models.js';
import type { RevenueRepositories, RepositoryPluginBundle } from '../repositories/create-repositories.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { EventTransport } from '@classytic/primitives/events';
import type { OutboxStore } from '@classytic/primitives/outbox';
import type { TenantConfig } from '@classytic/primitives/tenant';

export type { RevenueContext };

export interface CommissionConfig {
  defaultRate: number;
  gatewayFeeRate?: number | undefined;
  categoryRates?: Record<string, number> | undefined;
  gatewayRates?: Record<string, number> | undefined;
}

export interface RetryConfig {
  maxAttempts?: number | undefined;
  baseDelay?: number | undefined;
}

export interface RevenueConfig {
  connection: Connection;
  defaultCurrency: string;
  /**
   * Event transport — structurally compatible with `@classytic/arc`'s
   * `EventTransport`. Drop in any arc transport (Memory/Redis/Kafka) and it
   * works without an adapter. When omitted, the engine uses
   * `InProcessRevenueBus` (a ~50-line match of arc's `MemoryEventTransport`).
   */
  eventTransport?: EventTransport | undefined;
  /**
   * Host-owned transactional outbox store (PACKAGE_RULES §5.5 + P8).
   * Structurally identical to `@classytic/arc`'s `OutboxStore` by design —
   * primitives is the source of truth for the contract and arc mirrors it.
   *
   * **Host responsibility.** Revenue does NOT ship a durable store. Arc 2.10
   * only ships `MemoryOutboxStore` (dev) + the `OutboxStore` interface — the
   * host wires durability. The canonical production wiring uses arc's
   * `repositoryAsOutboxStore` adapter over a mongokit `Repository`:
   *
   * ```ts
   * import mongoose, { Schema } from 'mongoose';
   * import {
   *   Repository,
   *   methodRegistryPlugin,
   *   batchOperationsPlugin,
   * } from '@classytic/mongokit';
   * import { EventOutbox, repositoryAsOutboxStore } from '@classytic/arc/events';
   * import { createRevenue } from '@classytic/revenue';
   *
   * // Arc owns the on-disk doc shape — strict:false forwards every field
   * // (see arc's events.mdx "Why strict: false").
   * const OutboxModel = mongoose.model(
   *   'ArcOutbox',
   *   new Schema({}, { strict: false, timestamps: false, _id: false }),
   *   'event_outbox',
   * );
   *
   * // Required plugins: the adapter calls `create` / `findAll` /
   * // `findOneAndUpdate` (base Repository) + `deleteMany` (batchOperations).
   * const outboxRepo = new Repository(OutboxModel, [
   *   methodRegistryPlugin(),
   *   batchOperationsPlugin(),
   * ]);
   * const outbox = repositoryAsOutboxStore(outboxRepo);
   *
   * const engine = await createRevenue({
   *   connection: mongoose.connection,
   *   defaultCurrency: 'USD',
   *   outbox,                       // revenue's dispatch saves here
   *   eventTransport: app.events,   // arc transport for in-process subscribers
   *   // ...
   * });
   *
   * // Relay + DLQ live in the host, not the package:
   * const relay = new EventOutbox({ store: outbox, transport: app.events });
   * setInterval(() => relay.relay(), 1_000);
   * ```
   *
   * **Session-bound atomicity.** Revenue's transactional verbs (`refund`,
   * `release`, `split`) open a mongokit `withTransaction` and pass the
   * mongoose `ClientSession` into `outbox.save(event, { session })`, so the
   * outbox row commits atomically with the business writes. Non-transactional
   * verbs (`createPaymentIntent`, `verify`, `handleWebhook`, `hold`) forward
   * `ctx.session` when the host is coordinating its own transaction — pass
   * `{ session }` in `RevenueContext` to participate.
   *
   * **Non-arc hosts.** Any `OutboxStore` works — implement the three-method
   * floor (`save` / `getPending` / `acknowledge`) over Postgres / Redis /
   * Kafka / SQS. When omitted, events flow to `eventTransport` only
   * (durability becomes transport-level, not at-least-once).
   */
  outbox?: OutboxStore | undefined;
  modules?: {
    subscription?: boolean | undefined;
    escrow?: boolean | undefined;
    settlement?: boolean | undefined;
    commission?: CommissionConfig | boolean | undefined;
  } | undefined;
  providers?: Record<string, PaymentProvider> | undefined;
  bridges?: RevenueBridges | undefined;
  repositoryPlugins?: RepositoryPluginBundle | undefined;
  schemaOptions?: RevenueSchemaOptions | undefined;
  /**
   * Tenant scope configuration. Delegates to `@classytic/primitives`'
   * `TenantConfig`. Field names match mongokit's `MultiTenantOptions` so
   * the resolved config forwards directly into `multiTenantPlugin(...)`.
   *
   * - `undefined` / `true` → default field strategy, ObjectId storage.
   * - `false` → single-tenant (no plugin, field still present, not required).
   * - `{ fieldType: 'string' }` → string orgIds (UUID/slug hosts).
   * - `{ strategy: 'custom', resolve: ... }` → composite / derived scope.
   *
   * See PACKAGE_RULES.md §9.
   */
  scope?: TenantConfig | boolean | undefined;
  commission?: CommissionConfig | undefined;
  retry?: RetryConfig | undefined;
  circuitBreaker?: boolean | undefined;
  /**
   * Set `false` to disable Mongoose auto-index on boot. Indexes are then
   * managed explicitly via `engine.syncIndexes()` or a deploy-time script.
   */
  autoIndex?: boolean | Partial<Record<'Transaction' | 'Subscription' | 'Settlement', boolean>> | undefined;
  /**
   * Optional prefix prepended to every physical collection this package
   * creates (see PACKAGE_RULES.md §20.1). Unset → default names
   * (`revenue_transactions`, `revenue_subscriptions`, `revenue_settlements`).
   * Model names and `ref:` populate are unaffected.
   */
  collectionPrefix?: string | undefined;
  /**
   * When true, existing Mongoose models with revenue's names are deleted
   * from the connection before re-registering. Hot-reload / test fixtures
   * only. Default `false` — collision throws `RevenueModelCollisionError`.
   * Hosts that need two revenue engines should use two Mongoose connections
   * (`mongoose.createConnection(...)`). See PACKAGE_RULES.md §21.
   */
  forceRecreate?: boolean | undefined;
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void } | undefined;
}

/**
 * RevenueEngine — no service facade.
 *
 * Repositories ARE the domain layer. CRUD is inherited from mongokit.
 * Domain verbs (verify, refund, hold, activate, etc.) live on repositories.
 * Arc's BaseController/adapter plugs into repositories directly.
 *
 * `events` is structurally compatible with `@classytic/arc`'s
 * `EventTransport`. Hosts subscribe glob-style:
 *
 *     await revenue.events.subscribe('revenue:payment.*', handler);
 *
 * and the same transport can be wired into the outbox relay for durable
 * delivery (see mongokit's `outbox-recipe.ts`). See PACKAGE_RULES §13.
 */
export interface RevenueEngine {
  config: Readonly<RevenueConfig>;
  models: RevenueModels;
  repositories: RevenueRepositories;
  providers: ProviderRegistry;
  events: EventTransport;
  /** Explicitly build all schema-declared indexes. Non-destructive. */
  syncIndexes(): Promise<void>;
  destroy(): Promise<void>;
}
