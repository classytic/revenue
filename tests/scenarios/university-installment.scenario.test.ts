/**
 * Scenario: University Semester Fee — Installment Plan
 *
 * A university charges a large semester fee that students pay in 4 installments.
 * Some students get scholarship waivers, some withdraw mid-semester and need
 * pro-rated refunds.
 *
 * Flow:
 *   1. Semester fee plan: 4 x $3000 installments
 *   2. Student pays installments one-by-one
 *   3. Late payment on installment 3
 *   4. Scholarship waiver applied to installment 4 (free transaction)
 *   5. Mid-semester withdrawal → refund all paid installments
 *
 * What this catches that unit tests miss:
 *   - Aggregate balance calculations across many linked transactions
 *   - Zero-amount (waiver) transactions going straight to VERIFIED
 *   - Bulk-refund sequence correctness (each is an independent write)
 *   - sourceId linkage (Enrollment) across many payments
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
let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { fake: new FakeProvider() },
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

async function payInstallment(
  studentId: string,
  enrollmentId: string,
  installmentNo: number,
  amount: number,
) {
  const txn = await engine.repositories.transaction.createPaymentIntent({
    amount,
    gateway: 'fake',
    data: { customerId: studentId, sourceId: enrollmentId, sourceModel: 'Enrollment' },
    metadata: { installmentNo, enrollmentId },
  });
  return engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
}

describe('Scenario: University Semester Fee — Installment Plan', () => {
  it('student pays 4 installments — balance correctly tracked across payments', async () => {
    if (!mongoAvailable) return;

    const studentId = 'student_alice';
    const enrollmentId = 'enroll_spring_2026';
    const perInstallment = 3000;

    for (let i = 1; i <= 4; i++) {
      const paid = await payInstallment(studentId, enrollmentId, i, perInstallment);
      expect(paid.status).toBe(TRANSACTION_STATUS.VERIFIED);
    }

    const paid = await engine.repositories.transaction.getAll({
      filters: {
        customerId: studentId,
        sourceId: enrollmentId,
        status: TRANSACTION_STATUS.VERIFIED,
      },
    });
    expect(((paid as any).docs as any[]).length).toBe(4);

    const total = ((paid as any).docs as any[]).reduce((s, t) => s + t.amount, 0);
    expect(total).toBe(12000);
  }, TIMEOUT);

  it('late payment: installment 3 pending initially, verified after grace period', async () => {
    if (!mongoAvailable) return;

    const studentId = 'student_bob';
    const enrollmentId = 'enroll_late';

    await payInstallment(studentId, enrollmentId, 1, 3000);
    await payInstallment(studentId, enrollmentId, 2, 3000);

    // Installment 3: pending (student hasn't paid yet)
    const late = await engine.repositories.transaction.createPaymentIntent({
      amount: 3000,
      gateway: 'fake',
      data: { customerId: studentId, sourceId: enrollmentId, sourceModel: 'Enrollment' },
      metadata: { installmentNo: 3, late: true, lateFee: 100 },
    });
    expect(late.status).toBe(TRANSACTION_STATUS.PENDING);

    // Grace period expires — student finally pays
    const verified = await engine.repositories.transaction.verify(
      late.gateway!.paymentIntentId as string,
    );
    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect((verified.metadata as any).late).toBe(true);
  }, TIMEOUT);

  it('scholarship waiver creates a zero-amount verified transaction (no provider call)', async () => {
    if (!mongoAvailable) return;

    const studentId = 'student_scholar';
    const enrollmentId = 'enroll_scholar';

    await payInstallment(studentId, enrollmentId, 1, 3000);
    await payInstallment(studentId, enrollmentId, 2, 3000);
    await payInstallment(studentId, enrollmentId, 3, 3000);

    // Installment 4 is fully waived by scholarship
    const waiver = await engine.repositories.transaction.createPaymentIntent({
      amount: 0,
      gateway: 'fake',
      monetizationType: 'free',
      data: { customerId: studentId, sourceId: enrollmentId, sourceModel: 'Enrollment' },
      metadata: { installmentNo: 4, waiverReason: 'merit_scholarship' },
    });

    // Zero amount → goes straight to VERIFIED, no provider intent
    expect(waiver.status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect(waiver.amount).toBe(0);
    expect(waiver.gateway?.paymentIntentId).toBeUndefined();

    // Total paid = 9000 even though enrollment covered 4 installments
    const all = await engine.repositories.transaction.getAll({
      filters: { customerId: studentId, sourceId: enrollmentId },
    });
    expect(((all as any).docs as any[]).length).toBe(4);
    const actuallyPaid = ((all as any).docs as any[])
      .filter((t) => t.amount > 0)
      .reduce((s, t) => s + t.amount, 0);
    expect(actuallyPaid).toBe(9000);
  }, TIMEOUT);

  it('withdrawal mid-semester: refund all paid installments', async () => {
    if (!mongoAvailable) return;

    const studentId = 'student_withdraw';
    const enrollmentId = 'enroll_withdraw';

    const inst1 = await payInstallment(studentId, enrollmentId, 1, 3000);
    const inst2 = await payInstallment(studentId, enrollmentId, 2, 3000);

    // Withdrawal: refund each paid installment
    const r1 = await engine.repositories.transaction.refund(
      String(inst1._id),
      null,
      { reason: 'student_withdrawal' },
    );
    const r2 = await engine.repositories.transaction.refund(
      String(inst2._id),
      null,
      { reason: 'student_withdrawal' },
    );

    expect(r1.flow).toBe('outflow');
    expect(r2.flow).toBe('outflow');

    // Net balance for student must be zero after withdrawal
    const all = await engine.repositories.transaction.getAll({
      filters: { customerId: studentId },
    });
    const net = ((all as any).docs as any[]).reduce(
      (s, t) => s + (t.flow === 'inflow' ? t.amount : -t.amount),
      0,
    );
    expect(net).toBe(0);

    // Original installments marked REFUNDED
    const original1 = await engine.repositories.transaction.getById(String(inst1._id));
    const original2 = await engine.repositories.transaction.getById(String(inst2._id));
    expect((original1 as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
    expect((original2 as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
  }, TIMEOUT);

  it('partial withdrawal refund: student refunded 50% retention fee', async () => {
    if (!mongoAvailable) return;

    const studentId = 'student_partial';
    const enrollmentId = 'enroll_partial';

    const inst1 = await payInstallment(studentId, enrollmentId, 1, 3000);

    // University retains 50% as admin fee on late withdrawal
    const refund = await engine.repositories.transaction.refund(
      String(inst1._id),
      1500,
      { reason: 'late_withdrawal_50pct_retention' },
    );
    expect(refund.amount).toBe(1500);

    const original = await engine.repositories.transaction.getById(String(inst1._id));
    expect((original as any).status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
    expect((original as any).refundedAmount).toBe(1500);
  }, TIMEOUT);
});
