import type { Connection, Model } from 'mongoose';
import { buildTransactionSchema, type TransactionDocument, type RevenueSchemaConfig } from './transaction.schema.js';
import { buildSubscriptionSchema, type SubscriptionDocument } from './subscription.schema.js';
import { buildSettlementSchema, type SettlementDocument } from './settlement.schema.js';
import type { ResolvedTenantConfig } from '@classytic/primitives/tenant';
import { injectTenantField } from './inject-tenant.js';

export interface RevenueModels {
  Transaction: Model<TransactionDocument>;
  Subscription?: Model<SubscriptionDocument>;
  Settlement?: Model<SettlementDocument>;
}

export interface RevenueSchemaOptions {
  transaction?: { extraFields?: Record<string, unknown>; extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }> };
  subscription?: { extraFields?: Record<string, unknown>; extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }> };
  settlement?: { extraFields?: Record<string, unknown>; extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }> };
}

export const REVENUE_MODEL_NAMES = ['Transaction', 'Subscription', 'Settlement'] as const;

/**
 * Default physical collection names (see PACKAGE_RULES.md §20.1). Prefixed
 * when `collectionPrefix` is provided; used verbatim when unset.
 */
const DEFAULT_COLLECTIONS = {
  Transaction: 'revenue_transactions',
  Subscription: 'revenue_subscriptions',
  Settlement: 'revenue_settlements',
} as const;

export interface CreateModelsOptions {
  connection: Connection;
  scope: ResolvedTenantConfig;
  schemaOptions?: RevenueSchemaOptions;
  modules?: {
    subscription?: boolean;
    settlement?: boolean;
  };
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
   * See PACKAGE_RULES.md §21.
   */
  forceRecreate?: boolean;
}

export class RevenueModelCollisionError extends Error {
  constructor(name: string) {
    super(
      `[revenue] Mongoose model "${name}" already exists on this connection. ` +
        `For hot-reload / test fixtures, pass \`forceRecreate: true\` to clobber ` +
        `the existing model. For two revenue engines, use two Mongoose connections ` +
        `(\`mongoose.createConnection(...)\`) — each has its own model registry.`,
    );
    this.name = 'RevenueModelCollisionError';
  }
}

export function createRevenueModels(options: CreateModelsOptions): RevenueModels {
  const { connection, scope, schemaOptions = {}, modules = {}, collectionPrefix, forceRecreate } = options;
  const prefix = collectionPrefix ?? '';

  // Collision gate — throw by default, `forceRecreate: true` for
  // hot-reload / test fixtures. See PACKAGE_RULES.md §21.
  if (forceRecreate) {
    for (const name of REVENUE_MODEL_NAMES) {
      if (connection.models[name]) connection.deleteModel(name);
    }
  } else {
    for (const name of REVENUE_MODEL_NAMES) {
      if (connection.models[name]) throw new RevenueModelCollisionError(name);
    }
  }

  const txnConfig: RevenueSchemaConfig = {
    scoped: scope.enabled,
    extraFields: schemaOptions.transaction?.extraFields,
    extraIndexes: schemaOptions.transaction?.extraIndexes,
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
    { unique: true, partialFilterExpression: { deletedAt: null, publicId: { $type: 'string' } } },
  );

  const models: RevenueModels = {
    Transaction: connection.model<TransactionDocument>('Transaction', txnSchema, prefix + DEFAULT_COLLECTIONS.Transaction),
  };

  if (modules.subscription !== false) {
    const subConfig: RevenueSchemaConfig = {
      scoped: scope.enabled,
      extraFields: schemaOptions.subscription?.extraFields,
      extraIndexes: schemaOptions.subscription?.extraIndexes,
    };
    const subSchema = buildSubscriptionSchema(subConfig);
    injectTenantField(subSchema, scope);
    models.Subscription = connection.model<SubscriptionDocument>('Subscription', subSchema, prefix + DEFAULT_COLLECTIONS.Subscription);
  }

  if (modules.settlement) {
    const stlConfig: RevenueSchemaConfig = {
      scoped: scope.enabled,
      extraFields: schemaOptions.settlement?.extraFields,
      extraIndexes: schemaOptions.settlement?.extraIndexes,
    };
    const stlSchema = buildSettlementSchema(stlConfig);
    injectTenantField(stlSchema, scope);
    models.Settlement = connection.model<SettlementDocument>('Settlement', stlSchema, prefix + DEFAULT_COLLECTIONS.Settlement);
  }

  return models;
}
