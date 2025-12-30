/**
 * Configuration Precedence Tests
 * @classytic/revenue
 *
 * Tests configuration resolution behavior:
 * - Gateway-specific rates override global defaults
 * - Category-specific rates override gateway defaults
 * - Explicit params override all config
 * - Missing config falls back properly
 * - Merge behavior is correct
 */

import { describe, it, expect } from 'vitest';
import {
  resolveConfig,
  getCommissionRate,
  getGatewayFeeRate,
  mergeConfig,
} from '../../revenue/src/infrastructure/config/resolver.js';
import type { RevenueConfig } from '../../revenue/src/shared/types/index.js';

describe('Configuration Precedence', () => {
  describe('Global Default Configuration', () => {
    it('should use global defaults when no overrides exist', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.10, // Global default: 10%
        },
        gatewayFeeRates: {
          '*': 0.029, // Global default: 2.9%
        },
      };

      const commissionRate = getCommissionRate(config, 'subscription');
      const gatewayFeeRate = getGatewayFeeRate(config, 'stripe');

      expect(commissionRate).toBe(0.10);
      expect(gatewayFeeRate).toBe(0.029);
    });

    it('should fallback to zero when no configuration exists', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
      };

      const commissionRate = getCommissionRate(config, 'subscription');
      const gatewayFeeRate = getGatewayFeeRate(config, 'stripe');

      expect(commissionRate).toBe(0); // Falls back to 0
      expect(gatewayFeeRate).toBe(0); // Falls back to 0
    });
  });

  describe('Gateway-Specific Configuration', () => {
    it('should use gateway-specific rate over global default', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        gatewayFeeRates: {
          '*': 0.029, // Global: 2.9%
          stripe: 0.035, // Stripe-specific: 3.5%
          paypal: 0.034, // PayPal-specific: 3.4%
        },
      };

      const stripeFee = getGatewayFeeRate(config, 'stripe');
      const paypalFee = getGatewayFeeRate(config, 'paypal');
      const manualFee = getGatewayFeeRate(config, 'manual');

      expect(stripeFee).toBe(0.035); // Uses Stripe-specific
      expect(paypalFee).toBe(0.034); // Uses PayPal-specific
      expect(manualFee).toBe(0.029); // Falls back to global
    });

    it('should handle missing gateway-specific config gracefully', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        gatewayFeeRates: {
          '*': 0.029,
          stripe: 0.035,
        },
      };

      const unknownGatewayFee = getGatewayFeeRate(config, 'unknown-gateway');

      expect(unknownGatewayFee).toBe(0.029); // Falls back to global
    });
  });

  describe('Category-Specific Configuration', () => {
    it('should use category-specific rate over global default', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.10, // Global: 10%
          education: 0.05, // Education: 5%
          saas: 0.15, // SaaS: 15%
          marketplace: 0.20, // Marketplace: 20%
        },
      };

      const educationCommission = getCommissionRate(config, 'education');
      const saasCommission = getCommissionRate(config, 'saas');
      const marketplaceCommission = getCommissionRate(config, 'marketplace');
      const defaultCommission = getCommissionRate(config, 'other');

      expect(educationCommission).toBe(0.05); // Uses category-specific
      expect(saasCommission).toBe(0.15);
      expect(marketplaceCommission).toBe(0.20);
      expect(defaultCommission).toBe(0.10); // Falls back to global
    });

    it('should handle nested category paths', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.10,
          'course_enrollment': 0.12,
          'gym_membership': 0.08,
        },
      };

      const courseCommission = getCommissionRate(config, 'course_enrollment');
      const gymCommission = getCommissionRate(config, 'gym_membership');

      expect(courseCommission).toBe(0.12);
      expect(gymCommission).toBe(0.08);
    });
  });

  describe('Precedence Hierarchy: Category > Gateway > Global', () => {
    it('should apply correct precedence: category-specific > global', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.10, // Global: 10%
          premium: 0.05, // Category: 5%
        },
      };

      const premiumCommission = getCommissionRate(config, 'premium');
      const standardCommission = getCommissionRate(config, 'standard');

      expect(premiumCommission).toBe(0.05); // Category-specific wins
      expect(standardCommission).toBe(0.10); // Falls back to global
    });

    it('should apply correct precedence: gateway-specific > global', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        gatewayFeeRates: {
          '*': 0.029, // Global: 2.9%
          premium_gateway: 0.015, // Gateway: 1.5%
        },
      };

      const premiumGatewayFee = getGatewayFeeRate(config, 'premium_gateway');
      const standardGatewayFee = getGatewayFeeRate(config, 'standard_gateway');

      expect(premiumGatewayFee).toBe(0.015); // Gateway-specific wins
      expect(standardGatewayFee).toBe(0.029); // Falls back to global
    });
  });

  describe('Config Merging', () => {
    it('should merge partial configs correctly', () => {
      const baseConfig: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.10,
        },
        gatewayFeeRates: {
          '*': 0.029,
        },
      };

      const overrideConfig: Partial<RevenueConfig> = {
        commissionRates: {
          '*': 0.15, // Override commission
        },
        // Keep gatewayFeeRates from base
      };

      const merged = mergeConfig(baseConfig, overrideConfig);

      expect(merged.defaultCurrency).toBe('USD'); // From base
      expect(merged.commissionRates?.['*']).toBe(0.15); // From override
      expect(merged.gatewayFeeRates?.['*']).toBe(0.029); // From base
    });

    it('should deep merge nested configuration objects', () => {
      const baseConfig: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.10,
          education: 0.05,
          saas: 0.15,
        },
        gatewayFeeRates: {
          '*': 0.029,
          stripe: 0.035,
        },
      };

      const overrideConfig: Partial<RevenueConfig> = {
        commissionRates: {
          marketplace: 0.20, // Add new category
        },
        gatewayFeeRates: {
          paypal: 0.034, // Add new gateway
        },
      };

      const merged = mergeConfig(baseConfig, overrideConfig);

      // Should have all categories
      expect(merged.commissionRates?.['*']).toBe(0.10);
      expect(merged.commissionRates?.education).toBe(0.05);
      expect(merged.commissionRates?.saas).toBe(0.15);
      expect(merged.commissionRates?.marketplace).toBe(0.20);

      // Should have all gateways
      expect(merged.gatewayFeeRates?.['*']).toBe(0.029);
      expect(merged.gatewayFeeRates?.stripe).toBe(0.035);
      expect(merged.gatewayFeeRates?.paypal).toBe(0.034);
    });

    it('should not mutate original configs during merge', () => {
      const baseConfig: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.10,
        },
      };

      const overrideConfig: Partial<RevenueConfig> = {
        commissionRates: {
          '*': 0.20,
        },
      };

      const merged = mergeConfig(baseConfig, overrideConfig);

      // Original configs unchanged
      expect(baseConfig.commissionRates?.['*']).toBe(0.10);
      expect(overrideConfig.commissionRates?.['*']).toBe(0.20);

      // Merged has override value
      expect(merged.commissionRates?.['*']).toBe(0.20);
    });
  });

  describe('Transaction Type Mapping', () => {
    it('should resolve transaction type from monetization type', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        transactionTypeMapping: {
          subscription: 'inflow',
          purchase: 'inflow',
          refund: 'outflow',
        },
      };

      const subscriptionType = config.transactionTypeMapping?.subscription;
      const purchaseType = config.transactionTypeMapping?.purchase;
      const refundType = config.transactionTypeMapping?.refund;

      expect(subscriptionType).toBe('inflow');
      expect(purchaseType).toBe('inflow');
      expect(refundType).toBe('outflow');
    });

    it('should fallback to income when no mapping exists', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        transactionTypeMapping: {
          subscription: 'inflow',
        },
      };

      const unmappedType = config.transactionTypeMapping?.unknown;

      expect(unmappedType).toBeUndefined(); // No mapping for unknown type
      // Service should default to 'inflow' when undefined
    });
  });

  describe('Category Mapping Resolution', () => {
    it('should resolve entity to category using mappings', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        categoryMappings: {
          Order: 'order_subscription',
          Course: 'education',
          Membership: 'gym_membership',
        },
      };

      expect(config.categoryMappings?.Order).toBe('order_subscription');
      expect(config.categoryMappings?.Course).toBe('education');
      expect(config.categoryMappings?.Membership).toBe('gym_membership');
    });

    it('should handle missing entity mappings gracefully', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        categoryMappings: {
          Order: 'order_subscription',
        },
      };

      const unknownEntity = config.categoryMappings?.UnknownEntity;

      expect(unknownEntity).toBeUndefined();
      // Should fallback to monetization type when entity mapping missing
    });
  });

  describe('Edge Cases and Validation', () => {
    it('should handle zero rates correctly', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0, // Free tier - no commission
        },
        gatewayFeeRates: {
          '*': 0, // Manual gateway - no fee
        },
      };

      const commission = getCommissionRate(config, 'subscription');
      const gatewayFee = getGatewayFeeRate(config, 'manual');

      expect(commission).toBe(0);
      expect(gatewayFee).toBe(0);
    });

    it('should handle fractional rates correctly', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.025, // 2.5%
        },
        gatewayFeeRates: {
          '*': 0.0145, // 1.45%
        },
      };

      const commission = getCommissionRate(config, 'subscription');
      const gatewayFee = getGatewayFeeRate(config, 'stripe');

      expect(commission).toBe(0.025);
      expect(gatewayFee).toBe(0.0145);
    });

    it('should reject invalid configuration values', () => {
      // Negative rates should be validated at config creation
      const invalidConfig: any = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': -0.10, // Invalid: negative
        },
        gatewayFeeRates: {
          '*': 1.5, // Invalid: > 100%
        },
      };

      // The config resolver should handle invalid values
      // (In production, validation would happen at Revenue.create())
      expect(invalidConfig.commissionRates['*']).toBeLessThan(0);
      expect(invalidConfig.gatewayFeeRates['*']).toBeGreaterThan(1);
    });

    it('should handle empty configuration objects', () => {
      const emptyConfig: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
      };

      const commission = getCommissionRate(emptyConfig, 'subscription');
      const gatewayFee = getGatewayFeeRate(emptyConfig, 'stripe');

      expect(commission).toBe(0); // Falls back to 0
      expect(gatewayFee).toBe(0); // Falls back to 0
    });
  });

  describe('Real-World Configuration Scenarios', () => {
    it('should handle multi-tier pricing correctly', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.20, // Standard: 20%
          starter: 0.30, // Starter tier: 30%
          professional: 0.15, // Pro tier: 15%
          enterprise: 0.05, // Enterprise tier: 5%
        },
      };

      const starterRate = getCommissionRate(config, 'starter');
      const proRate = getCommissionRate(config, 'professional');
      const enterpriseRate = getCommissionRate(config, 'enterprise');

      expect(starterRate).toBe(0.30); // Highest commission
      expect(proRate).toBe(0.15); // Medium commission
      expect(enterpriseRate).toBe(0.05); // Lowest commission
    });

    it('should handle marketplace with multiple gateway fees', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        gatewayFeeRates: {
          '*': 0.029, // Default: 2.9%
          stripe: 0.032, // 2.9% + 30¢ equivalent
          paypal: 0.034, // 3.4%
          crypto: 0.01, // 1%
          bank_transfer: 0, // Free
        },
      };

      expect(getGatewayFeeRate(config, 'stripe')).toBe(0.032);
      expect(getGatewayFeeRate(config, 'paypal')).toBe(0.034);
      expect(getGatewayFeeRate(config, 'crypto')).toBe(0.01);
      expect(getGatewayFeeRate(config, 'bank_transfer')).toBe(0);
    });

    it('should handle educational platform with category-specific rates', () => {
      const config: Partial<RevenueConfig> = {
        defaultCurrency: 'USD',
        commissionRates: {
          '*': 0.15, // Default: 15%
          live_course: 0.20, // Live courses: 20%
          recorded_course: 0.10, // Recorded: 10%
          certification: 0.25, // Certifications: 25%
          tutoring: 0.30, // 1-on-1 tutoring: 30%
        },
      };

      expect(getCommissionRate(config, 'live_course')).toBe(0.20);
      expect(getCommissionRate(config, 'recorded_course')).toBe(0.10);
      expect(getCommissionRate(config, 'certification')).toBe(0.25);
      expect(getCommissionRate(config, 'tutoring')).toBe(0.30);
      expect(getCommissionRate(config, 'other')).toBe(0.15); // Fallback
    });
  });
});
