/**
 * Tax Plugin
 * @classytic/revenue
 *
 * Automatic tax calculation for transactions
 * Integrates with monetization.create.before hook
 */

import { definePlugin, type MonetizationCreateInput } from '../../../core/plugin.js';
import { calculateTax, getTaxType } from '../../../shared/utils/calculators/tax.js';
import { resolveCategory } from '../../../shared/utils/validators/category-resolver.js';
import type { TaxConfig } from '../../../shared/types/tax.js';

/**
 * Tax Plugin Options
 */
export interface TaxPluginOptions {
  /**
   * Function to get tax configuration for an organization
   * Apps implement this to return jurisdiction-specific config
   *
   * @param orgId - Organization ID
   * @returns Tax configuration or null if not registered
   *
   * @example
   * ```typescript
   * getTaxConfig: async (orgId) => {
   *   const org = await Organization.findById(orgId);
   *   if (!org) return null;
   *
   *   return {
   *     isRegistered: org.country === 'AU',
   *     defaultRate: org.country === 'AU' ? 0.10 : 0, // 10% GST in Australia
   *     pricesIncludeTax: org.pricesIncludeTax || false,
   *     exemptCategories: ['education', 'medical'],
   *   };
   * }
   * ```
   */
  getTaxConfig: (orgId: string) => Promise<TaxConfig | null>;

  /**
   * Category mappings for resolving transaction categories
   * Maps entity names to category strings
   *
   * @example
   * ```typescript
   * {
   *   Order: 'order_subscription',
   *   PlatformSubscription: 'platform_subscription',
   *   Membership: 'gym_membership',
   * }
   * ```
   */
  categoryMappings?: Record<string, string>;

  /**
   * Categories that represent income (vs expense)
   * Used to determine tax type: 'collected' vs 'paid'
   *
   * Default: ['subscription', 'purchase', 'course_enrollment']
   */
  incomeCategories?: string[];
}

/**
 * Create Tax Plugin
 *
 * Automatically calculates and applies tax to transactions during monetization.create()
 *
 * @param options - Plugin options
 * @returns Tax plugin
 *
 * @example
 * ```typescript
 * import { Revenue } from '@classytic/revenue';
 * import { createTaxPlugin } from '@classytic/revenue/plugins';
 *
 * const revenue = Revenue
 *   .create({ defaultCurrency: 'USD' })
 *   .withModels({ Transaction, Subscription })
 *   .withProvider('stripe', stripeProvider)
 *   .withPlugin(createTaxPlugin({
 *     getTaxConfig: async (orgId) => {
 *       const org = await Organization.findById(orgId);
 *       return {
 *         isRegistered: true,
 *         defaultRate: 0.15, // 15% tax
 *         pricesIncludeTax: false,
 *         exemptCategories: ['education'],
 *       };
 *     },
 *     categoryMappings: {
 *       Order: 'order_subscription',
 *       Membership: 'gym_membership',
 *     },
 *   }))
 *   .build();
 *
 * // Tax is now automatically calculated
 * await revenue.monetization.create({
 *   data: { organizationId: 'org_123', customerId: 'cust_456' },
 *   planKey: 'monthly',
 *   amount: 10000, // $100
 *   entity: 'Order',
 *   monetizationType: 'subscription',
 * });
 * // → Creates transaction with tax: {
 * //   isApplicable: true,
 * //   rate: 0.15,
 * //   baseAmount: 10000,
 * //   taxAmount: 1500,
 * //   totalAmount: 11500,
 * //   type: 'collected'
 * // }
 * ```
 */
export function createTaxPlugin(options: TaxPluginOptions) {
  const {
    getTaxConfig,
    categoryMappings = {},
    incomeCategories = ['subscription', 'purchase', 'course_enrollment', 'product_order'],
  } = options;

  return definePlugin({
    name: 'tax',
    version: '1.0.0',
    description: 'Automatic tax calculation for transactions',

    hooks: {
      /**
       * Calculate tax before monetization creation
       * Injects tax data into the input so it's saved with the transaction
       */
      'monetization.create.before': async (ctx, input: MonetizationCreateInput, next) => {
        // Clean, type-safe access - no more (input as any)!
        const orgId = input.data.organizationId;

        if (!orgId) {
          ctx.logger.debug('Tax plugin: No organizationId in input.data, skipping tax calculation');
          return next();
        }

        try {
          // Get tax config from app
          const config = await getTaxConfig(orgId);

          if (!config) {
            ctx.logger.debug('Tax plugin: No tax config for org', { orgId });
            return next();
          }

          // Resolve category - clean type-safe access
          const category = resolveCategory(
            input.entity,
            input.monetizationType || 'subscription',
            categoryMappings
          );

          // Determine transaction flow (inflow vs outflow)
          const transactionFlow = incomeCategories.includes(category) ? 'inflow' : 'outflow';

          // Calculate tax
          const taxCalc = calculateTax(input.amount, category, config);

          // Get tax type
          const taxType = getTaxType(transactionFlow, category, config.exemptCategories);

          // Inject tax into input - type-safe
          input.tax = {
            ...taxCalc,
            type: taxType,
          };

          ctx.logger.debug('Tax plugin: Tax calculated', {
            orgId,
            category,
            entity: input.entity,
            monetizationType: input.monetizationType,
            taxAmount: taxCalc.taxAmount,
            type: taxType,
          });
        } catch (error) {
          // Don't fail the transaction if tax calculation fails
          ctx.logger.error('Tax plugin: Failed to calculate tax', {
            orgId,
            error: (error as Error).message,
          });
        }

        return next();
      },
    },
  });
}

export default createTaxPlugin;
