/**
 * Critical Fixes Part 2 Integration Tests
 * Tests for:
 * 1. Tax persistence in transactions
 * 2. EventBus type field auto-injection
 * 3. Subscription event payload matching
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose, { Schema, type Model } from 'mongoose';
import { connectToMongoDB, disconnectFromMongoDB, clearCollections } from '../helpers/mongodb-memory.js';
import { Revenue } from '../../revenue/src/core/revenue.js';
import { createTaxPlugin } from '../../revenue/src/infrastructure/plugins/business/tax.plugin.js';
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
    pausedAt: Date,
    pauseReason: String,
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

describe('Critical Fixes Part 2 Integration Tests', () => {
  describe('Tax Persistence', () => {
    it('should persist tax to transaction when tax plugin calculates it', async () => {
      const taxPlugin = createTaxPlugin({
        getTaxConfig: async (orgId: string): Promise<TaxConfig> => {
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
        incomeCategories: ['order_subscription'],
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(taxPlugin)
        .build();

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

      // Verify tax was persisted to transaction (UNIFIED STRUCTURE)
      expect(result.transaction.tax).toBeDefined();
      expect(result.transaction.tax).toBe(1000); // ✅ Now a number (10% of 10000)
      expect(result.transaction.taxDetails?.type).toBe('sales_tax'); // ✅ Changed from 'collected'
      expect(result.transaction.taxDetails?.rate).toBe(0.10);
    });

    it('should not include tax field when tax plugin is not used', async () => {
      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
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

      // No tax plugin, so tax should be 0 (default)
      expect(result.transaction.tax).toBe(0);
    });
  });

  describe('EventBus Type Field Auto-Injection', () => {
    it('should auto-inject type field when emitting events', async () => {
      const capturedEvents: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('monetization.created', (event) => {
        capturedEvents.push(event);
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

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]).toHaveProperty('type', 'monetization.created');
      expect(capturedEvents[0]).toHaveProperty('timestamp');
      expect(capturedEvents[0].timestamp).toBeInstanceOf(Date);
    });

    it('should inject correct type for all event types', async () => {
      const capturedEvents: Map<string, any> = new Map();

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      // Subscribe to multiple events
      revenue.events.on('purchase.created', (event) => {
        capturedEvents.set('purchase.created', event);
      });
      revenue.events.on('monetization.created', (event) => {
        capturedEvents.set('monetization.created', event);
      });
      revenue.events.on('payment.verified', (event) => {
        capturedEvents.set('payment.verified', event);
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

      await revenue.payments.verify(result.transaction._id.toString());

      // Verify type fields
      expect(capturedEvents.get('purchase.created')).toHaveProperty('type', 'purchase.created');
      expect(capturedEvents.get('monetization.created')).toHaveProperty('type', 'monetization.created');
      expect(capturedEvents.get('payment.verified')).toHaveProperty('type', 'payment.verified');
    });
  });

  describe('Subscription Event Payload Matching', () => {
    it('subscription.activated should match type definition', async () => {
      const capturedEvents: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('subscription.activated', (event) => {
        capturedEvents.push(event);
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
      await revenue.monetization.activate(result.subscription!._id.toString());

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0];

      // Verify payload matches SubscriptionActivatedEvent type
      expect(event).toHaveProperty('type', 'subscription.activated');
      expect(event).toHaveProperty('subscription');
      expect(event).toHaveProperty('activatedAt');
      expect(event).toHaveProperty('timestamp');
      expect(event.subscription).toHaveProperty('_id');
      expect(event.activatedAt).toBeInstanceOf(Date);
    });

    it('subscription.cancelled should match type definition', async () => {
      const capturedEvents: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('subscription.cancelled', (event) => {
        capturedEvents.push(event);
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
      await revenue.monetization.activate(result.subscription!._id.toString());
      await revenue.monetization.cancel(result.subscription!._id.toString(), {
        immediate: true,
        reason: 'Test cancellation',
      });

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0];

      // Verify payload matches SubscriptionCancelledEvent type
      expect(event).toHaveProperty('type', 'subscription.cancelled');
      expect(event).toHaveProperty('subscription');
      expect(event).toHaveProperty('immediate', true);
      expect(event).toHaveProperty('reason', 'Test cancellation');
      expect(event).toHaveProperty('canceledAt');
      expect(event).toHaveProperty('timestamp');
      expect(event.canceledAt).toBeInstanceOf(Date);
    });

    it('subscription.paused should match type definition', async () => {
      const capturedEvents: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('subscription.paused', (event) => {
        capturedEvents.push(event);
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
      await revenue.monetization.activate(result.subscription!._id.toString());
      await revenue.monetization.pause(result.subscription!._id.toString(), {
        reason: 'Test pause',
      });

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0];

      // Verify payload matches SubscriptionPausedEvent type
      expect(event).toHaveProperty('type', 'subscription.paused');
      expect(event).toHaveProperty('subscription');
      expect(event).toHaveProperty('reason', 'Test pause');
      expect(event).toHaveProperty('pausedAt');
      expect(event).toHaveProperty('timestamp');
      expect(event.pausedAt).toBeInstanceOf(Date);
    });

    it('subscription.resumed should match type definition', async () => {
      const capturedEvents: any[] = [];

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .build();

      revenue.events.on('subscription.resumed', (event) => {
        capturedEvents.push(event);
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
      await revenue.monetization.activate(result.subscription!._id.toString());
      await revenue.monetization.pause(result.subscription!._id.toString());
      await revenue.monetization.resume(result.subscription!._id.toString(), {
        extendPeriod: true,
      });

      expect(capturedEvents).toHaveLength(1);
      const event = capturedEvents[0];

      // Verify payload matches SubscriptionResumedEvent type
      expect(event).toHaveProperty('type', 'subscription.resumed');
      expect(event).toHaveProperty('subscription');
      expect(event).toHaveProperty('extendPeriod', true);
      expect(event).toHaveProperty('pauseDuration');
      expect(event).toHaveProperty('resumedAt');
      expect(event).toHaveProperty('timestamp');
      expect(event.resumedAt).toBeInstanceOf(Date);
      expect(typeof event.pauseDuration).toBe('number');
    });
  });

  describe('End-to-End Integration', () => {
    it('should work with all fixes combined', async () => {
      const capturedEvents: Record<string, any[]> = {
        'monetization.created': [],
        'payment.verified': [],
        'subscription.activated': [],
      };

      const taxPlugin = createTaxPlugin({
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
        },
      });

      const revenue = Revenue
        .create()
        .withModels({ Transaction, Subscription })
        .withProvider('manual', new TestProvider())
        .withPlugin(taxPlugin)
        .build();

      // Subscribe to events
      revenue.events.on('monetization.created', (event) => {
        capturedEvents['monetization.created'].push(event);
      });
      revenue.events.on('payment.verified', (event) => {
        capturedEvents['payment.verified'].push(event);
      });
      revenue.events.on('subscription.activated', (event) => {
        capturedEvents['subscription.activated'].push(event);
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

      // Activate subscription
      await revenue.monetization.activate(result.subscription!._id.toString());

      // Assert tax persisted (UNIFIED STRUCTURE)
      expect(result.transaction.tax).toBeDefined();
      expect(result.transaction.tax).toBe(1500); // ✅ Now a number (15% of 10000)

      // Assert event type fields auto-injected
      expect(capturedEvents['monetization.created'][0]).toHaveProperty('type', 'monetization.created');
      expect(capturedEvents['payment.verified'][0]).toHaveProperty('type', 'payment.verified');
      expect(capturedEvents['subscription.activated'][0]).toHaveProperty('type', 'subscription.activated');

      // Assert subscription event payloads match types
      expect(capturedEvents['subscription.activated'][0]).toHaveProperty('subscription');
      expect(capturedEvents['subscription.activated'][0]).toHaveProperty('activatedAt');
      expect(capturedEvents['subscription.activated'][0].activatedAt).toBeInstanceOf(Date);
    });
  });
});
