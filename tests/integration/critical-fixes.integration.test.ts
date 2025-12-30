/**
 * Critical Fixes Integration Tests
 * Tests for tax plugin, EventBus types, and transaction hooks
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, type Model } from 'mongoose';
import { connectToMongoDB, disconnectFromMongoDB, clearCollections } from '../helpers/mongodb-memory.js';
import { Revenue } from '../../revenue/src/core/revenue.js';
import { createTaxPlugin } from '../../revenue/src/infrastructure/plugins/business/tax.plugin.js';
import { definePlugin } from '../../revenue/src/core/plugin.js';
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult } from '../../revenue/src/providers/base.js';
import type { CreateIntentParams } from '../../revenue/src/shared/types/index.js';
import type { TaxConfig } from '../../revenue/src/shared/types/tax.js';

interface ITransaction {
  organizationId?: string | mongoose.Types.ObjectId;
  customerId?: string | mongoose.Types.ObjectId;
  sourceId?: string | mongoose.Types.ObjectId;
  sourceModel?: string;
  sourceId?: string | mongoose.Types.ObjectId;
  sourceModel?: string;
  category?: string;
  type?: string;
  flow?: 'inflow' | 'outflow';
  method?: string;
  monetizationType?: string;
  amount: number;
  currency: string;
  status: string;
  gateway?: Record<string, unknown>;
  commission?: Record<string, unknown>;
  tax?: Record<string, unknown>;
  hold?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface ISubscription {
  organizationId?: string | mongoose.Types.ObjectId;
  customerId?: string | mongoose.Types.ObjectId;
  planKey?: string;
  status: string;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    organizationId: Schema.Types.Mixed,
    customerId: Schema.Types.Mixed,
    sourceId: Schema.Types.Mixed,
    sourceModel: String,
    category: String,
    type: { type: String, default: 'payment' },
    flow: { type: String, default: 'inflow' },
    method: { type: String, default: 'manual' },
    monetizationType: String,
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    status: { type: String, default: 'pending' },
    gateway: Schema.Types.Mixed,
    commission: Schema.Types.Mixed,
    tax: Schema.Types.Mixed,
    hold: Schema.Types.Mixed,
    metadata: Schema.Types.Mixed,
  },
  { timestamps: true, strict: false }
);

const SubscriptionSchema = new Schema<ISubscription>(
  {
    organizationId: Schema.Types.Mixed,
    customerId: Schema.Types.Mixed,
    planKey: String,
    isActive: { type: Boolean, default: false },
    status: { type: String, default: 'pending' },
  },
  { timestamps: true, strict: false }
);

class TestProvider extends PaymentProvider {
  public override readonly name = 'manual';
  private intents = new Map<string, { amount: number; currency: string }>();

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.intents.set(id, { amount: params.amount, currency: params.currency ?? 'USD' });
    return new PaymentIntent({
      id,
      sessionId: null,
      paymentIntentId: id,
      provider: this.name,
      status: 'requires_confirmation',
      amount: params.amount,
      currency: params.currency ?? 'USD',
      metadata: params.metadata ?? {},
    });
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const info = this.intents.get(intentId) ?? { amount: 0, currency: 'USD' };
    return new PaymentResult({
      id: intentId,
      provider: this.name,
      status: 'succeeded',
      amount: info.amount,
      currency: info.currency,
      paidAt: new Date(),
      metadata: { verified: true },
    });
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    const info = this.intents.get(paymentId) ?? { amount: 0, currency: 'USD' };
    return new RefundResult({
      id: `refund_${paymentId}`,
      provider: this.name,
      status: 'succeeded',
      amount: amount ?? info.amount,
      currency: info.currency,
      refundedAt: new Date(),
      metadata: {},
    });
  }

  async handleWebhook(): Promise<any> {
    throw new Error('Webhook not supported for TestProvider');
  }
}

let Transaction: Model<ITransaction>;
let Subscription: Model<ISubscription>;
let mongoAvailable = true;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (mongoAvailable) {
    if (mongoose.models.Transaction) {
      delete mongoose.models.Transaction;
    }
    if (mongoose.models.Subscription) {
      delete mongoose.models.Subscription;
    }
    Transaction = mongoose.model<ITransaction>('Transaction', TransactionSchema);
    Subscription = mongoose.model<ISubscription>('Subscription', SubscriptionSchema);
  }
});

afterAll(async () => {
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (!mongoAvailable) return;
  await clearCollections();
});

describe('Critical Fixes Integration Tests', () => {
  describe('Tax Plugin Fix', () => {
    it('should read organizationId from input.data.organizationId', async () => {
      let pluginExecuted = false;
      let capturedOrgId: string | null = null;

      const testTaxPlugin = createTaxPlugin({
        getTaxConfig: async (orgId: string): Promise<TaxConfig> => {
          pluginExecuted = true;
          capturedOrgId = orgId;

          return {
            isRegistered: true,
            defaultRate: 0.10,
            pricesIncludeTax: false,
            exemptCategories: [],
          };
        },
        categoryMappings: {
          Order: 'order_subscription',
        },
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(testTaxPlugin)
        .build();

      await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        entity: 'Order',
        monetizationType: 'subscription',
      });

      expect(pluginExecuted).toBe(true);
      expect(capturedOrgId).toBe('org_123');
    });

    it('should resolve category from entity and monetizationType', async () => {
      let capturedTaxCalculation: any = null;

      const testTaxPlugin = createTaxPlugin({
        getTaxConfig: async (orgId: string): Promise<TaxConfig> => {
          return {
            isRegistered: true,
            defaultRate: 0.15,
            pricesIncludeTax: false,
            exemptCategories: [],
          };
        },
        categoryMappings: {
          Order: 'order_subscription',
          Membership: 'gym_membership',
        },
      });

      // Override the plugin to capture tax calculation
      const wrappedPlugin = definePlugin({
        ...testTaxPlugin,
        hooks: {
          'monetization.create.before': async (ctx, input, next) => {
            const result = await testTaxPlugin.hooks!['monetization.create.before']!(ctx, input, next);
            capturedTaxCalculation = (input as any).tax;
            return result;
          },
        },
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(wrappedPlugin)
        .build();

      await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        entity: 'Order',
        monetizationType: 'subscription',
      });

      expect(capturedTaxCalculation).toBeDefined();
      expect(capturedTaxCalculation?.taxAmount).toBe(1500); // 15% of 10000
    });
  });

  describe('EventBus Type Coverage', () => {
    it('should emit payment.verified event with correct payload', async () => {
      const events: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('payment.verified', (event) => {
        events.push(event);
      });

      const result = await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        monetizationType: 'subscription',
      });

      await revenue.payments.verify(result.transaction._id.toString());

      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty('transaction');
      expect(events[0]).toHaveProperty('paymentResult');
      expect(events[0]).toHaveProperty('timestamp');
    });

    it('should emit monetization.created event', async () => {
      const events: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('monetization.created', (event) => {
        events.push(event);
      });

      await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        monetizationType: 'subscription',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty('transaction');
      expect(events[0]).toHaveProperty('timestamp');
    });

    it('should emit transaction.updated event', async () => {
      const events: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('transaction.updated', (event) => {
        events.push(event);
      });

      const result = await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        monetizationType: 'purchase',
      });

      await revenue.transactions.update(result.transaction._id.toString(), {
        metadata: { test: 'value' },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toHaveProperty('transaction');
      expect(events[0]).toHaveProperty('updates');
      expect(events[0]).toHaveProperty('timestamp');
    });
  });

  describe('Transaction Plugin Hooks', () => {
    it('should execute transaction.update.before hook', async () => {
      let beforeHookExecuted = false;
      let capturedInput: any = null;

      const testPlugin = definePlugin({
        name: 'transaction-test',
        hooks: {
          'transaction.update.before': async (ctx, input, next) => {
            beforeHookExecuted = true;
            capturedInput = input;
            return next();
          },
        },
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(testPlugin)
        .build();

      const result = await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        monetizationType: 'purchase',
      });

      await revenue.transactions.update(result.transaction._id.toString(), {
        metadata: { test: 'value' },
      });

      expect(beforeHookExecuted).toBe(true);
      expect(capturedInput).toHaveProperty('transactionId');
      expect(capturedInput).toHaveProperty('updates');
      expect(capturedInput.updates).toEqual({ metadata: { test: 'value' } });
    });

    it('should execute transaction.update.after hook', async () => {
      let afterHookExecuted = false;
      let capturedResult: any = null;

      const testPlugin = definePlugin({
        name: 'transaction-test',
        hooks: {
          'transaction.update.after': async (ctx, input, next) => {
            afterHookExecuted = true;
            const result = await next();
            capturedResult = result;
            return result;
          },
        },
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(testPlugin)
        .build();

      const result = await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        monetizationType: 'purchase',
      });

      const updated = await revenue.transactions.update(result.transaction._id.toString(), {
        metadata: { test: 'value' },
      });

      expect(afterHookExecuted).toBe(true);
      expect(capturedResult).toBeDefined();
      expect(capturedResult._id.toString()).toBe(updated._id.toString());
    });

    it('should allow plugins to modify transaction updates', async () => {
      const auditPlugin = definePlugin({
        name: 'audit',
        hooks: {
          'transaction.update.before': async (ctx, input, next) => {
            // Add audit metadata to updates
            (input as any).updates = {
              ...(input as any).updates,
              metadata: {
                ...(input as any).updates?.metadata,
                auditedAt: new Date(),
                auditedBy: 'system',
              },
            };
            return next();
          },
        },
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(auditPlugin)
        .build();

      const result = await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        monetizationType: 'purchase',
      });

      const updated = await revenue.transactions.update(result.transaction._id.toString(), {
        metadata: { test: 'value' },
      });

      expect(updated.metadata).toHaveProperty('test', 'value');
      expect(updated.metadata).toHaveProperty('auditedAt');
      expect(updated.metadata).toHaveProperty('auditedBy', 'system');
    });
  });

  describe('End-to-End Integration', () => {
    it('should work with tax plugin + transaction hooks + events', async () => {
      const capturedEvents: Record<string, any[]> = {
        'monetization.created': [],
        'payment.verified': [],
        'transaction.updated': [],
      };

      let taxPluginExecuted = false;
      let transactionHookExecuted = false;

      const taxPlugin = createTaxPlugin({
        getTaxConfig: async (orgId: string): Promise<TaxConfig> => {
          taxPluginExecuted = true;
          return {
            isRegistered: true,
            defaultRate: 0.10,
            pricesIncludeTax: false,
            exemptCategories: [],
          };
        },
        categoryMappings: {
          Order: 'order_subscription',
        },
      });

      const auditPlugin = definePlugin({
        name: 'audit',
        hooks: {
          'transaction.update.before': async (ctx, input, next) => {
            transactionHookExecuted = true;
            return next();
          },
        },
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(taxPlugin)
        .withPlugin(auditPlugin)
        .build();

      // Subscribe to events
      revenue.events.on('monetization.created', (event) => {
        capturedEvents['monetization.created'].push(event);
      });
      revenue.events.on('payment.verified', (event) => {
        capturedEvents['payment.verified'].push(event);
      });
      revenue.events.on('transaction.updated', (event) => {
        capturedEvents['transaction.updated'].push(event);
      });

      // Create monetization
      const result = await revenue.monetization.create({
        data: {
          organizationId: 'org_123',
          customerId: 'cust_456',
        },
        planKey: 'test_plan',
        amount: 10000,
        entity: 'Order',
        monetizationType: 'subscription',
      });

      // Verify payment
      await revenue.payments.verify(result.transaction._id.toString());

      // Update transaction
      await revenue.transactions.update(result.transaction._id.toString(), {
        metadata: { notes: 'Test update' },
      });

      // Assert tax plugin executed
      expect(taxPluginExecuted).toBe(true);

      // Assert transaction hook executed
      expect(transactionHookExecuted).toBe(true);

      // Assert events emitted
      expect(capturedEvents['monetization.created']).toHaveLength(1);
      expect(capturedEvents['payment.verified']).toHaveLength(1);
      expect(capturedEvents['transaction.updated']).toHaveLength(1);

      // Verify tax was applied (UNIFIED STRUCTURE)
      expect(result.transaction.tax).toBeDefined();
      expect(result.transaction.tax).toBe(1000); // ✅ Now a number (10% of 10000)
    });
  });
});
