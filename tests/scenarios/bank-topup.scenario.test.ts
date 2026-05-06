/**
 * Scenario: Bank / Wallet Top-Up
 *
 * A user loads funds into a wallet via a bank gateway.
 *
 * Flow:
 *   1. User initiates top-up (create intent)
 *   2. Bank redirects back → verify
 *   3. Failed top-up (gateway returns 'failed') → transaction lands in FAILED
 *   4. Chargeback / reversal → full refund creates outflow transaction
 *   5. Idempotent retries on the same request key don't double-charge
 *
 * What this catches that unit tests miss:
 *   - State machine correctness across pending → verified → refunded
 *   - Refund atomicity (both writes commit together, §15 session threading)
 *   - Idempotency key collision
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

const TIMEOUT = 15000;

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

describe('Scenario: Bank Wallet Top-Up', () => {
  it('completes a successful top-up: create → verify → balance reflects inflow', async () => {
    if (!mongoAvailable) return;

    const topup = await engine.repositories.transaction.createPaymentIntent({
      amount: 25000,
      gateway: 'fake',
      data: { customerId: 'user_42', sourceId: 'wallet_42', sourceModel: 'Wallet' },
      metadata: { purpose: 'wallet_topup' },
    });

    expect(topup.status).toBe(TRANSACTION_STATUS.PENDING);
    expect(topup.flow).toBe('inflow');
    expect(topup.publicId).toMatch(/^txn_/);

    const verified = await engine.repositories.transaction.verify(
      topup.gateway!.paymentIntentId as string,
      { verifiedBy: 'bank_callback' },
    );

    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect(verified.verifiedAt).toBeDefined();

    // Wallet balance = sum of net inflow on verified topups for this customer
    const topups = await engine.repositories.transaction.getAll({
      filters: { customerId: 'user_42', status: TRANSACTION_STATUS.VERIFIED, flow: 'inflow' },
    });
    const balance = ((topups as any).data as any[]).reduce((sum, t) => sum + (t.net ?? 0), 0);
    expect(balance).toBe(25000);
  }, TIMEOUT);

  it('marks top-up FAILED when gateway verification returns failed', async () => {
    if (!mongoAvailable) return;

    const topup = await engine.repositories.transaction.createPaymentIntent({
      amount: 10000,
      gateway: 'fake',
      data: { customerId: 'user_err' },
    });

    provider.setNextOutcome('failed');
    const verified = await engine.repositories.transaction.verify(
      topup.gateway!.paymentIntentId as string,
    );

    expect(verified.status).toBe(TRANSACTION_STATUS.FAILED);
    expect(verified.failedAt).toBeDefined();
    expect(verified.failureReason).toBeTruthy();
  }, TIMEOUT);

  it('processes a chargeback as a full refund (reversal inflow→outflow pair)', async () => {
    if (!mongoAvailable) return;

    const topup = await engine.repositories.transaction.createPaymentIntent({
      amount: 15000,
      gateway: 'fake',
      data: { customerId: 'user_cb', sourceId: 'wallet_cb', sourceModel: 'Wallet' },
    });
    await engine.repositories.transaction.verify(topup.gateway!.paymentIntentId as string);

    const reversal = await engine.repositories.transaction.refund(
      String(topup._id),
      null,
      { reason: 'bank_chargeback' },
    );

    expect(reversal.flow).toBe('outflow');
    expect(reversal.amount).toBe(15000);
    expect(reversal.type).toBe('refund');
    expect(String(reversal.relatedTransactionId)).toBe(String(topup._id));

    const original = await engine.repositories.transaction.getById(String(topup._id));
    expect((original as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
    expect((original as any).refundedAmount).toBe(15000);

    // Net balance for this customer must be zero after chargeback
    const all = await engine.repositories.transaction.getAll({
      filters: { customerId: 'user_cb' },
    });
    const net = ((all as any).data as any[]).reduce((sum, t) => {
      return sum + (t.flow === 'inflow' ? t.net : -t.net);
    }, 0);
    expect(net).toBe(0);
  }, TIMEOUT);

  it('idempotency key collision returns the same transaction', async () => {
    if (!mongoAvailable) return;

    const key = `topup_req_${Date.now()}`;
    const first = await engine.repositories.transaction.createPaymentIntent({
      amount: 5000, gateway: 'fake', idempotencyKey: key,
    });
    const second = await engine.repositories.transaction.createPaymentIntent({
      amount: 5000, gateway: 'fake', idempotencyKey: key,
    });

    expect(String(first._id)).toBe(String(second._id));
    const count = await engine.repositories.transaction.count({ idempotencyKey: key });
    expect(count).toBe(1);
  }, TIMEOUT);
});
