import {
  multiTenantPlugin,
  softDeletePlugin,
  customIdPlugin,
  prefixedId,
  methodRegistryPlugin,
  batchOperationsPlugin,
  type PluginType,
} from '@classytic/mongokit';
import { resolveTenantConfig } from '@classytic/repo-core/tenant';
import type { RevenueConfig, RevenueEngine } from './engine-types.js';
import { createRevenueModels } from '../models/create-models.js';
import { createRevenueRepositories } from '../repositories/create-repositories.js';
import { createProviderRegistry } from '../providers/registry.js';
import { createBankFeedProviderRegistry } from '../providers/bank-feed.js';
import { InProcessRevenueBus } from '../events/in-process-bus.js';
import type { EventTransport } from '@classytic/primitives/events';

/**
 * createRevenue — factory for the revenue engine.
 *
 * Accepts an optional arc-compatible `EventTransport`. When the host
 * doesn't pass one, we instantiate `InProcessRevenueBus` — a ~50-line
 * structural match of arc's `MemoryEventTransport` that ships with the
 * package so `createRevenue` always returns a working engine even without
 * arc installed. Hosts that already use arc can pass
 * `new RedisEventTransport(...)` (or any arc transport) straight in.
 *
 * Domain verbs publish via `this.deps.events.publish(createEvent(...))` and
 * hosts subscribe via `revenue.events.subscribe('revenue:payment.*', ...)`.
 * See PACKAGE_RULES §13–§14.
 */
export async function createRevenue(config: RevenueConfig): Promise<RevenueEngine> {
  // Phase 1: Resolve config defaults
  const bankFeedRaw = config.modules?.bankFeed;
  const bankFeedEnabled =
    bankFeedRaw === false
      ? false
      : typeof bankFeedRaw === 'object' && bankFeedRaw !== null
      ? bankFeedRaw.enabled !== false
      : true; // `true` | `undefined` → on

  // Per-index defaults — required indexes on, dashboard indexes on,
  // heavy reconciliation indexes off (host enables explicitly).
  const userIndexCfg =
    typeof bankFeedRaw === 'object' && bankFeedRaw !== null ? bankFeedRaw.indexes : undefined;
  const bankFeedIndexes = bankFeedEnabled
    ? {
        idempotentImport: userIndexCfg?.idempotentImport ?? true,
        byAccount: userIndexCfg?.byAccount ?? true,
        matchCandidates: userIndexCfg?.matchCandidates ?? false,
      }
    : { idempotentImport: false, byAccount: false, matchCandidates: false };

  const modules = {
    subscription: config.modules?.subscription !== false,
    escrow: config.modules?.escrow ?? false,
    settlement: config.modules?.settlement ?? false,
    bankFeed: bankFeedEnabled,
  };
  const scope = resolveTenantConfig(config.scope);

  // Phase 2: Resolve event transport — host-provided or local fallback
  const events: EventTransport =
    config.eventTransport ?? new InProcessRevenueBus({ logger: config.logger });

  // Phase 3: Create models
  const models = createRevenueModels({
    connection: config.connection,
    scope,
    schemaOptions: config.schemaOptions,
    modules,
    bankFeedIndexes,
    ...(config.collectionPrefix !== undefined
      ? { collectionPrefix: config.collectionPrefix }
      : {}),
    ...(config.forceRecreate !== undefined
      ? { forceRecreate: config.forceRecreate }
      : {}),
  });

  // Phase 4: Build plugin stacks for repositories
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
          // Platform-admin bypass — honors `ctx._bypassTenant === true` so
          // superadmin reads can span organizations through the repo API
          // (keeping events, validation, and pagination intact) instead of
          // dropping to `engine.models.*` and losing the pipeline.
          //
          // Authorization is the CALLER's responsibility: this flag must
          // be gated behind a platform-role check at the route/service
          // layer and MUST NOT be forwarded from untrusted input. See
          // `RevenueContext._bypassTenant` for full semantics.
          skipWhen: (ctx) => (ctx as { _bypassTenant?: boolean })._bypassTenant === true,
        }),
      );
    }
    plugins.push(softDeletePlugin({ ttlDays: 365 }));
    plugins.push(...extraPlugins);
    return plugins;
  };

  // Transaction repo gets the batch-operations plugin so `bulkWrite` is
  // available — the bank-feed `import()` verb depends on it. Wired
  // unconditionally (also benefits payment-flow batching, e.g. mass
  // refund jobs). `methodRegistryPlugin` is the prerequisite for
  // `batchOperationsPlugin.registerMethod`.
  const transactionExtraPlugins: PluginType[] = modules.bankFeed
    ? [methodRegistryPlugin(), batchOperationsPlugin()]
    : [];

  const builtInPlugins = {
    transaction: buildPlugins('txn', transactionExtraPlugins),
    subscription: buildPlugins('sub'),
    settlement: buildPlugins('stl'),
  };

  // Phase 5: Create repositories
  const repositories = createRevenueRepositories(models, builtInPlugins, config.repositoryPlugins);

  // Phase 6: Create provider registries (gateway + bank-feed)
  const providers = createProviderRegistry(config.providers ?? {}, config.defaultCurrency);
  const bankFeedProviders = createBankFeedProviderRegistry(config.bankFeedProviders ?? {});

  // Phase 7: Resolve commission config
  const commission =
    typeof config.modules?.commission === 'object' ? config.modules.commission : config.commission;

  // Phase 8: Inject deps (events + bridges + providers + host-owned outbox) into repositories
  repositories.transaction.inject({
    events,
    outbox: config.outbox,
    providers,
    bankFeedProviders,
    bridges: config.bridges ?? {},
    commission,
    defaultCurrency: config.defaultCurrency,
    logger: config.logger,
  });

  if (repositories.subscription) {
    repositories.subscription.inject({
      events,
      outbox: config.outbox,
      logger: config.logger,
    });
  }

  if (repositories.settlement) {
    repositories.settlement.inject({
      events,
      outbox: config.outbox,
      bridges: config.bridges ?? {},
      logger: config.logger,
    });
  }

  // Phase 9: autoIndex control — Mongoose 9 defers Model.init() until
  // first query, so setting schema.autoIndex after compilation is safe.
  if (config.autoIndex !== undefined) {
    for (const [name, model] of Object.entries(models) as [string, import('mongoose').Model<unknown> | undefined][]) {
      if (!model) continue;
      const value = typeof config.autoIndex === 'boolean'
        ? config.autoIndex
        : (config.autoIndex as Record<string, boolean>)[name] ?? undefined;
      if (value !== undefined) {
        model.schema.set('autoIndex', value);
      }
    }
  }

  // Phase 10: Build engine — repositories ARE the API surface
  const engine: RevenueEngine = {
    config: Object.freeze({ ...config }),
    models,
    repositories,
    providers,
    bankFeedProviders,
    events,
    async syncIndexes() {
      await Promise.all(
        Object.values(models)
          .filter(Boolean)
          .map(m => (m as { createIndexes: () => Promise<unknown> }).createIndexes()),
      );
    },
    async destroy() {
      await events.close?.();
    },
  };

  return engine;
}
