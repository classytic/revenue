/**
 * Payment Service Integration Tests
 * @classytic/revenue
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PaymentService,
  Container,
  ValidationError,
  ProviderCapabilityError,
  TransactionNotFoundError,
} from '../../revenue/dist/index.js';
import type {
  PaymentResultData,
  RefundResultData,
  WebhookEventData,
  ProviderCapabilities,
} from '../../revenue/dist/index.js';

// Mock Transaction class
class MockTransaction {
  _id: string;
  amount: number;
  currency: string;
  status: string;
  gateway: { paymentIntentId?: string; sessionId?: string; type: string };
  metadata: Record<string, unknown>;
  method: string;
  category: string;
  webhook?: { eventId?: string; processedAt?: Date };
  refundedAmount?: number;
  verifiedAt?: Date;
  verifiedBy?: string | null;
  failureReason?: string;
  refundedAt?: Date;

  constructor(data: Partial<MockTransaction> = {}) {
    this._id = data._id ?? 'txn_' + Math.random().toString(36).substring(7);
    this.amount = data.amount ?? 1000;
    this.currency = data.currency ?? 'BDT';
    this.status = data.status ?? 'pending';
    this.gateway = data.gateway ?? { paymentIntentId: 'pi_123', type: 'test' };
    this.metadata = data.metadata ?? {};
    this.method = data.method ?? 'manual';
    this.category = data.category ?? 'subscription';
    this.webhook = data.webhook;
    this.refundedAmount = data.refundedAmount;
    this.verifiedAt = data.verifiedAt;
    this.verifiedBy = data.verifiedBy;
    this.failureReason = data.failureReason;
    this.refundedAt = data.refundedAt;
  }

  async save() {
    return this;
  }

  static currentMock: MockTransaction | null = null;

  static async findById(id: string) {
    return MockTransaction.currentMock ?? new MockTransaction({ _id: id });
  }

  static async findOne(query: Record<string, unknown>) {
    if (query['gateway.paymentIntentId']) {
      return new MockTransaction({
        gateway: { paymentIntentId: query['gateway.paymentIntentId'] as string, type: 'test' },
      });
    }
    if (query['gateway.sessionId']) {
      return new MockTransaction({
        gateway: { sessionId: query['gateway.sessionId'] as string, type: 'test' },
      });
    }
    return null;
  }

  static async create(data: Partial<MockTransaction>) {
    return new MockTransaction(data);
  }
}

interface MockProvider {
  verifyPayment: (id: string) => Promise<PaymentResultData>;
  refund: (id: string, amount: number) => Promise<RefundResultData>;
  handleWebhook: (payload: unknown, headers: Record<string, string>) => Promise<WebhookEventData>;
  getCapabilities: () => ProviderCapabilities;
}

function createMockProvider(overrides: Partial<MockProvider> = {}): MockProvider {
  return {
    verifyPayment: async () => ({
      id: 'pr_123',
      provider: 'test',
      status: 'succeeded',
      amount: 1000,
      currency: 'BDT',
      paidAt: new Date(),
      metadata: {},
    }),
    refund: async (_id: string, amount: number) => ({
      id: 'ref_123',
      provider: 'test',
      status: 'succeeded',
      amount,
      refundedAt: new Date(),
    }),
    handleWebhook: async () => ({
      id: 'evt_123',
      provider: 'test',
      type: 'payment.succeeded',
      data: { paymentIntentId: 'pi_123' },
    }),
    getCapabilities: () => ({
      supportsRefunds: true,
      supportsWebhooks: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    }),
    ...overrides,
  };
}

function createContainer(provider: MockProvider): Container {
  const container = new Container();
  container.singleton('models', { Transaction: MockTransaction });
  container.singleton('providers', { test: provider });
  container.singleton('hooks', {});
  container.singleton('config', { commissionRates: {}, gatewayFeeRates: {} });
  container.singleton('logger', {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  });
  return container;
}

describe('PaymentService', () => {
  beforeEach(() => {
    MockTransaction.currentMock = null;
  });

  describe('verify()', () => {
    it('triggers payment.failed hook on provider error', async () => {
      const hookFn = vi.fn();
      
      const provider = createMockProvider({
        verifyPayment: async () => {
          throw new Error('Provider verification failed');
        },
      });

      const container = createContainer(provider);
      container.singleton('hooks', {
        'payment.failed': [hookFn],
      });

      const service = new PaymentService(container);

      await expect(service.verify('txn_123')).rejects.toThrow();
      expect(hookFn).toHaveBeenCalled();
    });

    it('rejects amount mismatch', async () => {
      const provider = createMockProvider({
        verifyPayment: async () => ({
          id: 'pr_123',
          provider: 'test',
          status: 'succeeded',
          amount: 500, // Tampered!
          currency: 'BDT',
        }),
      });

      const container = createContainer(provider);
      const service = new PaymentService(container);

      await expect(service.verify('txn_123')).rejects.toThrow(ValidationError);
    });

    it('rejects currency mismatch', async () => {
      const provider = createMockProvider({
        verifyPayment: async () => ({
          id: 'pr_123',
          provider: 'test',
          status: 'succeeded',
          amount: 1000,
          currency: 'USD', // Wrong currency!
        }),
      });

      const container = createContainer(provider);
      const service = new PaymentService(container);

      await expect(service.verify('txn_123')).rejects.toThrow(ValidationError);
    });

    it('returns actual status from provider', async () => {
      const provider = createMockProvider({
        verifyPayment: async () => ({
          id: 'pr_123',
          provider: 'test',
          status: 'processing', // Not succeeded
          amount: 1000,
          currency: 'BDT',
        }),
      });

      const container = createContainer(provider);
      const service = new PaymentService(container);

      const result = await service.verify('txn_123');
      expect(result.status).toBe('processing');
    });
  });

  describe('refund()', () => {
    it('rejects over-refund', async () => {
      const mockTxn = new MockTransaction({
        _id: 'txn_123',
        amount: 1000,
        status: 'verified',
        refundedAmount: 600,
        gateway: { type: 'test', paymentIntentId: 'pi_123' },
      });
      MockTransaction.currentMock = mockTxn;
      // Also mock findOne to return null so it falls through to findById
      MockTransaction.findOne = async () => null;

      const provider = createMockProvider();
      const container = createContainer(provider);
      const service = new PaymentService(container);

      // 600 + 500 > 1000
      await expect(service.refund('txn_123', 500)).rejects.toThrow(ValidationError);
    });

    it('rejects negative amount', async () => {
      const mockTxn = new MockTransaction({
        _id: 'txn_123',
        amount: 1000,
        status: 'verified',
        gateway: { type: 'test', paymentIntentId: 'pi_123' },
      });
      MockTransaction.currentMock = mockTxn;
      MockTransaction.findOne = async () => null;

      const provider = createMockProvider();
      const container = createContainer(provider);
      const service = new PaymentService(container);

      await expect(service.refund('txn_123', -100)).rejects.toThrow(ValidationError);
    });

    it('calculates refundable balance correctly', async () => {
      const mockTxn = new MockTransaction({
        _id: 'txn_123',
        amount: 1000,
        status: 'verified',
        refundedAmount: 300,
        gateway: { type: 'test', paymentIntentId: 'pi_123' },
      });
      MockTransaction.currentMock = mockTxn;
      MockTransaction.findOne = async () => null;

      const provider = createMockProvider();
      const container = createContainer(provider);
      const service = new PaymentService(container);

      // Should allow 700 (1000 - 300)
      const result = await service.refund('txn_123', 700);
      expect(result.status).toBe('partially_refunded');
    });
  });

  describe('handleWebhook()', () => {
    it('checks webhook capability', async () => {
      const provider = createMockProvider({
        getCapabilities: () => ({
          supportsRefunds: true,
          supportsWebhooks: false, // No webhook support!
          supportsPartialRefunds: true,
          requiresManualVerification: false,
        }),
      });

      const container = createContainer(provider);
      const service = new PaymentService(container);

      await expect(service.handleWebhook('test', {}, {})).rejects.toThrow(ProviderCapabilityError);
    });

    it('validates payload structure', async () => {
      const provider = createMockProvider({
        handleWebhook: async () => ({
          id: 'evt_123',
          provider: 'test',
          type: 'payment.succeeded',
          data: {}, // Missing paymentIntentId!
        }),
      });

      const container = createContainer(provider);
      const service = new PaymentService(container);

      await expect(service.handleWebhook('test', {}, {})).rejects.toThrow(ValidationError);
    });

    it('handles missing transaction gracefully', async () => {
      const provider = createMockProvider();
      const container = createContainer(provider);
      const service = new PaymentService(container);

      // Mock findOne to return null
      MockTransaction.findOne = async () => null;

      await expect(service.handleWebhook('test', {}, {})).rejects.toThrow(TransactionNotFoundError);
    });
  });
});

