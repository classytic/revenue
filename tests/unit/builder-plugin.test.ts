/**
 * Revenue Builder & Plugin Tests
 * @classytic/revenue
 *
 * Tests fluent builder API, configuration validation, and plugin system
 */

import { describe, it, expect, vi } from 'vitest';
import { Revenue, RevenueBuilder, createRevenue } from '../../revenue/src/core/revenue.js';
import { ConfigurationError } from '../../revenue/src/core/errors.js';
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '../../revenue/src/providers/base.js';
import { definePlugin, PluginManager } from '../../revenue/src/core/plugin.js';

// Minimal mock provider for builder tests
class MockProvider extends PaymentProvider {
  override name = 'mock';

  async createIntent() {
    return new PaymentIntent({
      id: 'pi_1',
      provider: 'mock',
      status: 'pending',
      amount: 1000,
    });
  }

  async verifyPayment() {
    return new PaymentResult({
      id: 'pr_1',
      provider: 'mock',
      status: 'succeeded',
    });
  }

  async getStatus() {
    return new PaymentResult({
      id: 'pr_1',
      provider: 'mock',
      status: 'succeeded',
    });
  }

  async refund() {
    return new RefundResult({
      id: 'rf_1',
      provider: 'mock',
      status: 'succeeded',
    });
  }

  async handleWebhook() {
    return new WebhookEvent({
      id: 'evt_1',
      provider: 'mock',
      type: 'payment.succeeded',
      data: { paymentIntentId: 'pi_1' },
    });
  }

  override getCapabilities() {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }
}

// Minimal mock model
const mockTransactionModel = {
  findById: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  find: vi.fn(() => ({
    limit: vi.fn(() => ({
      skip: vi.fn(() => ({
        sort: vi.fn(() => Promise.resolve([])),
      })),
    })),
  })),
};

describe('Revenue Builder', () => {
  describe('Validation', () => {
    it('should throw when no models are provided', () => {
      expect(() =>
        Revenue.create().withProvider('mock', new MockProvider()).build()
      ).toThrow(ConfigurationError);
    });

    it('should throw when Transaction model is missing', () => {
      expect(() =>
        Revenue.create()
          .withModels({ Transaction: undefined as any })
          .withProvider('mock', new MockProvider())
          .build()
      ).toThrow(ConfigurationError);
    });

    it('should throw when no providers are registered', () => {
      expect(() =>
        Revenue.create()
          .withModels({ Transaction: mockTransactionModel as any })
          .build()
      ).toThrow(ConfigurationError);
    });

    it('should throw with helpful error messages', () => {
      try {
        Revenue.create().withProvider('mock', new MockProvider()).build();
        expect.fail('Should throw');
      } catch (e) {
        expect((e as Error).message).toContain('Models are required');
        expect((e as Error).message).toContain('.withModels');
      }
    });
  });

  describe('Fluent API', () => {
    it('should build a valid Revenue instance', () => {
      const revenue = Revenue.create({ defaultCurrency: 'BDT' })
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      expect(revenue).toBeInstanceOf(Revenue);
      expect(revenue.defaultCurrency).toBe('BDT');
    });

    it('should chain builder methods', () => {
      const builder = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .withRetry({ maxAttempts: 5 })
        .withCircuitBreaker(true)
        .withDebug(true)
        .forEnvironment('production')
        .withCommission(0.10, 0.029);

      expect(builder).toBeInstanceOf(RevenueBuilder);

      const revenue = builder.build();
      expect(revenue.environment).toBe('production');
    });

    it('should register multiple providers', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock1', new MockProvider())
        .withProvider('mock2', new MockProvider())
        .build();

      expect(revenue.hasProvider('mock1')).toBe(true);
      expect(revenue.hasProvider('mock2')).toBe(true);
      expect(revenue.getProviderNames()).toContain('mock1');
      expect(revenue.getProviderNames()).toContain('mock2');
    });

    it('should use withProviders for bulk registration', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProviders({
          a: new MockProvider(),
          b: new MockProvider(),
        })
        .build();

      expect(revenue.hasProvider('a')).toBe(true);
      expect(revenue.hasProvider('b')).toBe(true);
    });

    it('should throw when getting non-existent provider', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      expect(() => revenue.getProvider('nonexistent')).toThrow(ConfigurationError);
    });
  });

  describe('Defaults', () => {
    it('should default currency to USD', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      expect(revenue.defaultCurrency).toBe('USD');
    });

    it('should default environment to development', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      expect(revenue.environment).toBe('development');
    });
  });

  describe('createRevenue shorthand', () => {
    it('should create Revenue with object config', () => {
      const revenue = createRevenue({
        models: { Transaction: mockTransactionModel as any },
        providers: { mock: new MockProvider() },
        options: { defaultCurrency: 'EUR' },
      });

      expect(revenue).toBeInstanceOf(Revenue);
      expect(revenue.defaultCurrency).toBe('EUR');
    });
  });

  describe('Services', () => {
    it('should expose all service instances', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      expect(revenue.monetization).toBeDefined();
      expect(revenue.payments).toBeDefined();
      expect(revenue.transactions).toBeDefined();
      expect(revenue.escrow).toBeDefined();
      expect(revenue.settlement).toBeDefined();
    });
  });

  describe('Event System', () => {
    it('should expose on/off/once/emit', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      expect(typeof revenue.on).toBe('function');
      expect(typeof revenue.off).toBe('function');
      expect(typeof revenue.once).toBe('function');
      expect(typeof revenue.emit).toBe('function');
    });

    it('should delegate events to internal EventBus', async () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      const handler = vi.fn();
      revenue.on('payment.verified', handler);

      revenue.emit('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('Destroy', () => {
    it('should cleanup on destroy', async () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .build();

      // Should not throw
      await revenue.destroy();
    });
  });
});

