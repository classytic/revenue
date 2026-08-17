/**
 * Engine types for @classytic/revenue.
 *   - `RevenueShape` / `RevenueRuntime` — describe/bind inputs (see define-revenue.ts)
 *   - `RevenueEngine`   — frozen output (`models`, `repositories`, `providers`, `events`, `config`)
 *   - `ResolvedRevenueConfig` — defaults applied at bind
 *
 * The construction API is describe/bind: `defineRevenue(shape).bind(connection, runtime)`.
 * There is no `createRevenue` wrapper and no flat `RevenueConfig`.
 */
import type { CurrencyCode } from '@classytic/primitives/currency';
import type { RevenueContext } from '../core/context.js';
import type { BankFeedProviderRegistry } from '../providers/bank-feed.js';
import type { RevenueModels } from '../models/create-models.js';
import type { RevenueRepositories } from '../repositories/create-repositories.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { EventTransport } from '@classytic/primitives/events';
import type { ResolvedTenantConfig } from '@classytic/repo-core/tenant';

export type { RevenueContext };

export interface RevenueLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

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

/**
 * Per-index opt-in for the bank-feed lifecycle. Each flag controls one
 * MongoDB index on the `Transaction` collection. Defaults are tuned for
 * "moderate use" — required indexes are on, dashboard indexes are on,
 * heavy reconciliation indexes are off.
 */
export interface BankFeedIndexConfig {
  /**
   * `(orgId, bankAccountId, externalId)` partial unique index. Required
   * for `import()` to enforce idempotent re-import. Default: `true`.
   */
  idempotentImport?: boolean | undefined;

  /**
   * `(bankAccountId, postedDate -1)` partial — drives the treasurer
   * dashboard. Cheap; on by default.
   */
  byAccount?: boolean | undefined;

  /**
   * `(kind, amount, postedDate)` and `(kind, amount, createdAt)` —
   * back the cross-reference query in `findMatchCandidates`. Two
   * compound indexes; on when you actively reconcile. Default: `false`.
   */
  matchCandidates?: boolean | undefined;
}

/**
 * Bank-feed module configuration. Pass `true` for defaults, `false` to
 * disable the module (skips the bulkWrite plugin + every bank-feed
 * index), or an object to fine-tune indexes.
 */
export interface BankFeedModuleConfig {
  enabled?: boolean | undefined;
  indexes?: BankFeedIndexConfig | undefined;
}

/** Resolved module set after defaults are applied at describe time. */
export interface ResolvedRevenueModules {
  subscription: boolean;
  escrow: boolean;
  settlement: boolean;
  bankFeed: boolean;
}

/**
 * The engine's resolved configuration snapshot (frozen). Describe-time shape decisions plus the
 * bind-time default currency — enough to introspect what the engine was built with, without
 * leaking runtime collaborators (transport/providers/bridges) that have their own accessors.
 */
export interface ResolvedRevenueConfig {
  scope: ResolvedTenantConfig;
  modules: ResolvedRevenueModules;
  /** Validated + branded at bind. Raw config input is a plain string. */
  defaultCurrency: CurrencyCode;
  collectionPrefix?: string | undefined;
  forceRecreate: boolean;
}

/**
 * RevenueEngine — no service facade.
 *
 * Repositories ARE the domain layer. CRUD is inherited from mongokit. Domain verbs
 * (verify, refund, hold, activate, etc.) live on repositories. Arc's BaseController/adapter
 * plugs into repositories directly.
 *
 * `events` is structurally compatible with `@classytic/arc`'s `EventTransport`. Hosts subscribe
 * glob-style: `await revenue.events.subscribe('revenue:payment.*', handler)`. See PACKAGE_RULES §13.
 */
export interface RevenueEngine {
  /** Resolved configuration snapshot (frozen). */
  config: Readonly<ResolvedRevenueConfig>;
  models: RevenueModels;
  repositories: RevenueRepositories;
  providers: ProviderRegistry;
  /**
   * Bank-feed providers registry (3.0). Populated when the `bankFeed`
   * module is enabled and `bankFeedProviders` runtime is non-empty. Hosts can
   * `register` providers at runtime too.
   */
  bankFeedProviders: BankFeedProviderRegistry;
  events: EventTransport;
  /** Explicitly build all schema-declared indexes. Non-destructive. Never called by `bind()`. */
  syncIndexes(): Promise<void>;
  /**
   * Release resources owned by this engine. Idempotent. The kernel-standard lifecycle name.
   * Closes ONLY an internally-created transport — a host-supplied `eventTransport` is never closed.
   */
  close(): Promise<void>;
}
