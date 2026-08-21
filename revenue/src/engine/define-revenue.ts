/**
 * `defineRevenue` — the DESCRIBE/BIND blueprint for the revenue engine
 * (STANDARDIZATION-PLAN §6, Phase 3 pilot). Splits construction into two phases:
 *
 *   - **describe** (`defineRevenue(shape)`): pure. Resolves the tenant scope, the module set and
 *     the bank-feed index policy, and freezes the model names via `defineRevenueModels()`. No
 *     connection, no schema built, no I/O — safe at import / module-composition time.
 *   - **bind** (`blueprint.bind(connection, runtime)`): compiles + registers the models on the
 *     supplied connection, builds the plugin stacks and repositories, wires transport / outbox /
 *     providers / bridges, and returns the frozen `RevenueEngine`.
 *
 * This is the SOLE construction API — there is no `createRevenue` wrapper and no flat
 * `RevenueConfig`. Teardown is `close()` (never `destroy()`); collisions surface as mongokit's
 * `ModelCollisionError`.
 */
import {
  multiTenantPlugin,
  customIdPlugin,
  prefixedId,
  methodRegistryPlugin,
  batchOperationsPlugin,
  type PluginType,
} from '@classytic/mongokit';
import { resolveTenantConfig, type TenantConfig } from '@classytic/repo-core/tenant';
import type { Connection } from 'mongoose';
import { currencyCode } from '@classytic/primitives/currency';
import type { EventTransport } from '@classytic/primitives/events';
import type { OutboxStore } from '@classytic/primitives/outbox';
import type { PaymentProviderPort } from '@classytic/primitives/payment-gateway';
import {
  defineRevenueModels,
  type RevenueAutoIndex,
  type RevenueModels,
  type RevenueSchemaOptions,
} from '../models/create-models.js';
import type { ResolvedBankFeedIndexes } from '../models/transaction.schema.js';
import {
  createRevenueRepositories,
  type RepositoryPluginBundle,
} from '../repositories/create-repositories.js';
import { createProviderRegistry } from '../providers/registry.js';
import {
  createBankFeedProviderRegistry,
  type BankFeedProvider,
} from '../providers/bank-feed.js';
import { InProcessRevenueBus } from '../events/in-process-bus.js';
import { assertRevenueCapabilities, RevenueCapabilityError } from './ensure-ready.js';
import type { RevenueBridges } from '../bridges/revenue-bridges.js';
import type {
  BankFeedModuleConfig,
  CommissionConfig,
  ResolvedRevenueConfig,
  RevenueEngine,
  RevenueLogger,
} from './engine-types.js';
import type { TaxConfig } from '../shared/calculators/tax.js';

/**
 * DESCRIBE-time shape — everything that determines the persistence SHAPE and needs no connection
 * or I/O to inspect. Nothing here opens a socket, reads a secret or builds a provider client.
 */
export interface RevenueShape {
  /**
   * Tenant scope configuration (delegates to `@classytic/repo-core`'s `TenantConfig`).
   * `undefined` / `true` → default field strategy, ObjectId storage. `false` → single-tenant.
   * See PACKAGE_RULES.md §9.
   */
  scope?: TenantConfig | boolean | undefined;
  // NO softDelete option (2026-08-14). The kernel used to wire `softDeletePlugin({ttlDays: 365})`
  // unconditionally, with `deletedAt: null` clauses inside the `publicId` unique filters — an
  // unmaintained escape hatch from uniqueness. It was removed OUTRIGHT, not parameterized:
  // every use it claimed on payment data has a better mechanism (undo -> a restore surface
  // that never existed; retention -> the host's purge-window predicate; referential safety ->
  // cascade onDelete:'restrict'; lifecycle end -> a STATUS like refunded/voided/canceled).
  // A transaction is an immutable receipt — hiding one is never correct. BREAKING for a host
  // that relied on hidden rows: deletes are now honest hard deletes.
  modules?:
    | {
        subscription?: boolean | undefined;
        escrow?: boolean | undefined;
        settlement?: boolean | undefined;
        /** Object form supplies commission at describe time; boolean toggles the feature. */
        commission?: CommissionConfig | boolean | undefined;
        /**
         * Bank-feed / accounting-feed module (3.0). Default: enabled. `false` suppresses the
         * bulk-write plugin AND every bank-feed index. Pass an object to fine-tune indexes.
         */
        bankFeed?: boolean | BankFeedModuleConfig | undefined;
      }
    | undefined;
  schemaOptions?: RevenueSchemaOptions | undefined;
  /**
   * Optional prefix prepended to every physical collection this package creates
   * (see PACKAGE_RULES.md §20.1). Unset → default names. Model names / `ref:` unaffected.
   */
  collectionPrefix?: string | undefined;
  /**
   * Set `false` to disable Mongoose auto-index on boot (§35); indexes are then managed via
   * `engine.syncIndexes()`. A per-model map is also accepted.
   */
  autoIndex?: RevenueAutoIndex | undefined;
  /**
   * On a model-name collision: default throws (mongokit `ModelCollisionError`); `true`
   * re-registers via mongokit's `replace` policy (hot-reload / test fixtures only — refused
   * under `NODE_ENV=production`). Two engines should use two connections. See PACKAGE_RULES.md §21.
   */
  forceRecreate?: boolean | undefined;
}

