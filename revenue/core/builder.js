/**
 * Revenue Builder - Main Entry Point
 * @classytic/revenue
 *
 * Factory function to create revenue instance
 * Inspired by: AI SDK, LangChain, Prisma Client
 */

import { Container } from './container.js';
import { SubscriptionService } from '../services/subscription.service.js';
import { PaymentService } from '../services/payment.service.js';
import { TransactionService } from '../services/transaction.service.js';
import { EscrowService } from '../services/escrow.service.js';
import { ConfigurationError } from './errors.js';

/**
 * Create revenue instance with dependency injection
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.models - Mongoose models { Transaction, Subscription, etc. }
 * @param {Record<string, import('../providers/base.js').PaymentProvider>} options.providers - Payment providers - Register ANY custom gateway by name
 * @param {Object} options.hooks - Event hooks
 * @param {Object} options.config - Additional configuration
 * @param {Object} options.logger - Logger instance
 * @returns {Revenue} Revenue instance
 *
 * @example
 * ```javascript
 * import { createRevenue } from '@classytic/revenue';
 * import { ManualProvider } from '@classytic/revenue-manual';
 *
 * const revenue = createRevenue({
 *   models: {
 *     Transaction: TransactionModel,
 *     Subscription: SubscriptionModel,
 *   },
 *   providers: {
 *     manual: new ManualProvider(),
 *     bkash: new BkashProvider(),      // Custom gateway
 *     nagad: new NagadProvider(),      // Custom gateway
 *     stripe: new StripeProvider(),    // Custom gateway
 *     // ... register any gateway you want
 *   },
 *   config: {
 *     targetModels: ['Subscription', 'Membership'],
 *     categoryMappings: {
 *       Subscription: 'platform_subscription',
 *       Membership: 'gym_membership',
 *     },
 *   },
 * });
 *
 * // Use any registered gateway by name
 * const subscription = await revenue.subscriptions.create({
 *   gateway: 'bkash',  // Use your custom gateway
 *   // ...
 * });
 * await revenue.payments.verify(txnId);
 * ```
 */
export function createRevenue(options = {}) {
  // Validate required options
  if (!options.models || !options.models.Transaction) {
    throw new Error('createRevenue(): options.models.Transaction is required');
  }

  // Create DI container
  const container = new Container();

  // Register models
  container.singleton('models', options.models);

  // Register providers
  const providers = options.providers || {};

  // Validate provider interface in non-production
  if (process.env.NODE_ENV !== 'production') {
    for (const [name, provider] of Object.entries(providers)) {
      validateProvider(name, provider);
    }
  }

  container.singleton('providers', providers);

  // Register hooks
  container.singleton('hooks', options.hooks || {});

  // Register config
  const config = {
    targetModels: ['Subscription', 'Membership'],
    categoryMappings: {},
    ...options.config,
  };
  container.singleton('config', config);

  // Register logger
  container.singleton('logger', options.logger || console);

  // Create service instances (lazy-loaded)
  const services = {
    subscriptions: null,
    payments: null,
    transactions: null,
    escrow: null,
  };

  // Create revenue instance
  const revenue = {
    /**
     * Get container (for advanced usage)
     */
    container,

    /**
     * Registered payment providers
     */
    providers,

    /**
     * Configuration
     */
    config,

    /**
     * Subscription service
     * Lazy-loaded on first access
     */
    get subscriptions() {
      if (!services.subscriptions) {
        services.subscriptions = new SubscriptionService(container);
      }
      return services.subscriptions;
    },

    /**
     * Payment service
     * Lazy-loaded on first access
     */
    get payments() {
      if (!services.payments) {
        services.payments = new PaymentService(container);
      }
      return services.payments;
    },

    /**
     * Transaction service
     * Lazy-loaded on first access
     */
    get transactions() {
      if (!services.transactions) {
        services.transactions = new TransactionService(container);
      }
      return services.transactions;
    },

    /**
     * Escrow service
     * Lazy-loaded on first access
     */
    get escrow() {
      if (!services.escrow) {
        services.escrow = new EscrowService(container);
      }
      return services.escrow;
    },

    /**
     * Get a specific provider
     */
    getProvider(name) {
      const provider = providers[name];
      if (!provider) {
        throw new Error(`Provider "${name}" not found. Available: ${Object.keys(providers).join(', ')}`);
      }
      return provider;
    },
  };

  // Deeply freeze the revenue object (truly immutable)
  Object.freeze(revenue);
  Object.freeze(providers);
  Object.freeze(config);

  return revenue;
}

/**
 * Validate provider implements required interface
 * @private
 */
function validateProvider(name, provider) {
  const required = ['createIntent', 'verifyPayment', 'getStatus', 'getCapabilities'];
  const missing = required.filter(method => typeof provider[method] !== 'function');

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Provider "${name}" is missing required methods: ${missing.join(', ')}`,
      { provider: name, missing }
    );
  }
}

/**
 * Revenue instance type (for documentation)
 * @typedef {Object} Revenue
 * @property {Container} container - DI container (readonly)
 * @property {Object} providers - Payment providers (readonly, frozen)
 * @property {Object} config - Configuration (readonly, frozen)
 * @property {SubscriptionService} subscriptions - Subscription service
 * @property {PaymentService} payments - Payment service
 * @property {TransactionService} transactions - Transaction service
 * @property {EscrowService} escrow - Escrow service
 * @property {Function} getProvider - Get payment provider
 */

export default createRevenue;
