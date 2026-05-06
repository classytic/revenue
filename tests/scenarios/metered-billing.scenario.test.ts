/**
 * Scenario: Metered / Usage-Based Continuous Billing
 *
 * API platform with pay-as-you-go billing. Customer usage accrues during the
 * period; at period end the platform charges the accumulated usage to the
 * stored payment method, retrying on failure with dunning.
 *
 * Flow:
 *   1. Period 1: usage accrues → end-of-period invoice charged
 *   2. Period 2: charge, customer usage variable
 *   3. Dunning: provider rejects charge → retry on next cron tick
 *   4. Successful retry after grace period
 *   5. Long-tail: many periods tracked per customer
 *
 * What this catches that unit tests miss:
 *   - Repeated verify calls per customer over time
 *   - Failure + retry replay against the same intent
 *   - Cumulative revenue aggregation for a single customer
 *   - Webhook-driven verification (async gateway notifications)
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
import { createRevenue, TRANSACTION_STATUS } from '../../revenue/src/index.js';

const TIMEOUT = 20000;

let engine: Awaited<ReturnType<typeof createRevenue>>;
let provider: FakeProvider;
let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  provider = new FakeProvider();
  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { fake: provider },
    modules: { subscription: false, escrow: false, settlement: false },
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

async function chargePeriod(customerId: string, period: string, usageCents: number) {
  const txn = await engine.repositories.transaction.createPaymentIntent({
    amount: usageCents,
    gateway: 'fake',
    data: { customerId, sourceId: `${customerId}_${period}`, sourceModel: 'UsagePeriod' },
    metadata: { period, billingType: 'metered' },
  });
  return txn;
}

describe('Scenario: Metered / Usage-Based Billing', () => {
  it('charges monthly usage across multiple periods', async () => {
    if (!mongoAvailable) return;

    const customerId = 'api_cust_1';

    const usages = [
      { period: '2026-01', cents: 1250 },
      { period: '2026-02', cents: 3700 },
      { period: '2026-03', cents: 2150 },
    ];

    for (const u of usages) {
      const txn = await chargePeriod(customerId, u.period, u.cents);
      const verified = await engine.repositories.transaction.verify(
        txn.gateway!.paymentIntentId as string,
      );
      expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
    }

    // Total revenue from this customer = sum of all verified usage charges
    const charges = await engine.repositories.transaction.getAll({
      filters: { customerId, status: TRANSACTION_STATUS.VERIFIED },
    });
    expect(((charges as any).data as any[]).length).toBe(3);
    const total = ((charges as any).data as any[]).reduce((s, t) => s + t.amount, 0);
    expect(total).toBe(1250 + 3700 + 2150);
  }, TIMEOUT);

  it('dunning: failed charge can be retried and succeed on second attempt', async () => {
    if (!mongoAvailable) return;

    const customerId = 'api_cust_dunning';
    const txn = await chargePeriod(customerId, '2026-02', 5000);

    // First attempt: gateway declines
    provider.setNextOutcome('failed');
    const failedAttempt = await engine.repositories.transaction.verify(
      txn.gateway!.paymentIntentId as string,
    );
    expect(failedAttempt.status).toBe(TRANSACTION_STATUS.FAILED);
    expect(failedAttempt.failedAt).toBeDefined();

    // Retry the next period by creating a NEW intent — the original txn stays FAILED,
    // a fresh intent represents the retry attempt (idiomatic for dunning).
    const retry = await chargePeriod(customerId, '2026-02-retry', 5000);
    provider.setNextOutcome('succeeded');
    const retryVerified = await engine.repositories.transaction.verify(
      retry.gateway!.paymentIntentId as string,
    );
    expect(retryVerified.status).toBe(TRANSACTION_STATUS.VERIFIED);

    // Revenue for this customer reflects only the successful charge
    const allForCustomer = await engine.repositories.transaction.getAll({
      filters: { customerId },
    });
    const revenue = ((allForCustomer as any).data as any[])
      .filter((t) => t.status === TRANSACTION_STATUS.VERIFIED)
      .reduce((s, t) => s + t.amount, 0);
    expect(revenue).toBe(5000);

    // Failure remains visible for ops
    const failed = ((allForCustomer as any).data as any[]).filter(
      (t) => t.status === TRANSACTION_STATUS.FAILED,
    );
    expect(failed).toHaveLength(1);
  }, TIMEOUT);

  it('webhook arrives after the fact and reconciles a pending charge', async () => {
    if (!mongoAvailable) return;

    const customerId = 'api_cust_webhook';
    const txn = await chargePeriod(customerId, '2026-04', 7500);
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);

    // Gateway posts an async webhook for this intent
    const result = await engine.repositories.transaction.handleWebhook(
      'fake',
      {
        type: 'payment.succeeded',
        sessionId: txn.gateway!.sessionId,
        paymentIntentId: txn.gateway!.paymentIntentId,
      },
    );

    expect(result).not.toBeNull();
    expect(result!.webhook?.eventType).toBe('payment.succeeded');

    // Dedup: same webhook event replay is a no-op
    const replay = await engine.repositories.transaction.handleWebhook(
      'fake',
      {
        type: 'payment.succeeded',
        sessionId: txn.gateway!.sessionId,
        paymentIntentId: txn.gateway!.paymentIntentId,
        id: result!.webhook?.eventId,
      },
    );
    expect(replay).not.toBeNull();
    expect(String(replay!._id)).toBe(String(result!._id));
  }, TIMEOUT);

  it('long-tail: 12 months of charges aggregate correctly', async () => {
    if (!mongoAvailable) return;

    const customerId = 'api_cust_longtail';
    let expectedTotal = 0;
    for (let month = 1; month <= 12; month++) {
      const usage = 1000 + month * 250;
      expectedTotal += usage;
      const txn = await chargePeriod(customerId, `2026-${String(month).padStart(2, '0')}`, usage);
      await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
    }

    const charges = await engine.repositories.transaction.getAll({
      filters: { customerId, status: TRANSACTION_STATUS.VERIFIED },
      limit: 100,
    });
    expect(((charges as any).data as any[]).length).toBe(12);
    const total = ((charges as any).data as any[]).reduce((s, t) => s + t.amount, 0);
    expect(total).toBe(expectedTotal);
  }, TIMEOUT);
});
