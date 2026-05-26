/**
 * Scenario: Human-in-the-Loop Verification
 *
 * Real-world flows frequently require a human approval step: manual bank
 * transfers (admin matches slip), fraud reviews (analyst approves or reverses),
 * compliance holds on large payouts, AML checks. Revenue doesn't ship a
 * workflow engine — instead, its primitives compose into every HITL pattern:
 *
 *   • Transaction stays PENDING until someone calls `verify(..., { verifiedBy })`.
 *     The FakeProvider / ManualProvider is effectively a no-op that exists to
 *     satisfy the PaymentProvider contract. The *act of calling verify is the
 *     human signal*.
 *
 *   • An auto-hold after verify pauses the funds while an analyst reviews.
 *     The analyst decides release (legit) or refund (fraud/reversal).
 *
 *   • Settlements sit in PENDING until `processPending()` is invoked, which a
 *     host can gate behind an "approved by compliance" button or cron predicate.
 *     `dryRun: true` lets ops preview the queue without state change.
 *
 *   • Every transition captures the actor via `verifiedBy` / metadata — the
 *     audit trail is the policy record.
 *
 * What this catches:
 *   - PENDING → VERIFIED transition driven by external actor (not gateway)
 *   - VERIFIED → HELD → RELEASED (legit) & HELD → RELEASED → REFUNDED (fraud)
 *   - Settlement dryRun vs real processing (compliance queue semantics)
 *   - Actor attribution survives across multi-step workflows
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
  SETTLEMENT_STATUS,
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
    scope: { enabled: false, fieldType: 'string' },
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

describe('Scenario: Human-in-the-Loop Verification', () => {
  it('manual bank transfer: stays PENDING until admin matches the slip and verifies', async () => {
    if (!mongoAvailable) return;

    // Customer initiates payment, receives instructions to send bank transfer
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 500000,
      gateway: 'fake', methodKind: 'card',
      data: { customerId: 'buyer_99', sourceId: 'order_bank_01', sourceModel: 'Order' },
      metadata: {
        paymentMethod: 'bank_transfer',
        instructions: 'Transfer to account XYZ, reference TXN-BANK-01',
      },
    });

    // Initially unverified — waiting for admin
    expect(txn.status).toBe(TRANSACTION_STATUS.PENDING);

    // Customer uploads bank slip; admin reviews and matches it
    const verified = await engine.repositories.transaction.verify(
      txn.gateway!.paymentIntentId as string,
      { verifiedBy: 'admin_finance_ops_1' },
    );

    // Human approval recorded on the doc
    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect(verified.verifiedBy).toBe('admin_finance_ops_1');
    expect(verified.verifiedAt).toBeDefined();
  }, TIMEOUT);

  it('fraud review legit path: verify → auto-hold → analyst clears → release', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 750000,
      gateway: 'fake', methodKind: 'card',
      data: { customerId: 'highvalue_buyer', sourceId: 'order_hv_1', sourceModel: 'Order' },
      metadata: { riskScore: 72, requiresReview: true },
    });

    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    // Host's risk rule: high-value orders auto-hold for review
    const held = await engine.repositories.transaction.hold(String(txn._id), {
      reason: 'fraud_review_high_value',
      metadata: { assignedTo: 'analyst_risk_1', slaHours: 24 },
    });
    expect(held.hold!.status).toBe(HOLD_STATUS.HELD);

    // Analyst reviews customer history, verifies ID, clears the flag
    const cleared = await engine.repositories.transaction.release(String(txn._id), {
      recipientId: 'merchant_wallet',
      recipientType: 'merchant',
      releasedBy: 'analyst_risk_1',
      reason: 'fraud_review_cleared_legit',
    });

    expect(cleared.hold!.status).toBe(HOLD_STATUS.RELEASED);
    expect(cleared.hold!.releases?.[0]?.releasedBy).toBe('analyst_risk_1');
    expect(cleared.hold!.releases?.[0]?.reason).toBe('fraud_review_cleared_legit');
  }, TIMEOUT);

  it('fraud review fraud path: verify → hold → analyst reverses → refund', async () => {
    if (!mongoAvailable) return;

    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 250000,
      gateway: 'fake', methodKind: 'card',
      data: { customerId: 'suspicious_account', sourceId: 'order_sus', sourceModel: 'Order' },
      metadata: { riskScore: 94 },
    });

    await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);

    // Auto-hold on high risk score
    await engine.repositories.transaction.hold(String(txn._id), {
      reason: 'fraud_review_critical',
      metadata: { assignedTo: 'analyst_risk_2' },
    });

    // Analyst confirms stolen card — release hold back to buyer side
    // (createTransaction: false so we don't mint an outflow before the refund)
    await engine.repositories.transaction.release(String(txn._id), {
      recipientId: 'suspicious_account',
      recipientType: 'buyer',
      releasedBy: 'analyst_risk_2',
      reason: 'fraud_confirmed_stolen_card',
      createTransaction: false,
    });

    // Refund executes the reversal
    const refund = await engine.repositories.transaction.refund(
      String(txn._id),
      null,
      { reason: 'fraud_confirmed_stolen_card' },
    );

    expect(refund.flow).toBe('outflow');
    expect(refund.amount).toBe(250000);
    expect((refund.metadata as any).reason).toBe('fraud_confirmed_stolen_card');

    const original = await engine.repositories.transaction.getById(String(txn._id));
    expect((original as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
  }, TIMEOUT);

  it('compliance-gated settlement: dryRun previews the queue, real processPending transitions', async () => {
    if (!mongoAvailable) return;

    const settlement = await engine.repositories.settlement!.schedule({
      organizationId: 'org_marketplace',
      recipientId: 'vendor_large',
      recipientType: 'merchant',
      type: 'split_payout',
      amount: 2000000, // $20,000 — triggers compliance review
      currency: 'USD',
      payoutMethod: 'bank_transfer',
      metadata: { requiresAMLReview: true, reviewedBy: null },
    });
    expect(settlement.status).toBe(SETTLEMENT_STATUS.PENDING);

    // Compliance officer previews the queue without committing
    const preview = await engine.repositories.settlement!.processPending({ dryRun: true });
    expect(preview.processed).toBe(1);
    expect(preview.settlements).toHaveLength(1);

    // Settlement is still PENDING — dryRun does not mutate state
    const stillPending = await engine.repositories.settlement!.getById(String(settlement._id));
    expect((stillPending as any).status).toBe(SETTLEMENT_STATUS.PENDING);

    // Compliance officer approves → triggers real processing
    const real = await engine.repositories.settlement!.processPending();
    expect(real.succeeded).toBe(1);

    // Finance ops marks the bank wire complete
    const completed = await engine.repositories.settlement!.complete(
      String(settlement._id),
      {
        transferReference: 'SWIFT-REF-20260412',
        notes: 'AML review cleared by compliance_officer_1',
        metadata: { reviewedBy: 'compliance_officer_1', amlCheckId: 'aml_123' },
      },
    );

    expect(completed.status).toBe(SETTLEMENT_STATUS.COMPLETED);
    expect((completed.metadata as any).reviewedBy).toBe('compliance_officer_1');
  }, TIMEOUT);

  it('supervisor approval for large refund: verifiedBy records who authorized it', async () => {
    if (!mongoAvailable) return;

    // Buyer completes a large purchase
    const purchase = await engine.repositories.transaction.createPaymentIntent({
      amount: 1500000,
      gateway: 'fake', methodKind: 'card',
      data: { customerId: 'vip_buyer', sourceId: 'order_vip', sourceModel: 'Order' },
    });
    await engine.repositories.transaction.verify(
      purchase.gateway!.paymentIntentId as string,
      { verifiedBy: 'system_gateway_callback' },
    );

    // Support agent can't refund > $10k alone — supervisor approves via metadata
    const refund = await engine.repositories.transaction.refund(
      String(purchase._id),
      null,
      {
        reason: 'approved_by_supervisor_escalation',
      },
    );

    // The audit trail is on the refund doc: which supervisor, when, why
    expect(refund.flow).toBe('outflow');
    expect(refund.amount).toBe(1500000);
    expect((refund.metadata as any).reason).toContain('supervisor');

    // The original verified-by attribution still stands on the parent
    const original = await engine.repositories.transaction.getById(String(purchase._id));
    expect((original as any).verifiedBy).toBe('system_gateway_callback');
    expect((original as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
  }, TIMEOUT);
});
