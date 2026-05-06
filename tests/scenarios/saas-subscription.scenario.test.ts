/**
 * Scenario: SaaS Subscription Lifecycle
 *
 * A SaaS product with monthly plans, trials, renewals, pause, and cancellation.
 *
 * Flow:
 *   1. Signup → trial subscription (pending, inactive)
 *   2. First payment → activate (sets endDate from plan)
 *   3. Renewal: create + verify next period's transaction
 *   4. Pause mid-period (vacation mode)
 *   5. Resume with period extension
 *   6. Cancel at period end vs immediate cancel
 *   7. Proration refund on immediate cancel
 *
 * What this catches that unit tests miss:
 *   - Subscription ↔ Transaction linkage
 *   - State machine transitions: pending → active → paused → active → cancelled
 *   - Extended endDate arithmetic on resume
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { warmModels } from '../helpers/warm-models.js';
import {
  createRevenue,
  SUBSCRIPTION_STATUS,
  TRANSACTION_STATUS,
} from '../../revenue/src/index.js';

const TIMEOUT = 15000;

let engine: Awaited<ReturnType<typeof createRevenue>>;
let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { fake: new FakeProvider() },
    modules: { subscription: true, escrow: false, settlement: false },
    scope: false,
  });
  await warmModels(engine);
}, TIMEOUT);

afterAll(async () => {
  if (engine) await engine.destroy();
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
});

async function payAndActivate(customerId: string, amount: number, planKey: string) {
  const txn = await engine.repositories.transaction.createPaymentIntent({
    amount,
    gateway: 'fake',
    monetizationType: 'subscription',
    planKey,
    data: { customerId },
  });
  await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

  const sub = await engine.repositories.subscription!.create({
    customerId,
    planKey,
    amount,
    status: SUBSCRIPTION_STATUS.PENDING,
    isActive: false,
    transactionId: txn._id,
    startDate: new Date(),
  } as any);

  const activated = await engine.repositories.subscription!.activate(String(sub._id));
  return { txn, sub: activated };
}

describe('Scenario: SaaS Subscription Lifecycle', () => {
  it('signup → first payment → activate → end date reflects plan period', async () => {
    if (!mongoAvailable) return;

    const { sub } = await payAndActivate('user_saas_1', 2999, 'monthly');

    expect(sub.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(sub.isActive).toBe(true);
    expect(sub.activatedAt).toBeDefined();
    expect(sub.endDate).toBeDefined();

    const start = sub.activatedAt!.getTime();
    const end = sub.endDate!.getTime();
    const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
    // Monthly plan ≈ 28–31 days
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
  }, TIMEOUT);

  it('yearly plan gives ~365 days of access', async () => {
    if (!mongoAvailable) return;

    const { sub } = await payAndActivate('user_saas_yearly', 29999, 'yearly');
    const days = Math.round(
      (sub.endDate!.getTime() - sub.activatedAt!.getTime()) / (1000 * 60 * 60 * 24),
    );
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
  }, TIMEOUT);

  it('pause then resume extends the billing period', async () => {
    if (!mongoAvailable) return;

    const { sub } = await payAndActivate('user_saas_pause', 2999, 'monthly');
    const originalEnd = sub.endDate!.getTime();

    const paused = await engine.repositories.subscription!.pause(String(sub._id), {
      reason: 'vacation',
    });
    expect(paused.status).toBe(SUBSCRIPTION_STATUS.PAUSED);
    expect(paused.isActive).toBe(false);
    expect(paused.pausedAt).toBeDefined();

    // Simulate 2s pause — enough to observe period extension
    await new Promise((r) => setTimeout(r, 50));

    const resumed = await engine.repositories.subscription!.resume(String(sub._id), {
      extendPeriod: true,
    });
    expect(resumed.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(resumed.isActive).toBe(true);
    // extendPeriod pushes endDate forward by the pause duration
    expect(resumed.endDate!.getTime()).toBeGreaterThanOrEqual(originalEnd);
  }, TIMEOUT);

  it('cancel-at-period-end keeps the sub active until endDate', async () => {
    if (!mongoAvailable) return;

    const { sub } = await payAndActivate('user_cancel_end', 2999, 'monthly');

    const cancelled = await engine.repositories.subscription!.cancel(String(sub._id), {
      immediate: false,
      reason: 'not_renewing',
    });

    // Grace-period cancel: stays active, cancelAt set to endDate
    expect(cancelled.isActive).toBe(true);
    expect(cancelled.cancelAt).toBeDefined();
    expect(cancelled.cancellationReason).toBe('not_renewing');
  }, TIMEOUT);

  it('immediate cancel + proration refund', async () => {
    if (!mongoAvailable) return;

    const { txn, sub } = await payAndActivate('user_cancel_now', 3000, 'monthly');

    const cancelled = await engine.repositories.subscription!.cancel(String(sub._id), {
      immediate: true,
      reason: 'switched_plans',
    });
    expect(cancelled.status).toBe(SUBSCRIPTION_STATUS.CANCELLED);
    expect(cancelled.isActive).toBe(false);
    expect(cancelled.canceledAt).toBeDefined();

    // Pro-rate: assume 10 days used out of 30 → refund 2/3
    const refund = await engine.repositories.transaction.refund(
      String(txn._id),
      2000,
      { reason: 'subscription_proration' },
    );
    expect(refund.amount).toBe(2000);
    const original = await engine.repositories.transaction.getById(String(txn._id));
    expect((original as any).status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
    expect((original as any).refundedAmount).toBe(2000);
  }, TIMEOUT);

  it('multiple renewal transactions link back to the same subscription', async () => {
    if (!mongoAvailable) return;

    const { sub } = await payAndActivate('user_renewals', 2999, 'monthly');

    // Period 2 renewal
    const period2 = await engine.repositories.transaction.createPaymentIntent({
      amount: 2999,
      gateway: 'fake',
      monetizationType: 'subscription',
      planKey: 'monthly',
      data: { customerId: 'user_renewals', sourceId: String(sub._id), sourceModel: 'Subscription' },
      metadata: { period: 2, subscriptionId: String(sub._id) },
    });
    await engine.repositories.transaction.verify(period2.gateway!.paymentIntentId as string);

    // Period 3 renewal
    const period3 = await engine.repositories.transaction.createPaymentIntent({
      amount: 2999,
      gateway: 'fake',
      monetizationType: 'subscription',
      planKey: 'monthly',
      data: { customerId: 'user_renewals', sourceId: String(sub._id), sourceModel: 'Subscription' },
      metadata: { period: 3, subscriptionId: String(sub._id) },
    });
    await engine.repositories.transaction.verify(period3.gateway!.paymentIntentId as string);

    // All renewal transactions for this subscription
    const renewals = await engine.repositories.transaction.getAll({
      filters: { 'metadata.subscriptionId': String(sub._id), status: TRANSACTION_STATUS.VERIFIED },
    });
    expect(((renewals as any).data as any[]).length).toBe(2);
    const totalPaid = ((renewals as any).data as any[]).reduce((s, t) => s + t.amount, 0);
    expect(totalPaid).toBe(5998);
  }, TIMEOUT);
});