/**
 * BIND-time runtime collaborators — the live connection is the first `bind` arg; these are the
 * rest. Transports, provider clients, bridges, loggers and stores belong here, not in the shape.
 */
export interface RevenueRuntime {
  /** Required — drives money validation/defaults; injected into every repository. */
  defaultCurrency: string;
  /**
   * Event transport (structurally `@classytic/arc`'s `EventTransport`). When omitted the engine
   * creates an `InProcessRevenueBus` which it OWNS and closes on `close()`. A supplied transport
   * (shared arc bus) is never closed by this engine.
   */
  eventTransport?: EventTransport | undefined;
  /**
   * Host-owned transactional outbox store (PACKAGE_RULES §5.5 + P8). Never shipped by
   * revenue.
   *
   * Optional — but when supplied it MUST declare `transactionalSave: true`. Revenue's
   * `dispatch()` saves the event row under `ctx.session`; a store that ignores the
   * session persists `payment.succeeded` for a capture that rolled back. `bind` refuses
   * one that does not declare it.
   */
  outbox?: OutboxStore | undefined;
  /** Payment providers, keyed by the name the engine resolves them under. Typed as the PORT. */
  providers?: Record<string, PaymentProviderPort> | undefined;
  /** Bank-feed providers (Plaid, OFX/CAMT/MT940/CSV, QBO/Xero CDC). */
  bankFeedProviders?: Record<string, BankFeedProvider> | undefined;
  bridges?: RevenueBridges | undefined;
  /** Overrides `modules.commission` only when the latter is not an object. */
  commission?: CommissionConfig | undefined;
  /**
   * Tax the engine applies to transactions it records. Omit and nothing changes.
   *
   * `rate` is a FRACTION (0.15), never a percentage — see `calculateTax`, which
   * divides by `1 + rate`. Passing 15 would compute `amount / 16` and return a
   * plausible number, so `defineRevenue` rejects a rate above 1 at bind rather
   * than letting a percent through as a fraction.
   */
  tax?: TaxConfig | (() => TaxConfig | Promise<TaxConfig>) | undefined;
  repositoryPlugins?: RepositoryPluginBundle | undefined;
  logger?: RevenueLogger | undefined;
  /**
   * Explicit, logged acceptance of a deployment that cannot run multi-document
   * transactions (a standalone `mongod`) — checked by the bind-time capability
   * gate (`assertRevenueCapabilities`).
   *
   * **Opt-IN, never opt-out.** Absent ⇒ `transactions` is REQUIRED and a
   * standalone fails the bind. Capture settlement and refund claim/rollback
   * write several documents per operation; without atomicity a crash
   * mid-refund can release the claim with the refund already sent, which is a
   * DOUBLE REFUND on the retry. A deployment that knowingly accepts that says
   * so here, where an operator can see it (AGENTS.md "specific beats
   * general").
   *
   * Waives ONLY `transactions`. `duplicateKeyError` and `upsert` are the
   * idempotency contract and stay unwaivable.
   */
  allowNonTransactional?: boolean | undefined;
}

