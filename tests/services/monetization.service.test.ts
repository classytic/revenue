/**
 * Monetization Service Tests
 * @classytic/revenue
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MonetizationService,
  Container,
  MissingRequiredFieldError,
  InvalidAmountError,
  ProviderNotFoundError,
} from '../../revenue/dist/index.js';
import type { PaymentIntentData } from '../../revenue/dist/index.js';

// Mock Transaction class
class MockTransaction {
  _id: string;
  amount: number;
  currency: string;
  status: string;
  planKey: string;
  isActive: boolean;
  metadata: Record<string, unknown>;

  constructor(data: Partial<MockTransaction> = {}) {
    this._id = data._id ?? 'txn_' + Math.random().toString(36).substring(7);
    this.amount = data.amount ?? 1000;
    this.currency = data.currency ?? 'BDT';
    this.status = data.status ?? 'pending';
    this.planKey = data.planKey ?? 'monthly';
    this.isActive = data.isActive ?? false;
    this.metadata = data.metadata ?? {};
  }

  async save() {
    return this;
  }

  static async findById(id: string) {
    return new MockTransaction({ _id: id });
  }

  static async create(data: Partial<MockTransaction>) {
    return new MockTransaction(data);
  }
}

// Mock Subscription class
class MockSubscription {
  _id: string;
  amount: number;
  currency: string;
  status: string;
  planKey: string;
  isActive: boolean;
  metadata: Record<string, unknown>;

  constructor(data: Partial<MockSubscription> = {}) {
    this._id = data._id ?? 'sub_' + Math.random().toString(36).substring(7);
    this.amount = data.amount ?? 1000;
    this.currency = data.currency ?? 'BDT';
    this.status = data.status ?? 'pending';
    this.planKey = data.planKey ?? 'monthly';
    this.isActive = data.isActive ?? false;
    this.metadata = data.metadata ?? {};
  }

  async save() {
    return this;
  }

  static async findById(id: string) {
    return new MockSubscription({ _id: id });
  }

  static async create(data: Partial<MockSubscription>) {
    return new MockSubscription(data);
  }
}

function createMockProvider() {
  return {
    createIntent: async (params: { amount: number; currency?: string }): Promise<PaymentIntentData> => ({
      id: 'pi_' + Math.random().toString(36).substring(7),
      provider: 'test',
      status: 'pending',
      amount: params.amount,
      currency: params.currency ?? 'BDT',
      metadata: {},
    }),
    verifyPayment: async () => ({ status: 'succeeded' }),
    getStatus: async () => ({ status: 'pending' }),
    refund: async () => ({ status: 'succeeded' }),
    handleWebhook: async () => ({ type: 'payment.succeeded' }),
    getCapabilities: () => ({
      supportsRefunds: true,
      supportsWebhooks: false,
      supportsPartialRefunds: true,
      requiresManualVerification: true,
    }),
  };
}

function createContainer(providers: Record<string, ReturnType<typeof createMockProvider>> = {}) {
  const container = new Container();
  container.singleton('models', {
    Transaction: MockTransaction,
    Subscription: MockSubscription,
  });
  container.singleton('providers', providers);
  container.singleton('hooks', {});
  container.singleton('config', {
    targetModels: ['Subscription'],
    categoryMappings: {},
    commissionRates: {},
    gatewayFeeRates: {},
  });
  container.singleton('logger', {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  });
  return container;
}

describe('MonetizationService', () => {
  describe('create()', () => {
    it('throws MissingRequiredFieldError for missing planKey', async () => {
      const provider = createMockProvider();
      const container = createContainer({ test: provider });
      const service = new MonetizationService(container);

      await expect(
        service.create({
          data: {},
          planKey: '', // Empty!
          amount: 1000,
          gateway: 'test',
        })
      ).rejects.toThrow(MissingRequiredFieldError);
    });

    it('throws InvalidAmountError for negative amount', async () => {
      const provider = createMockProvider();
      const container = createContainer({ test: provider });
      const service = new MonetizationService(container);

      await expect(
        service.create({
          data: {},
          planKey: 'monthly',
          amount: -100, // Negative!
          gateway: 'test',
        })
      ).rejects.toThrow(InvalidAmountError);
    });

    it('throws ProviderNotFoundError for unknown gateway', async () => {
      const container = createContainer({}); // No providers!
      const service = new MonetizationService(container);

      await expect(
        service.create({
          data: {},
          planKey: 'monthly',
          amount: 1000,
          gateway: 'unknown',
        })
      ).rejects.toThrow(ProviderNotFoundError);
    });

    it('creates free subscription without transaction', async () => {
      const provider = createMockProvider();
      const container = createContainer({ test: provider });
      const service = new MonetizationService(container);

      const result = await service.create({
        data: {},
        planKey: 'monthly',
        amount: 0, // Free!
        gateway: 'test',
      });

      expect(result.transaction).toBeNull();
      expect(result.paymentIntent).toBeNull();
      expect(result.subscription).not.toBeNull();
      expect(result.subscription!.isActive).toBe(true);
    });

    it('creates paid subscription with transaction', async () => {
      const provider = createMockProvider();
      const container = createContainer({ test: provider });
      const service = new MonetizationService(container);

      const result = await service.create({
        data: { organizationId: 'org_123' },
        planKey: 'monthly',
        amount: 1000,
        gateway: 'test',
      });

      expect(result.transaction).not.toBeNull();
      expect(result.paymentIntent).not.toBeNull();
      expect(result.subscription).not.toBeNull();
      expect(result.subscription!.isActive).toBe(false); // Not active until verified
    });

    it('triggers monetization.created hook', async () => {
      const hookFn = vi.fn();
      const provider = createMockProvider();
      const container = createContainer({ test: provider });
      container.singleton('hooks', {
        'monetization.created': [hookFn],
      });
      const service = new MonetizationService(container);

      await service.create({
        data: {},
        planKey: 'monthly',
        amount: 1000,
        gateway: 'test',
      });

      // Hook is fire-and-forget, so give it a moment
      await new Promise((r) => setTimeout(r, 10));
      expect(hookFn).toHaveBeenCalled();
    });
  });
});

