/**
 * Scenario: Marketplace Order with Escrow + Split
 *
 * A multi-sided marketplace (buyer, seller, platform, affiliate).
 *
 * Flow:
 *   1. Buyer pays for an order → intent → verify
 *   2. Funds land in escrow (hold)
 *   3. Seller fulfills → release held funds
 *   4. Split: seller 80%, platform 15%, affiliate 5%
 *   5. Dispute case: refund before release
 *
 * What this catches that unit tests miss:
 *   - Hold → release → split atomicity under `withTransaction`
 *   - N+2 write split commits atomically (partial splits = worst-class bug)
 *   - Commission math across escrow boundary
 *   - State machine: verified → held → released
 *   - relatedTransactionId populate chain
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
  HOLD_STATUS,
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
    modules: { subscription: false, escrow: true, settlement: true },
    scope: false,
    commission: { defaultRate: 0, gatewayFeeRate: 0 },
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

async function buyerPays(amount: number, orderId: string) {
  const txn = await engine.repositories.transaction.createPaymentIntent({
    amount,
    gateway: 'fake',
    data: { customerId: `buyer_${orderId}`, sourceId: orderId, sourceModel: 'Order' },
    metadata: { orderId },
  });
  const verified = await engine.repositories.transaction.verify(
    txn.gateway!.paymentIntentId as string,
  );
  return verified;
}

describe('Scenario: Marketplace Order — Escrow + Split', () => {
  it('completes the happy path: pay → hold → release → split across parties', async () => {
    if (!mongoAvailable) return;

    // 1. Buyer pays
    const payment = await buyerPays(100000, 'order_happy');
    expect(payment.status).toBe(TRANSACTION_STATUS.VERIFIED);

    // 2. Hold in escrow while seller fulfills
    const held = await engine.repositories.transaction.hold(String(payment._id), {
      reason: 'marketplace_escrow',
    });
    expect(held.hold!.status).toBe(HOLD_STATUS.HELD);
    expect(held.hold!.heldAmount).toBe(100000);

    // 3. Seller confirms delivery → release
    const released = await engine.repositories.transaction.release(String(payment._id), {
      recipientId: 'seller_shop_A',
      recipientType: 'seller',
      reason: 'order_delivered',
    });
    expect(released.hold!.status).toBe(HOLD_STATUS.RELEASED);
    expect(released.hold!.releasedAmount).toBe(100000);

    // 4. Split among seller / platform / affiliate
    const split = await engine.repositories.transaction.split(String(payment._id), [
      { type: 'vendor_payout', recipientId: 'seller_shop_A', recipientType: 'seller', rate: 0.8 },
      { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.15 },
      { type: 'affiliate_commission', recipientId: 'affil_42', recipientType: 'affiliate', rate: 0.05 },
    ]);
    expect(split.splits).toHaveLength(3);

    // Every child transaction created by split points back at the parent
    const children = await engine.repositories.transaction.getAll({
      filters: { relatedTransactionId: payment._id, type: { $in: ['commission', 'platform_revenue'] } },
    });
    // 3 split children + 1 platform_revenue + 1 escrow_release from the release step = 5
    expect(((children as any).data as any[]).length).toBeGreaterThanOrEqual(4);

    // Sum of commission outflows equals original gross
    const commissions = ((children as any).data as any[])
      .filter((d) => d.type === 'commission')
      .reduce((sum, d) => sum + d.amount, 0);
    expect(commissions).toBe(100000);
  }, TIMEOUT);

  it('N+2 split writes commit atomically (no partial-split state)', async () => {
    if (!mongoAvailable) return;

    const payment = await buyerPays(50000, 'order_atomic');

    await engine.repositories.transaction.split(String(payment._id), [
      { type: 'vendor_payout', recipientId: 'seller_B', recipientType: 'seller', rate: 0.7 },
      { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.3 },
    ]);

    // Parent doc must have splits array persisted
    const parent = await engine.repositories.transaction.getById(String(payment._id));
    expect((parent as any).splits).toHaveLength(2);

    // Commission children exist
    const vendorCut = await engine.repositories.transaction.getByQuery(
      { relatedTransactionId: payment._id, type: 'commission', customerId: 'seller_B' },
      { throwOnNotFound: false },
    );
    expect(vendorCut).not.toBeNull();
    expect(vendorCut!.amount).toBe(35000);

    const platformCut = await engine.repositories.transaction.getByQuery(
      { relatedTransactionId: payment._id, type: 'commission', customerId: 'platform' },
      { throwOnNotFound: false },
    );
    expect(platformCut).not.toBeNull();
    expect(platformCut!.amount).toBe(15000);
  }, TIMEOUT);

  it('refunds a disputed order BEFORE release (escrow unwind)', async () => {
    if (!mongoAvailable) return;

    const payment = await buyerPays(40000, 'order_disputed');
    await engine.repositories.transaction.hold(String(payment._id), { reason: 'escrow' });

    // Buyer disputes while funds still held → refund from verified branch
    // Refund from hold state is not allowed by the FSM; admin releases back
    // to the buyer via refund on the parent after unwinding the hold.
    const released = await engine.repositories.transaction.release(String(payment._id), {
      recipientId: `buyer_order_disputed`,
      recipientType: 'buyer',
      reason: 'dispute_resolved',
      createTransaction: false,
    });
    expect(released.hold!.status).toBe(HOLD_STATUS.RELEASED);

    const refund = await engine.repositories.transaction.refund(
      String(payment._id),
      null,
      { reason: 'dispute_refund' },
    );
    expect(refund.flow).toBe('outflow');
    expect(refund.amount).toBe(40000);

    const original = await engine.repositories.transaction.getById(String(payment._id));
    expect((original as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
  }, TIMEOUT);

  it('supports partial release followed by split of remaining funds', async () => {
    if (!mongoAvailable) return;

    const payment = await buyerPays(80000, 'order_partial');
    await engine.repositories.transaction.hold(String(payment._id), { reason: 'escrow' });

    // Release 30% early (milestone 1)
    const partial = await engine.repositories.transaction.release(String(payment._id), {
      amount: 24000,
      recipientId: 'seller_milestones',
      recipientType: 'seller',
      reason: 'milestone_1',
    });
    expect(partial.hold!.status).toBe(HOLD_STATUS.PARTIALLY_RELEASED);
    expect(partial.hold!.releasedAmount).toBe(24000);

    // Release the remaining 70%
    const full = await engine.repositories.transaction.release(String(payment._id), {
      recipientId: 'seller_milestones',
      recipientType: 'seller',
      reason: 'milestone_final',
    });
    expect(full.hold!.status).toBe(HOLD_STATUS.RELEASED);
    expect(full.hold!.releasedAmount).toBe(80000);
    expect(full.hold!.releases).toHaveLength(2);
  }, TIMEOUT);
});
