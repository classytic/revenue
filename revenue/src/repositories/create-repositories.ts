import type { PluginType } from '@classytic/mongokit';
import type { RevenueModels } from '../models/create-models.js';
import { TransactionRepository } from './transaction.repository.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SettlementRepository } from './settlement.repository.js';

export interface RevenueRepositories {
  transaction: TransactionRepository;
  subscription?: SubscriptionRepository;
  settlement?: SettlementRepository;
}

export interface RepositoryPluginBundle {
  transaction?: PluginType[];
  subscription?: PluginType[];
  settlement?: PluginType[];
}

export function createRevenueRepositories(
  models: RevenueModels,
  builtInPlugins: {
    transaction: PluginType[];
    subscription: PluginType[];
    settlement: PluginType[];
  },
  hostPlugins: RepositoryPluginBundle = {},
): RevenueRepositories {
  const repos: RevenueRepositories = {
    transaction: new TransactionRepository(models.Transaction, [
      ...builtInPlugins.transaction,
      ...(hostPlugins.transaction ?? []),
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

  return repos;
}
