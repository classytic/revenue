import type { PluginType } from '@classytic/mongokit';
import type { RevenueModels } from '../models/create-models.js';
import { TransactionRepository } from './transaction/transaction.repository.js';
import { PaymentAttemptRepository } from './payment-attempt.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SettlementRepository } from './settlement.repository.js';

export interface RevenueRepositories {
  transaction: TransactionRepository;
  /** Scoped, CAS-capable data layer for payment attempts (phase 3 reconciliation). */
  paymentAttempt: PaymentAttemptRepository;
  subscription?: SubscriptionRepository;
  settlement?: SettlementRepository;
}

export interface RepositoryPluginBundle {
  transaction?: PluginType[];
  paymentAttempt?: PluginType[];
  subscription?: PluginType[];
  settlement?: PluginType[];
}

export function createRevenueRepositories(
  models: RevenueModels,
  builtInPlugins: {
    transaction: PluginType[];
    paymentAttempt: PluginType[];
    subscription: PluginType[];
    settlement: PluginType[];
  },
  hostPlugins: RepositoryPluginBundle = {},
  /**
   * Host acceptance of a standalone `mongod`. Reaches the transaction repository, which is
   * where the money units of work are opened — the boot gate alone was not enough (see
   * `TransactionRepositoryBase.allowNonTransactional`).
   */
  allowNonTransactional = false,
): RevenueRepositories {
  const repos: RevenueRepositories = {
    transaction: new TransactionRepository(models.Transaction, [
      ...builtInPlugins.transaction,
      ...(hostPlugins.transaction ?? []),
    ]),
    paymentAttempt: new PaymentAttemptRepository(models.PaymentAttempt, [
      ...builtInPlugins.paymentAttempt,
      ...(hostPlugins.paymentAttempt ?? []),
    ]),
  };

  if (models.Subscription) {
    repos.subscription = new SubscriptionRepository(models.Subscription, [
      ...builtInPlugins.subscription,
      ...(hostPlugins.subscription ?? []),
    ]);
  }

  if (models.Settlement) {
    repos.settlement = new SettlementRepository(models.Settlement, [
      ...builtInPlugins.settlement,
      ...(hostPlugins.settlement ?? []),
    ]);
  }

  /**
   * Assigned after construction rather than via the constructor: `TransactionRepository`
   * takes `(model, plugins)` and every subclass in the chain forwards exactly that, so
   * widening the signature would touch four classes to carry one deployment fact.
   */
  (repos.transaction as unknown as { allowNonTransactional: boolean }).allowNonTransactional =
    allowNonTransactional;

  return repos;
}
