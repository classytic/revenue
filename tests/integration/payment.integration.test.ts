/**
 * Integration Tests - @classytic/revenue v2
 *
 * Tests the v2 factory API (createRevenue) with domain verbs on repositories.
 * No service layer — repositories ARE the domain layer.
 *
 * - Real MongoDB (localhost or in-memory fallback)
 * - Arrange-Act-Assert pattern
 * - Isolated tests (clearCollections each time)
 * - Graceful skip if MongoDB unavailable
 */

import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { connectToMongoDB, disconnectFromMongoDB, clearCollections } from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';
import {
  createRevenue,
  PaymentProvider,
  TRANSACTION_STATUS,
  SUBSCRIPTION_STATUS,
  HOLD_STATUS,
  SETTLEMENT_STATUS,
} from '../../revenue/src/index.js';
import type {
  CreateIntentParams,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

const TEST_TIMEOUT = 15000;

// ============ FAKE PROVIDER ============

class FakeProvider extends PaymentProvider {
  public override readonly name = 'fake';
  private store = new Map<string, { amount: number; currency: string; status: string }>();

  constructor() {
    super({});
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const id = `fake_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? 'USD';
    this.store.set(id, {
      amount,
      currency,
      status: 'pending',
    });

    return {
      id,
      sessionId: id,
      paymentIntentId: id,
      provider: 'fake',
      status: 'pending',
      amount: { amount, currency },
      metadata: {},
    };
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const record = this.store.get(intentId);
    if (!record) {
      return {
        id: intentId,
        provider: 'fake',
        status: 'failed',
        metadata: {},
      };
    }
    record.status = 'succeeded';
    return {
      id: intentId,
      provider: 'fake',
      status: 'succeeded',
      amount: { amount: record.amount, currency: record.currency },
      paidAt: new Date(),
      metadata: {},
    };
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    return {
      id: `ref_${paymentId}`,
      provider: 'fake',
      status: 'succeeded',
      amount: { amount: amount ?? 0, currency: 'USD' },
      refundedAt: new Date(),
      metadata: {},
    };
  }

  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const p = payload as any;
    return {
      id: `wh_${Date.now()}`,
      provider: 'fake',
      type: p?.type ?? 'payment.succeeded',
      data: p ?? {},
      createdAt: new Date(),
    };
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

// ============ TEST SETUP ============

let engine: Awaited<ReturnType<typeof createRevenue>>;
let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;

  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { fake: new FakeProvider() },
    modules: { subscription: true, escrow: true, settlement: true },
    scope: { enabled: false, fieldType: 'string' },
  });
  await warmModels(engine);
}, TEST_TIMEOUT);

afterAll(async () => {
  if (engine) await engine.destroy();
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
});

// ============ PAYMENT FLOW ============

describe('Payment Flow', () => {
  it('should create payment intent and transaction', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 10000,
      gateway: 'fake',
      data: { customerId: 'cust_1', sourceId: 'order_1', sourceModel: 'Order' },
    });

    expect(txn).toBeDefined();
    expect(txn.amount).toBe(10000);
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);
    expect(txn.publicId).toMatch(/^txn_/);
    expect(txn.gateway?.paymentIntentId).toBeDefined();
  }, TEST_TIMEOUT);

  it('should verify payment', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 5000,
      gateway: 'fake',
    });

    const verified = await engine.repositories.transaction.verify(
      txn.gateway!.paymentIntentId as string,
      { verifiedBy: 'admin_1' },
    );

    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect(verified.verifiedBy).toBe('admin_1');
    expect(verified.verifiedAt).toBeDefined();
  }, TEST_TIMEOUT);

  it('should process full refund', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 8000,
      gateway: 'fake',
    });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    const refundTxn = await engine.repositories.transaction.refund(
      txn._id.toString(),
      null,
      { reason: 'customer request' },
    );

    expect(refundTxn.amount).toBe(8000);
    expect(refundTxn.type).toBe('refund');
    expect(refundTxn.flow).toBe('outflow');
    // Check original was updated
    const original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
  }, TEST_TIMEOUT);

  it('should process partial refund', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 10000,
      gateway: 'fake',
    });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    const refundTxn = await engine.repositories.transaction.refund(
      txn._id.toString(),
      3000,
      { reason: 'partial' },
    );

    expect(refundTxn.amount).toBe(3000);
    const original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
  }, TEST_TIMEOUT);

  it('should handle idempotency', async () => {
    if (!mongoAvailable) return;

    const first = await engine.repositories.transaction.createPaymentIntent({
      amount: 5000,
      gateway: 'fake',
      idempotencyKey: 'idem_123',
    });

    const second = await engine.repositories.transaction.createPaymentIntent({
      amount: 5000,
      gateway: 'fake',
      idempotencyKey: 'idem_123',
    });

    expect(first._id.toString()).toBe(second._id.toString());
  }, TEST_TIMEOUT);

  it('should handle free (zero amount) transactions', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 0,
      gateway: 'fake',
      monetizationType: 'free',
    });

    expect(txn.status).toBe(TRANSACTION_STATUS.VERIFIED);
    // No payment intent for free — gateway metadata empty
    expect(txn.gateway?.paymentIntentId).toBeUndefined();
  }, TEST_TIMEOUT);
});

// ============ ESCROW FLOW ============

describe('Escrow Flow', () => {
  it('should hold and release', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 20000, gateway: 'fake',
    });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    // Hold — returns updated doc
    const held = await engine.repositories.transaction.hold(txn._id.toString(), { reason: 'marketplace' });
    expect(held.hold!.status).toBe(HOLD_STATUS.HELD);
    expect(held.hold!.heldAmount).toBe(20000);

    // Release — returns updated doc
    const released = await engine.repositories.transaction.release(
      txn._id.toString(), { recipientId: 'seller_1', recipientType: 'user' },
    );
    expect(released.hold!.status).toBe(HOLD_STATUS.RELEASED);
  }, TEST_TIMEOUT);

  it('should split payments', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 10000, gateway: 'fake',
    });
    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    // Split — returns updated transaction doc with splits stored on it
    const updated = await engine.repositories.transaction.split(txn._id.toString(), [
      { type: 'vendor_payout', recipientId: 'vendor_1', recipientType: 'user', rate: 0.8 },
      { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.1 },
    ]);

    expect(updated.splits).toHaveLength(2);
    expect((updated.metadata as any)?.organizationPayout).toBe(1000);
  }, TEST_TIMEOUT);
});

// ============ SUBSCRIPTION FLOW ============

describe('Subscription Flow', () => {
  it('should create and activate subscription', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 2999,
      gateway: 'fake',
      monetizationType: 'subscription',
      planKey: 'monthly',
    });

    // Create subscription via repository
    const sub = await engine.repositories.subscription!.create({
      customerId: 'cust_1',
      planKey: 'monthly',
      amount: 2999,
      status: SUBSCRIPTION_STATUS.PENDING,
      isActive: false,
      transactionId: txn._id,
      startDate: new Date(),
    } as any);

    expect(sub.publicId).toMatch(/^sub_/);

    // Activate
    const activated = await engine.repositories.subscription!.activate(sub._id.toString());
    expect(activated.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(activated.isActive).toBe(true);
    expect(activated.endDate).toBeDefined();
  }, TEST_TIMEOUT);

  it('should pause and resume subscription', async () => {
    if (!mongoAvailable) return;

    const sub = await engine.repositories.subscription!.create({
      customerId: 'cust_1',
      planKey: 'monthly',
      amount: 2999,
      status: SUBSCRIPTION_STATUS.PENDING,
      isActive: false,
      startDate: new Date(),
    } as any);

    await engine.repositories.subscription!.activate(sub._id.toString());

    const paused = await engine.repositories.subscription!.pause(sub._id.toString(), { reason: 'vacation' });
    expect(paused.status).toBe(SUBSCRIPTION_STATUS.PAUSED);

    const resumed = await engine.repositories.subscription!.resume(sub._id.toString());
    expect(resumed.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(resumed.isActive).toBe(true);
  }, TEST_TIMEOUT);

  it('should cancel subscription', async () => {
    if (!mongoAvailable) return;

    const sub = await engine.repositories.subscription!.create({
      customerId: 'cust_1',
      planKey: 'yearly',
      amount: 29999,
      status: SUBSCRIPTION_STATUS.PENDING,
      isActive: false,
      startDate: new Date(),
    } as any);

    await engine.repositories.subscription!.activate(sub._id.toString());

    const cancelled = await engine.repositories.subscription!.cancel(sub._id.toString(), {
      immediate: true,
      reason: 'no longer needed',
    });
    expect(cancelled.status).toBe(SUBSCRIPTION_STATUS.CANCELLED);
    expect(cancelled.isActive).toBe(false);
  }, TEST_TIMEOUT);
});

// ============ SETTLEMENT FLOW ============

describe('Settlement Flow', () => {
  it('should schedule and complete settlement', async () => {
    if (!mongoAvailable) return;

    const settlement = await engine.repositories.settlement!.schedule({
      organizationId: 'org_1',
      recipientId: 'vendor_1',
      recipientType: 'user',
      type: 'split_payout',
      amount: 8000,
      currency: 'USD',
      payoutMethod: 'bank_transfer',
    });

    expect(settlement.publicId).toMatch(/^stl_/);
    expect(settlement.status).toBe(SETTLEMENT_STATUS.PENDING);

    // Process pending
    const processResult = await engine.repositories.settlement!.processPending({ limit: 10 });
    expect(processResult.succeeded).toBe(1);

    // Complete
    const completed = await engine.repositories.settlement!.complete(
      settlement._id.toString(),
      { transferReference: 'bank_ref_123' },
    );
    expect(completed.status).toBe(SETTLEMENT_STATUS.COMPLETED);
  }, TEST_TIMEOUT);

  it('should handle settlement failure with retry', async () => {
    if (!mongoAvailable) return;

    const settlement = await engine.repositories.settlement!.schedule({
      organizationId: 'org_1',
      recipientId: 'vendor_2',
      recipientType: 'user',
      type: 'manual_payout',
      amount: 5000,
      currency: 'USD',
      payoutMethod: 'manual',
    });

    await engine.repositories.settlement!.processPending();

    const failed = await engine.repositories.settlement!.fail(
      settlement._id.toString(),
      'bank timeout',
      { retry: true },
    );
    expect(failed.status).toBe(SETTLEMENT_STATUS.PENDING); // retried
    expect(failed.retryCount).toBe(1);
  }, TEST_TIMEOUT);
});

// ============ REPOSITORY CRUD (inherited from mongokit) ============

describe('Repository CRUD (inherited from mongokit)', () => {
  it('should getAll with pagination', async () => {
    if (!mongoAvailable) return;

    // Create 3 transactions
    for (let i = 0; i < 3; i++) {
      await engine.repositories.transaction.createPaymentIntent({
        amount: 1000 * (i + 1),
        gateway: 'fake',
      });
    }

    const result = await engine.repositories.transaction.getAll({ page: 1, limit: 2 });
    expect((result as any).data).toHaveLength(2);
    expect((result as any).total).toBe(3);
    expect((result as any).pages).toBe(2);
  }, TEST_TIMEOUT);

  it('should getById', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 7777,
      gateway: 'fake',
    });

    const found = await engine.repositories.transaction.getById(txn._id.toString());
    expect(found).toBeDefined();
    expect((found as any).amount).toBe(7777);
  }, TEST_TIMEOUT);

  it('should count documents', async () => {
    if (!mongoAvailable) return;

    await engine.repositories.transaction.createPaymentIntent({ amount: 100, gateway: 'fake' });
    await engine.repositories.transaction.createPaymentIntent({ amount: 200, gateway: 'fake' });

    const count = await engine.repositories.transaction.count({});
    expect(count).toBe(2);
  }, TEST_TIMEOUT);
});

// ============ MANUAL PROVIDER INTEGRATION ============

describe('ManualProvider Integration (@classytic/revenue-manual)', () => {
  let manualEngine: Awaited<ReturnType<typeof createRevenue>>;

  beforeAll(async () => {
    if (!mongoAvailable) return;
    // Dynamic import — revenue-manual is a sibling package
    const { ManualProvider } = await import('../../revenue-manual/src/index.js');

    manualEngine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'BDT',
      providers: { manual: new ManualProvider() as any },
      modules: { subscription: false, escrow: false, settlement: false },
      scope: { enabled: false, fieldType: 'string' },
      forceRecreate: true,
    });
    await warmModels(manualEngine);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (manualEngine) await manualEngine.destroy();
  });

  it('should create manual payment intent with instructions', async () => {
    if (!mongoAvailable) return;

    const txn = await manualEngine.repositories.transaction.createPaymentIntent({
      amount: 50000,
      gateway: 'manual',
      data: { customerId: 'cust_bd_1', sourceId: 'order_99', sourceModel: 'Order' },
      metadata: { paymentInstructions: 'Send bKash to 01700000000' },
    });

    expect(txn).toBeDefined();
    expect(txn.amount).toBe(50000);
    expect(txn.currency).toBe('BDT');
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);
    expect(txn.publicId).toMatch(/^txn_/);
    // Payment instructions stored in gateway.metadata
    expect((txn.gateway as any)?.metadata?.instructions).toContain('bKash');
  }, TEST_TIMEOUT);

  it('should verify manual payment (admin approval)', async () => {
    if (!mongoAvailable) return;

    const txn = await manualEngine.repositories.transaction.createPaymentIntent({
      amount: 25000, gateway: 'manual',
    });

    const verified = await manualEngine.repositories.transaction.verify(
      txn.gateway!.paymentIntentId as string,
      { verifiedBy: 'admin_bd' },
    );

    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect(verified.verifiedBy).toBe('admin_bd');
    expect(verified.verifiedAt).toBeDefined();
  }, TEST_TIMEOUT);

  it('should refund manual payment', async () => {
    if (!mongoAvailable) return;

    const txn = await manualEngine.repositories.transaction.createPaymentIntent({
      amount: 30000, gateway: 'manual',
    });
    await manualEngine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    const refundTxn = await manualEngine.repositories.transaction.refund(
      txn._id.toString(), null, { reason: 'customer cancellation' },
    );

    expect(refundTxn.amount).toBe(30000);
    expect(refundTxn.flow).toBe('outflow');
    expect(refundTxn.type).toBe('refund');
  }, TEST_TIMEOUT);

  it('should handle full payment lifecycle (create -> verify -> partial refund)', async () => {
    if (!mongoAvailable) return;

    // Create
    const txn = await manualEngine.repositories.transaction.createPaymentIntent({
      amount: 100000, gateway: 'manual',
      data: { customerId: 'cust_lifecycle', sourceId: 'order_lifecycle', sourceModel: 'Order' },
    });
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);

    // Verify
    const verified = await manualEngine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);

    // Partial refund — returns the refund doc
    const refundTxn = await manualEngine.repositories.transaction.refund(txn._id.toString(), 40000, { reason: 'partial return' });
    expect(refundTxn.amount).toBe(40000);

    // Check original transaction updated
    const updated = await manualEngine.repositories.transaction.getById(txn._id.toString());
    expect((updated as any).status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
    expect((updated as any).refundedAmount).toBe(40000);
  }, TEST_TIMEOUT);
});
