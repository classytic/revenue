/**
 * Revenue model specification — the ONE authoritative place the revenue models are described.
 *
 * `defineRevenueModels(config)` returns a connection-free mongokit `ModelBlueprint`; `defineRevenue`
 * binds it during engine construction. Collision handling, auto-index, collection prefixing and the
 * index declarations all live here once. A name collision surfaces as mongokit's typed
 * `ModelCollisionError` — there is no revenue-specific collision wrapper.
 *
 * The schema factories are PURE and lazy: each is built at most once, only when its model is
 * actually registered (`.bind(connection)`). Optional models (Subscription / Settlement) are
 * conditionally included in the spec array based on the resolved module set.
 */
import { defineModels, type ModelBlueprint, type ModelSpec } from '@classytic/mongokit';
import type { Model, Schema } from 'mongoose';
import {
  buildTransactionSchema,
  type TransactionDocument,
  type RevenueSchemaConfig,
  type ResolvedBankFeedIndexes,
} from './transaction.schema.js';
import { buildSubscriptionSchema, type SubscriptionDocument } from './subscription.schema.js';
import { buildSettlementSchema, type SettlementDocument } from './settlement.schema.js';
import { buildPaymentAttemptSchema, type PaymentAttemptDocument } from './payment-attempt.schema.js';
import type { ResolvedTenantConfig } from '@classytic/repo-core/tenant';
import { injectTenantField } from './inject-tenant.js';

export interface RevenueModels {
  Transaction: Model<TransactionDocument>;
  /**
   * Per-provider-attempt log for payment-flow transactions (phase 3). Core —
   * always registered alongside Transaction: it is written BEFORE the provider
   * call so an orphaned/unknown intent is always visible. See payment-attempt.schema.ts.
   */
  PaymentAttempt: Model<PaymentAttemptDocument>;
  Subscription?: Model<SubscriptionDocument>;
  Settlement?: Model<SettlementDocument>;
}

export interface RevenueSchemaOptions {
  transaction?: { extraFields?: Record<string, unknown>; extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }> };
  subscription?: { extraFields?: Record<string, unknown>; extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }> };
  settlement?: { extraFields?: Record<string, unknown>; extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }> };
}

export const REVENUE_MODEL_NAMES = ['Transaction', 'PaymentAttempt', 'Subscription', 'Settlement'] as const;

/** Auto-index policy: a single flag, or a per-model override map. */
export type RevenueAutoIndex = boolean | Partial<Record<'Transaction' | 'Subscription' | 'Settlement', boolean>>;

/**
 * Default physical collection names (see PACKAGE_RULES.md §20.1). Prefixed
 * when `collectionPrefix` is provided; used verbatim when unset.
 */
const DEFAULT_COLLECTIONS = {
  Transaction: 'revenue_transactions',
  PaymentAttempt: 'revenue_payment_attempts',
  Subscription: 'revenue_subscriptions',
  Settlement: 'revenue_settlements',
} as const;

export interface DefineRevenueModelsConfig {
  /** Resolved tenant scope — drives field injection + index prefixing. */
  scope: ResolvedTenantConfig;
  schemaOptions?: RevenueSchemaOptions;
  /**
   * Resolved bank-feed index flags. Forwarded into `RevenueSchemaConfig`
   * so opt-in indexes (treasurer dashboard, match-candidates compound)
   * are only built when the host enables them. Engine factory resolves
   * `modules.bankFeed.indexes` into this shape.
   */
  bankFeedIndexes?: ResolvedBankFeedIndexes;
  /** Which optional models to register. `subscription` defaults on; `settlement` defaults off. */
  modules?: {
    subscription?: boolean;
    settlement?: boolean;
  };
  /**
   * Optional prefix prepended to every physical collection this package
   * creates (see PACKAGE_RULES.md §20.1). Unset → default names.
   * Model names and `ref:` populate are unaffected.
   */
  collectionPrefix?: string | undefined;
  /**
   * Mongoose auto-index builds. `true` (dev default) / `false` (prod, §35) or a per-model map.
   * Left to Mongoose's own default when `undefined`.
   */
  autoIndex?: RevenueAutoIndex | undefined;
  /**
   * On a model-name collision: default throws (mongokit `ModelCollisionError`);
   * `true` re-registers via mongokit's `replace` policy (test/dev fixtures only —
   * refused under `NODE_ENV=production`). See PACKAGE_RULES.md §21.
   */
  forceRecreate?: boolean | undefined;
}

/** Resolve the auto-index value for a named model from the (possibly per-model) config. */
function resolveAutoIndex(name: string, autoIndex: RevenueAutoIndex | undefined): boolean | undefined {
  if (autoIndex === undefined) return undefined;
  if (typeof autoIndex === 'boolean') return autoIndex;
  return (autoIndex as Record<string, boolean>)[name];
}

/** Apply the resolved auto-index policy to a freshly built schema (no-op when unset). */
function applyAutoIndex(schema: Schema, name: string, autoIndex: RevenueAutoIndex | undefined): void {
  const value = resolveAutoIndex(name, autoIndex);
  if (value !== undefined) schema.set('autoIndex', value);
}

/**
 * Describe the revenue model set as a connection-free blueprint. Pure — builds no schema and
 * registers nothing until `.bind(connection)`. Optional models are included in the spec array
 * only when their module is enabled, so a disabled module declares no model and no indexes.
 */
