/**
 * Config Resolver
 * @classytic/revenue
 *
 * Resolves configuration from builder options to service-ready format
 * Inspired by Stripe's tiered config pattern: global defaults → specific overrides
 */

import type { RevenueOptions } from '../../core/revenue.js';
import type { RevenueConfig } from '../../shared/types/index.js';

/**
 * Resolve builder options to service config
 *
 * Converts singular commission rates to category/gateway maps
 * Uses '*' as global default key (applies to all categories/gateways)
 *
 * @param options - Builder options
 * @returns Service-ready config
 *
 * @example
 * ```typescript
 * const options = {
 *   commissionRate: 0.10,        // 10% global default
 *   gatewayFeeRate: 0.029,      // 2.9% global default
 * };
 *
 * const config = resolveConfig(options);
 * // {
 * //   commissionRates: { '*': 0.10 },
 * //   gatewayFeeRates: { '*': 0.029 }
 * // }
 *
 * // Services can then:
 * const rate = config.commissionRates?.['course_purchase']
 *   ?? config.commissionRates?.['*']  // Fallback to global default
 *   ?? 0;
 * ```
 */
export function resolveConfig(options: Partial<RevenueOptions>): Partial<RevenueConfig> {
  const config: Partial<RevenueConfig> = {
    targetModels: [],
    categoryMappings: {},
  };

  // Convert singular commission rate to global default map
  if (options.commissionRate !== undefined) {
    config.commissionRates = {
      '*': options.commissionRate, // Global default for all categories
    };
  }

  // Convert singular gateway fee rate to global default map
  if (options.gatewayFeeRate !== undefined) {
    config.gatewayFeeRates = {
      '*': options.gatewayFeeRate, // Global default for all gateways
    };
  }

  return config;
}

/**
 * Get commission rate for a category
 *
 * Follows precedence: specific category → global default → 0
 *
 * @param config - Revenue config
 * @param category - Transaction category
 * @returns Commission rate (0-1)
 *
 * @example
 * ```typescript
 * const rate = getCommissionRate(config, 'course_purchase');
 * // Checks:
 * // 1. config.commissionRates?.['course_purchase']
 * // 2. config.commissionRates?.['*']
 * // 3. 0 (fallback)
 * ```
 */
export function getCommissionRate(
  config: Partial<RevenueConfig> | undefined,
  category: string
): number {
  if (!config?.commissionRates) return 0;

  // Try specific category first
  if (category in config.commissionRates) {
    return config.commissionRates[category];
  }

  // Fallback to global default
  return config.commissionRates['*'] ?? 0;
}

/**
 * Get gateway fee rate for a gateway
 *
 * Follows precedence: specific gateway → global default → 0
 *
 * @param config - Revenue config
 * @param gateway - Gateway name (e.g., 'stripe', 'paypal')
 * @returns Gateway fee rate (0-1)
 */
export function getGatewayFeeRate(
  config: Partial<RevenueConfig> | undefined,
  gateway: string
): number {
  if (!config?.gatewayFeeRates) return 0;

  // Try specific gateway first
  if (gateway in config.gatewayFeeRates) {
    return config.gatewayFeeRates[gateway];
  }

  // Fallback to global default
  return config.gatewayFeeRates['*'] ?? 0;
}

/**
 * Merge config with overrides
 *
 * Allows per-category/per-gateway overrides while preserving global defaults
 *
 * @param baseConfig - Base config (from builder)
 * @param overrides - Override maps
 * @returns Merged config
 *
 * @example
 * ```typescript
 * const config = resolveConfig({ commissionRate: 0.10 });
 * const merged = mergeConfig(config, {
 *   commissionRates: {
 *     'premium_course': 0.05,  // Lower rate for premium courses
 *   },
 *   gatewayFeeRates: {
 *     'crypto': 0.01,  // Lower fee for crypto gateway
 *   },
 * });
 * // Result:
 * // commissionRates: { '*': 0.10, 'premium_course': 0.05 }
 * // gatewayFeeRates: { '*': 0.029, 'crypto': 0.01 }
 * ```
 */
export function mergeConfig(
  baseConfig: Partial<RevenueConfig>,
  overrides: Partial<RevenueConfig>
): Partial<RevenueConfig> {
  return {
    ...baseConfig,
    commissionRates: {
      ...baseConfig.commissionRates,
      ...overrides.commissionRates,
    },
    gatewayFeeRates: {
      ...baseConfig.gatewayFeeRates,
      ...overrides.gatewayFeeRates,
    },
    categoryMappings: {
      ...baseConfig.categoryMappings,
      ...overrides.categoryMappings,
    },
    targetModels: overrides.targetModels ?? baseConfig.targetModels,
    transactionTypeMapping: {
      ...baseConfig.transactionTypeMapping,
      ...overrides.transactionTypeMapping,
    },
  };
}