describe('Plugin System', () => {
  describe('Registration', () => {
    it('should register plugins', () => {
      const manager = new PluginManager();
      const plugin = definePlugin({ name: 'test', version: '1.0.0' });
      manager.register(plugin);

      expect(manager.has('test')).toBe(true);
      expect(manager.get('test')).toBe(plugin);
    });

    it('should reject duplicate plugin names', () => {
      const manager = new PluginManager();
      manager.register(definePlugin({ name: 'test' }));

      expect(() =>
        manager.register(definePlugin({ name: 'test' }))
      ).toThrow('already registered');
    });

    it('should enforce dependency order', () => {
      const manager = new PluginManager();

      expect(() =>
        manager.register(definePlugin({ name: 'child', dependencies: ['parent'] }))
      ).toThrow('requires "parent"');
    });

    it('should allow dependency registration in order', () => {
      const manager = new PluginManager();
      manager.register(definePlugin({ name: 'parent' }));
      manager.register(definePlugin({ name: 'child', dependencies: ['parent'] }));

      expect(manager.has('child')).toBe(true);
    });

    it('should list all plugins', () => {
      const manager = new PluginManager();
      manager.register(definePlugin({ name: 'a' }));
      manager.register(definePlugin({ name: 'b' }));

      const list = manager.list();
      expect(list).toHaveLength(2);
    });
  });

  describe('Hook Execution', () => {
    it('should execute hooks in middleware chain', async () => {
      const manager = new PluginManager();
      const order: string[] = [];

      manager.register(definePlugin({
        name: 'first',
        hooks: {
          'payment.verify.before': async (_ctx, _input, next) => {
            order.push('before-1');
            const result = await next();
            order.push('after-1');
            return result;
          },
        },
      }));

      manager.register(definePlugin({
        name: 'second',
        hooks: {
          'payment.verify.before': async (_ctx, _input, next) => {
            order.push('before-2');
            const result = await next();
            order.push('after-2');
            return result;
          },
        },
      }));

      const ctx = {
        events: {} as any,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        storage: new Map(),
        meta: { requestId: 'test', timestamp: new Date() },
      };

      await manager.executeHook(
        'payment.verify.before',
        ctx,
        { id: 'test' },
        async () => {
          order.push('execute');
          return { verified: true };
        }
      );

      expect(order).toEqual(['before-1', 'before-2', 'execute', 'after-2', 'after-1']);
    });

    it('should pass through when no hooks registered', async () => {
      const manager = new PluginManager();
      const ctx = {
        events: {} as any,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        storage: new Map(),
        meta: { requestId: 'test', timestamp: new Date() },
      };

      const result = await manager.executeHook(
        'payment.verify.before',
        ctx,
        { id: 'test' },
        async () => ({ verified: true })
      );

      expect(result).toEqual({ verified: true });
    });
  });

  describe('definePlugin', () => {
    it('should pass through plugin definition', () => {
      const plugin = definePlugin({
        name: 'custom',
        version: '2.0.0',
        description: 'A custom plugin',
      });

      expect(plugin.name).toBe('custom');
      expect(plugin.version).toBe('2.0.0');
    });
  });

  describe('Builder Plugin Integration', () => {
    it('should register plugins via builder', () => {
      const initFn = vi.fn();

      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .withPlugin(definePlugin({
          name: 'test-plugin',
          init: initFn,
        }))
        .build();

      expect(revenue).toBeInstanceOf(Revenue);
      // init is called async, give it time
    });

    it('should register multiple plugins via withPlugins', () => {
      const revenue = Revenue.create()
        .withModels({ Transaction: mockTransactionModel as any })
        .withProvider('mock', new MockProvider())
        .withPlugins([
          definePlugin({ name: 'p1' }),
          definePlugin({ name: 'p2' }),
        ])
        .build();

      expect(revenue).toBeInstanceOf(Revenue);
    });
  });
});

describe('Error Classes', () => {
  it('should serialize ConfigurationError to JSON', () => {
    const error = new ConfigurationError('missing model', { model: 'Transaction' });
    const json = error.toJSON();

    expect(json.name).toBe('ConfigurationError');
    expect(json.code).toBe('CONFIGURATION_ERROR');
    expect(json.retryable).toBe(false);
    expect(json.metadata).toEqual({ model: 'Transaction' });
  });
});