export function defineRevenueModels(config: DefineRevenueModelsConfig): ModelBlueprint<RevenueModels> {
  const { scope, schemaOptions = {}, modules = {}, collectionPrefix, forceRecreate, bankFeedIndexes, autoIndex } = config;
  const prefix = collectionPrefix ?? '';
  const existing: ModelSpec['existing'] = forceRecreate
    ? { mode: 'replace', environment: 'test' }
    : { mode: 'throw' };

  // Heterogeneous per-spec document types — erased to `ModelSpec<any>` at this boundary exactly as
  // mongokit's `defineModels` signature does; per-model types are restored by `assemble`.
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-spec doc types; assemble() re-types.
  const specs: ModelSpec<any>[] = [];

  // ── Transaction (always) ─────────────────────────────────────────────
  specs.push({
    name: 'Transaction',
    collection: prefix + DEFAULT_COLLECTIONS.Transaction,
    existing,
    schema: () => {
      const txnConfig: RevenueSchemaConfig = {
        scoped: scope.enabled,
        extraFields: schemaOptions.transaction?.extraFields,
        extraIndexes: schemaOptions.transaction?.extraIndexes,
        ...(bankFeedIndexes ? { bankFeedIndexes } : {}),
      };
      const txnSchema = buildTransactionSchema(txnConfig);
      injectTenantField(txnSchema, scope);

      // Global indexes — applied AFTER injection so they stay unscoped.
      // Webhooks and external systems look up by these without knowing the tenant.
      txnSchema.index({ 'gateway.sessionId': 1 }, { sparse: true });
      txnSchema.index({ 'gateway.paymentIntentId': 1 }, { sparse: true });
      txnSchema.index(
        { idempotencyKey: 1 },
        { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
      );
      txnSchema.index(
        { publicId: 1 },
        // No `deletedAt: null` clause (2026-08-14, soft delete removed) — an unmaintained
        // clause there is an escape hatch from uniqueness that re-mints public ids.
        { unique: true, partialFilterExpression: { publicId: { $type: 'string' } } },
      );

      // 3.0: idempotent bank-feed re-import — gated by `bankFeedIndexes.idempotentImport`.
      // Declared AFTER injection, so for scoped configs we explicitly prepend the tenant
      // field to keep behavior identical to injectTenantField's compound pass-through.
      if (bankFeedIndexes?.idempotentImport) {
        if (scope.enabled && scope.strategy === 'field') {
          txnSchema.index(
            {
              [scope.tenantField]: 1,
              bankAccountId: 1,
              externalId: 1,
            } as Record<string, 1>,
            {
              unique: true,
              partialFilterExpression: { externalId: { $type: 'string' } },
              name: 'bank_feed_idempotent_import',
            },
          );
        } else {
          txnSchema.index(
            { bankAccountId: 1, externalId: 1 },
            {
              unique: true,
              partialFilterExpression: { externalId: { $type: 'string' } },
              name: 'bank_feed_idempotent_import',
            },
          );
        }
      }

      applyAutoIndex(txnSchema, 'Transaction', autoIndex);
      return txnSchema;
    },
  });

  // ── PaymentAttempt (always, phase 3) ─────────────────────────────────
  specs.push({
    name: 'PaymentAttempt',
    collection: prefix + DEFAULT_COLLECTIONS.PaymentAttempt,
    existing,
    schema: () => {
      const attemptSchema = buildPaymentAttemptSchema({ scoped: scope.enabled });
      injectTenantField(attemptSchema, scope);
      // Auto-index for PaymentAttempt follows the Transaction flag (no dedicated override key).
      applyAutoIndex(attemptSchema, 'Transaction', autoIndex);
      return attemptSchema;
    },
  });

  // ── Subscription (optional — default on) ─────────────────────────────
  if (modules.subscription !== false) {
    specs.push({
      name: 'Subscription',
      collection: prefix + DEFAULT_COLLECTIONS.Subscription,
      existing,
      schema: () => {
        const subSchema = buildSubscriptionSchema({
          scoped: scope.enabled,
          extraFields: schemaOptions.subscription?.extraFields,
          extraIndexes: schemaOptions.subscription?.extraIndexes,
        });
        injectTenantField(subSchema, scope);
        applyAutoIndex(subSchema, 'Subscription', autoIndex);
        return subSchema;
      },
    });
  }

  // ── Settlement (optional — default off) ──────────────────────────────
  if (modules.settlement) {
    specs.push({
      name: 'Settlement',
      collection: prefix + DEFAULT_COLLECTIONS.Settlement,
      existing,
      schema: () => {
        const stlSchema = buildSettlementSchema({
          scoped: scope.enabled,
          extraFields: schemaOptions.settlement?.extraFields,
          extraIndexes: schemaOptions.settlement?.extraIndexes,
        });
        injectTenantField(stlSchema, scope);
        applyAutoIndex(stlSchema, 'Settlement', autoIndex);
        return stlSchema;
      },
    });
  }

  return defineModels<RevenueModels>({
    models: specs,
    assemble: (m) => {
      const models: RevenueModels = {
        Transaction: m.get('Transaction') as Model<TransactionDocument>,
        PaymentAttempt: m.get('PaymentAttempt') as Model<PaymentAttemptDocument>,
      };
      if (m.has('Subscription')) models.Subscription = m.get('Subscription') as Model<SubscriptionDocument>;
      if (m.has('Settlement')) models.Settlement = m.get('Settlement') as Model<SettlementDocument>;
      return Object.freeze(models);
    },
  });
}