export interface RevenueBlueprint {
  readonly id: 'revenue';
  /** The model names this blueprint registers — known without a connection. */
  readonly modelNames: readonly string[];
  /**
   * Compile + register the models on `connection`, wire the engine, and return it. Synchronous:
   * revenue's construction performs no async work (model registration, repo wiring and provider
   * registry building are all synchronous). The `KernelBlueprint` contract still permits async.
   */
  bind(connection: Connection, runtime: RevenueRuntime): RevenueEngine;
}

/**
 * Describe the revenue engine. Pure — registers no model, builds no schema, performs no I/O.
 */
export function defineRevenue(shape: RevenueShape = {}): RevenueBlueprint {
  // ── Resolve module set + bank-feed index policy (describe-time) ───────
  const bankFeedRaw = shape.modules?.bankFeed;
  const bankFeedEnabled =
    bankFeedRaw === false
      ? false
      : typeof bankFeedRaw === 'object' && bankFeedRaw !== null
        ? bankFeedRaw.enabled !== false
        : true; // `true` | `undefined` → on

  const userIndexCfg =
    typeof bankFeedRaw === 'object' && bankFeedRaw !== null ? bankFeedRaw.indexes : undefined;
  const bankFeedIndexes: ResolvedBankFeedIndexes = bankFeedEnabled
    ? {
        idempotentImport: userIndexCfg?.idempotentImport ?? true,
        byAccount: userIndexCfg?.byAccount ?? true,
        matchCandidates: userIndexCfg?.matchCandidates ?? false,
      }
    : { idempotentImport: false, byAccount: false, matchCandidates: false };

  const modules = {
    subscription: shape.modules?.subscription !== false,
    escrow: shape.modules?.escrow ?? false,
    settlement: shape.modules?.settlement ?? false,
    bankFeed: bankFeedEnabled,
  };

  const scope = resolveTenantConfig(shape.scope);
  const forceRecreate = shape.forceRecreate ?? false;

  // Single source of truth for the revenue model set.
  const modelBlueprint = defineRevenueModels({
    scope,
    modules: { subscription: modules.subscription, settlement: modules.settlement },
    bankFeedIndexes,
    ...(shape.schemaOptions !== undefined ? { schemaOptions: shape.schemaOptions } : {}),
    ...(shape.collectionPrefix !== undefined ? { collectionPrefix: shape.collectionPrefix } : {}),
    ...(shape.autoIndex !== undefined ? { autoIndex: shape.autoIndex } : {}),
    forceRecreate,
  });

  return {
    id: 'revenue',
    modelNames: modelBlueprint.modelNames,

    bind(connection: Connection, runtime: RevenueRuntime): RevenueEngine {
      /**
       * FIRST thing in bind, before a single model is touched.
       *
       * A tax RATE here is a FRACTION: `TaxConfig.defaultRate` feeds
       * `amount / (1 + rate)`, so 15 (a percent) yields `amount / 16` — roughly a
       * 94% tax — and nothing downstream can tell that from a real number. Country
       * config almost always states percentages (`tax.bd.defaultRate` is 15), so
       * this is the conversion a host gets wrong exactly once.
       *
       * It runs before model creation because a misconfigured rate is a STARTUP
       * error, not a runtime one — there is no point building an engine that will
       * mis-tax every transaction it records. Failing here is also what makes the
       * rule testable without a database.
       *
       * A VAT/GST rate at or above 100% does not exist, so no legitimate
       * configuration can trip this.
       */
      if (runtime?.tax && typeof runtime.tax !== 'function' && runtime.tax.defaultRate > 1) {
        throw new Error(
          `defineRevenue: tax.defaultRate must be a FRACTION, got ${runtime.tax.defaultRate}. ` +
            `A percentage looks like a fraction to the calculator and silently returns a wrong ` +
            `amount — pass ${runtime.tax.defaultRate / 100} for ${runtime.tax.defaultRate}%.`,
        );
      }

      /**
       * VERIFY (boot gate) — an injected outbox MUST enlist `ctx.session`.
       *
       * Checked FIRST, before the model blueprint binds: a cheaper error should report
       * before a costlier one, and a bind that throws must not have already mutated the
       * connection's model registry.
       *
       * `OutboxWriteOptions.session` is best-effort BY CONTRACT, so a hand-rolled store
       * type-checks and then persists events for money writes that later abort. Revenue
       * saves in-session everywhere (`RevenueRepositoryBase.dispatch`,
       * `TransactionRepositoryBase.saveToOutbox`) exactly so the transaction row and the
       * event row land together — a ghost `payment.succeeded` for a capture that rolled
       * back is a fulfilment, an entitlement, or a payout for money that never arrived.
       *
       * The existing per-call `UnmanagedSessionError` covers the OPPOSITE hole (a host
       * session with NO outbox). It cannot see this one: a store is present, `save()`
       * resolves, and nothing anywhere reports that the session was dropped.
       */
      if (runtime.outbox && runtime.outbox.transactionalSave !== true) {
        throw new RevenueCapabilityError(
          ['outbox.transactionalSave'],
          'The configured OutboxStore does not declare that `save()` enlists `ctx.session` ' +
            '(see @classytic/primitives/outbox). Revenue writes every event row inside the ' +
            "money write's transaction; a store that ignores the session emits events for " +
            'captures and refunds that rolled back. Arc\'s `repositoryAsOutboxStore` declares ' +
            'it; a hand-rolled or in-memory store must not.',
        );
      }

      const models: RevenueModels = modelBlueprint.bind(connection);

      // ── Plugin stacks (from resolved scope/modules) ──────────────────
      const buildPlugins = (prefix: string, extraPlugins: PluginType[] = []): PluginType[] => {
        const plugins: PluginType[] = [
          customIdPlugin({
            field: 'publicId',
            generator: prefixedId({ prefix, separator: '_', length: 20 }),
          }),
        ];
        if (scope.enabled && scope.strategy === 'field') {
          plugins.push(
            multiTenantPlugin({
              tenantField: scope.tenantField,
              fieldType: scope.fieldType,
              contextKey: scope.contextKey,
              required: scope.required,
              // Platform-admin bypass uses mongokit's NATIVE `bypassTenant: true` escape hatch
              // (emitted by `systemContext()`, mapped from `RevenueContext._bypassTenant` by
              // `optsFromCtx`). Authorization is the CALLER's responsibility — gate the bypass
              // behind a platform-role check; never forward it from untrusted input.
            }),
          );
        }
        // NO softDeletePlugin (2026-08-14) — see the RevenueShape note. Deletes are honest;
        // long-horizon disposal is the host's retention-gated archive purge, never a hidden row.
        plugins.push(...extraPlugins);
        return plugins;
      };

      // Transaction repo gets batch-operations so `bulkWrite` is available — the bank-feed
      // `import()` verb depends on it. `methodRegistryPlugin` is its prerequisite.
      const transactionExtraPlugins: PluginType[] = modules.bankFeed
        ? [methodRegistryPlugin(), batchOperationsPlugin()]
        : [];

      const builtInPlugins = {
        transaction: buildPlugins('txn', transactionExtraPlugins),
        paymentAttempt: buildPlugins('pat'),
        subscription: buildPlugins('sub'),
        settlement: buildPlugins('stl'),
      };

      // ── Repositories ─────────────────────────────────────────────────
      const repositories = createRevenueRepositories(
        models,
        builtInPlugins,
        runtime.repositoryPlugins,
        // The flag reaches the WRITE PATH, not only the boot gate below.
        runtime.allowNonTransactional === true,
      );

      // ── VERIFY: capability boot gate ─────────────────────────────────
      // Revenue moves money and its capture/refund paths are multi-document.
      // Refuse a deployment that cannot commit them atomically HERE, at boot,
      // rather than at the first real capture. `allowNonTransactional: true`
      // is the explicit, logged opt-IN. See ./ensure-ready.ts for why this
      // gate only became writable once mongokit started observing topology.
      assertRevenueCapabilities(repositories.transaction, {
        allowNonTransactional: runtime.allowNonTransactional === true,
        ...(runtime.logger ? { logger: runtime.logger } : {}),
      });

      // ── Default currency: the ONE conversion edge ────────────────────
      // `RevenueRuntime.defaultCurrency` is host-supplied config (a plain
      // string). It is validated and branded exactly here, at bind, and the
      // branded value is threaded into every repository and the resolved
      // config below — so nothing downstream re-parses it, and a bad code
      // fails the deployment instead of denominating a payment.
      const defaultCurrency = currencyCode(runtime.defaultCurrency);

      // ── Provider registries (gateway + bank-feed) ────────────────────
      const providers = createProviderRegistry(runtime.providers ?? {}, defaultCurrency);
      const bankFeedProviders = createBankFeedProviderRegistry(runtime.bankFeedProviders ?? {});

      // ── Commission: object form on `modules` wins; else runtime override ─
      const commission =
        typeof shape.modules?.commission === 'object' ? shape.modules.commission : runtime.commission;


      // ── Transport ownership (finding #7): only an engine-CREATED transport is closed. ─
      const ownsTransport = runtime.eventTransport === undefined;
      const events: EventTransport =
        runtime.eventTransport ?? new InProcessRevenueBus({ logger: runtime.logger });

      // ── Inject deps into repositories ────────────────────────────────
      const tenantScopeEnabled = scope.enabled && scope.strategy === 'field';
      repositories.transaction.inject({
        events,
        outbox: runtime.outbox,
        providers,
        bankFeedProviders,
        bridges: runtime.bridges ?? {},
        commission,
        ...(runtime.tax
          ? {
              tax:
                typeof runtime.tax === 'function'
                  ? /**
                     * A thunk cannot be validated at bind — its first RESOLUTION is the
                     * earliest the rate exists. So the guard wraps it: a percent-shaped
                     * rate throws on the transaction that would have been mis-taxed,
                     * with the same message the bind guard gives a static config. Never
                     * silently skipped — a guard that only covers one of two accepted
                     * shapes is decoration for the other.
                     */
                    async () => {
                      const resolved = await (runtime.tax as () => TaxConfig | Promise<TaxConfig>)();
                      if (resolved && resolved.defaultRate > 1) {
                        throw new Error(
                          `defineRevenue: tax.defaultRate must be a FRACTION, got ${resolved.defaultRate}. ` +
                            `Pass ${resolved.defaultRate / 100} for ${resolved.defaultRate}%.`,
                        );
                      }
                      return resolved;
                    }
                  : runtime.tax,
            }
          : {}),
        defaultCurrency,
        logger: runtime.logger,
        // Field-strategy tenant scoping — lets `import()` refuse an unscoped upsert when the host
        // enabled scoping but forgot `ctx.organizationId`.
        tenantScopeEnabled,
        // Phase 3: the per-attempt durable record written before provider I/O — the SINGLE
        // persistence path (scoped, CAS-capable). All attempt writes go through it.
        paymentAttempts: repositories.paymentAttempt,
      });

      repositories.paymentAttempt.inject({
        events,
        outbox: runtime.outbox,
        logger: runtime.logger,
      });

      if (repositories.subscription) {
        repositories.subscription.inject({
          events,
          outbox: runtime.outbox,
          logger: runtime.logger,
        });
      }

      if (repositories.settlement) {
        repositories.settlement.inject({
          events,
          outbox: runtime.outbox,
          bridges: runtime.bridges ?? {},
          logger: runtime.logger,
        });
      }

      const resolved: ResolvedRevenueConfig = {
        scope,
        modules,
        defaultCurrency,
        forceRecreate,
        ...(shape.collectionPrefix !== undefined ? { collectionPrefix: shape.collectionPrefix } : {}),
      };

      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        // Only close the transport we created. A supplied (shared) transport's lifecycle belongs
        // to the host — closing it would disable other domains on the same bus.
        if (ownsTransport) await events.close?.();
      };

      return Object.freeze({
        config: Object.freeze(resolved),
        models,
        repositories,
        providers,
        bankFeedProviders,
        events,
        async syncIndexes(): Promise<void> {
          await Promise.all(
            Object.values(models)
              .filter(Boolean)
              .map((m) => (m as { createIndexes: () => Promise<unknown> }).createIndexes()),
          );
        },
        close,
      });
    },
  };
}
