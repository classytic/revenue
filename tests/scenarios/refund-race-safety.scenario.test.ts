import type { CurrencyCode } from '@classytic/primitives/currency';
import { currencyCode } from '@classytic/primitives/currency';
import { bindRevenue } from '../helpers/bind-revenue.js';
/**
 * Scenario: Refund race-safety + over-refund guards (Revenue 3.0 audit fixes)
 *
 * Regression coverage for the four refund/webhook/import correctness bugs
 * fixed in the 3.0 audit. Each `it` FAILS on the pre-fix source and PASSES
 * after:
 *
 *   1. CRITICAL — double-refund race. Two concurrent `refund()` calls used to
 *      both pass an in-memory `validate()` and then both call
 *      `provider.refund()`, reversing the gateway TWICE. The claim-before-call
 *      CAS now selects a single winner; the gateway is reversed exactly once.
 *   2. HIGH — cumulative over-refund. Refunding past the captured amount (or a
 *      non-positive amount) is rejected.
 *   3. HIGH — second partial refund. `partially_refunded → partially_refunded`
 *      is a legal self-edge; a 2nd partial no longer throws.
 *   4. Atomic cap under concurrency — two concurrent partials that individually
 *      fit but together overflow: exactly the ones that fit land, the running
 *      total never exceeds the captured amount, gateway reversed once per
 *      lander.
 *   5. MED — webhook signature. `handleWebhook` enforces
 *      `provider.verifyWebhookSignature` before mutating anything.
 *   6. MED — import tenant guard. Scoped engine refuses an unscoped
 *      `import()` when `ctx.organizationId` is missing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  clearCollections,
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';
import {
  PaymentProvider,
  TRANSACTION_STATUS,
  ValidationError,
  WebhookSignatureError,
  BankFeedImportError,
  RefundOutcomeUnknownError,
} from '../../revenue/src/index.js';
import type {
  CreateIntentParams,
  PaymentCommandContext,
  ProviderIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';
import type { BankTransaction } from '@classytic/primitives/bank-transaction';

const TIMEOUT = 30000;

/**
 * Provider that COUNTS gateway reversals so a test can assert "reversed
 * exactly once". `refund()` adds a small async delay so two concurrent
 * refunds are genuinely in-flight together — widening the window the old
 * validate-then-call code left open. `failRefund` forces the gateway call to
 * throw so the claim-rollback path can be exercised.
 */
class CountingProvider extends PaymentProvider {
  public override readonly name: string = 'fake';
  /**
   * The PERMISSIVE case, stated explicitly — `StrictSigProvider` below is the
   * rejecting one, and this scenario asserts both. `verifyWebhookSignature` is
   * abstract so each says which it is, rather than one inheriting accept-all.
   */
  verifyWebhookSignature(): boolean {
    return true;
  }
  public refundCalls: Array<{ paymentId: string; amount?: number | null; idempotencyKey?: string }> = [];
  /** Generic throw → the classifier maps it to `unknown` (outcome never observed). */
  public failRefund = false;
  /** Throw a DECISION-bearing error → the classifier maps it to `declined`. */
  public declineRefund = false;
  private store = new Map<string, { amount: number; currency: CurrencyCode }>();

  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<ProviderIntent> {
    const id = `fake_pi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? 'USD';
    this.store.set(id, { amount, currency });
    return {
      id, sessionId: id, paymentIntentId: id,
      provider: 'fake', status: 'requires_payment_method',
      amount: { amount, currency }, metadata: {},
    };
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const r = this.store.get(intentId);
    return {
      id: intentId, provider: 'fake',
      status: r ? 'succeeded' : 'failed',
      amount: r ? { amount: r.amount, currency: r.currency } : undefined,
      paidAt: r ? new Date() : undefined, metadata: {},
    };
  }

  async getStatus(intentId: string): Promise<PaymentResult> { return this.verifyPayment(intentId); }

  async refund(
    paymentId: string,
    amount: number | null | undefined,
    command: PaymentCommandContext,
    _options?: { reason?: string },
  ): Promise<RefundResult> {
    // Yield so concurrent callers overlap before the first records its call.
    await new Promise((r) => setTimeout(r, 15));
    this.refundCalls.push({ paymentId, amount, idempotencyKey: command?.idempotencyKey });
    // A DECISION by the gateway: the classifier reads the attached `decline` and
    // maps this to `declined` (no money moved → claim released, retry allowed).
    if (this.declineRefund) {
      throw Object.assign(new Error('card refund declined by issuer'), {
        decline: { reason: 'issuer_declined', retryable: true },
      });
    }
    // A bare throw carries no outcome signal → the classifier maps it to `unknown`
    // (the reversal MAY have processed) → claim retained, no double refund.
    if (this.failRefund) throw new Error('gateway refund failed');
    return {
      id: `ref_${paymentId}_${Date.now()}`, provider: 'fake',
      status: 'succeeded', amount: { amount: amount ?? 0, currency: currencyCode('USD') },
      refundedAt: new Date(), metadata: {},
    };
  }

  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const p = payload as { type?: string; sessionId?: string } | null;
    return {
      id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      provider: 'fake', type: p?.type ?? 'payment.succeeded',
      data: (p as Record<string, unknown>) ?? {}, createdAt: new Date(),
    };
  }

  override getCapabilities() {
    return { supportsWebhooks: true, supportsRefunds: true, supportsPartialRefunds: true, requiresManualVerification: false };
  }
}

/** Provider whose signature check ALWAYS rejects — the opt-in enforcement case. */
class StrictSigProvider extends CountingProvider {
  public override readonly name: string = 'strict';
  override verifyWebhookSignature(): boolean { return false; }
}

let engine: Awaited<ReturnType<typeof bindRevenue>>;
let mongoAvailable = false;
let provider: CountingProvider;

let txnSeq = 0;
async function verifiedTxn(amount: number) {
  const txn = await engine.repositories.transaction.createPaymentIntent({
    amount, gateway: 'fake', methodKind: 'card',
    idempotencyKey: `rrs-pay-${++txnSeq}`,
  });
  await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
  return txn;
}

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  provider = new CountingProvider();
  engine = await bindRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { fake: provider, strict: new StrictSigProvider() },
    modules: { subscription: false, escrow: false, settlement: false },
    scope: { enabled: false, fieldType: 'string' },
    commission: { defaultRate: 0, gatewayFeeRate: 0 },
    forceRecreate: true,
  });
  await warmModels(engine);
}, TIMEOUT);

afterAll(async () => {
  if (engine) await engine.close();
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) {
    await clearCollections();
    provider.refundCalls = [];
    provider.failRefund = false;
    provider.declineRefund = false;
  }
});

describe('Refund race-safety + over-refund guards', () => {
  it('CRITICAL: two concurrent full refunds reverse the gateway exactly ONCE', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(10000);

    // Fire both refunds together. Pre-fix: both validate in memory and both
    // call provider.refund() → TWO reversals. Post-fix: the claim CAS elects
    // one winner; the loser is remapped to a ValidationError.
    const results = await Promise.allSettled([
      engine.repositories.transaction.refund(txn._id.toString(), 10000, { reason: 'r1', idempotencyKey: 'rrs-crit-r1' }),
      engine.repositories.transaction.refund(txn._id.toString(), 10000, { reason: 'r2', idempotencyKey: 'rrs-crit-r2' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);

    // The gateway was reversed exactly once — the whole point of the fix.
    expect(provider.refundCalls).toHaveLength(1);

    // Original settled to REFUNDED with the full amount recorded once.
    const original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
    expect((original as any).refundedAmount).toBe(10000);

    // Exactly one refund child persisted.
    const refunds = await engine.repositories.transaction.getAll({ filters: { type: 'refund' } }, {});
    expect(((refunds as any).data ?? refunds)).toHaveLength(1);
  }, TIMEOUT);

  it('CRITICAL: concurrent same-key refunds never double-reverse', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(8000);
    const key = 'refund-op-concurrent';

    const results = await Promise.allSettled([
      engine.repositories.transaction.refund(txn._id.toString(), 8000, { idempotencyKey: key }),
      engine.repositories.transaction.refund(txn._id.toString(), 8000, { idempotencyKey: key }),
    ]);

    // At least one succeeded; the gateway was reversed at most once (never twice).
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(provider.refundCalls.length).toBe(1);

    const refunds = await engine.repositories.transaction.getAll({ filters: { idempotencyKey: key, type: 'refund' } }, {});
    expect(((refunds as any).data ?? refunds)).toHaveLength(1);
  }, TIMEOUT);

  it('HIGH: refund exceeding the captured amount is rejected (no gateway call)', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(10000);

    // First partial takes it to 6000/10000.
    await engine.repositories.transaction.refund(txn._id.toString(), 6000, { reason: 'partial', idempotencyKey: 'rrs-over-1' });
    provider.refundCalls = [];

    // 5000 more would be 11000 > 10000 → rejected before touching the gateway.
    await expect(
      engine.repositories.transaction.refund(txn._id.toString(), 5000, { idempotencyKey: 'rrs-over-2' }),
    ).rejects.toThrow(/exceeds captured amount/i);
    expect(provider.refundCalls).toHaveLength(0);

    const original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).refundedAmount).toBe(6000);
    expect((original as any).status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
  }, TIMEOUT);

  it('HIGH: non-positive refund amount is rejected', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(5000);
    await expect(engine.repositories.transaction.refund(txn._id.toString(), 0, { idempotencyKey: 'rrs-nonpos-1' })).rejects.toThrow(/must be positive/i);
    await expect(engine.repositories.transaction.refund(txn._id.toString(), -100, { idempotencyKey: 'rrs-nonpos-2' })).rejects.toThrow(/must be positive/i);
    expect(provider.refundCalls).toHaveLength(0);
  }, TIMEOUT);

  it('HIGH: a SECOND partial refund is allowed (self-edge), then closes to REFUNDED', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(10000);

    const r1 = await engine.repositories.transaction.refund(txn._id.toString(), 3000, { idempotencyKey: 'rrs-sp-1' });
    expect(r1.amount).toBe(3000);
    let original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);

    // Second partial — the pre-fix state machine (no self-edge) threw here.
    const r2 = await engine.repositories.transaction.refund(txn._id.toString(), 3000, { idempotencyKey: 'rrs-sp-2' });
    expect(r2.amount).toBe(3000);
    original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);
    expect((original as any).refundedAmount).toBe(6000);

    // Final refund tips the running total to the captured amount → REFUNDED.
    await engine.repositories.transaction.refund(txn._id.toString(), 4000, { idempotencyKey: 'rrs-sp-3' });
    original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
    expect((original as any).refundedAmount).toBe(10000);
    expect(provider.refundCalls).toHaveLength(3);
  }, TIMEOUT);

  it('HIGH: concurrent partials respect the cumulative cap atomically', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(10000);

    // Seed one partial so the row is in the `partially_refunded` self-loop
    // (where the status CAS alone does NOT serialize — the atomic `where`
    // guard on refundedAmount is what enforces the cap).
    await engine.repositories.transaction.refund(txn._id.toString(), 4000, { idempotencyKey: 'rrs-cap-seed' });
    provider.refundCalls = [];

    // Two concurrent 4000 partials: 4000 each fits the 6000 remaining
    // individually, but 8000 together would overflow. Exactly one lands.
    // DISTINCT keys — two separate refund attempts racing, not an idempotent replay.
    const results = await Promise.allSettled([
      engine.repositories.transaction.refund(txn._id.toString(), 4000, { idempotencyKey: 'rrs-cap-a' }),
      engine.repositories.transaction.refund(txn._id.toString(), 4000, { idempotencyKey: 'rrs-cap-b' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(provider.refundCalls).toHaveLength(1);

    const original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).refundedAmount).toBe(8000);
    expect((original as any).refundedAmount).toBeLessThanOrEqual(10000);
  }, TIMEOUT);

  it('an UNKNOWN gateway reversal HOLDS the reservation (no double-refund), unknown on the attempt, original NOT flipped', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(9000);
    provider.failRefund = true; // bare throw → classified `unknown` (outcome never observed)

    // Capture what the kernel publishes for this refund attempt.
    const published: Array<{ type: string; payload: unknown }> = [];
    const unsubscribe = await engine.events.subscribe('payment.*', (e: { type: string; payload: unknown }) => {
      published.push({ type: e.type, payload: e.payload });
    });

    await expect(
      engine.repositories.transaction.refund(txn._id.toString(), 9000, { idempotencyKey: 'rrs-unknown-1' }),
    ).rejects.toThrow(RefundOutcomeUnknownError);

    // Phase 3: the amount is RESERVED (pendingRefundAmount), not committed. The
    // original is NOT flipped to refunded — no refund child, no settlement claimed —
    // and the unknown state lives on the durable refund PaymentAttempt, which is the
    // reconciliation anchor. The reservation is what prevents a double refund.
    const original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect((original as any).refundedAmount ?? 0).toBe(0);

    /**
     * And it ANNOUNCES itself.
     *
     * The reservation above is the safety mechanism; the event is the signal.
     * Without it the state is correct and INVISIBLE — amount locked, no refund
     * child, and nothing downstream knowing a reconciliation is owed.
     *
     * The second assertion is the one that matters: `payment.failed` must NOT
     * accompany it. Reporting failure licenses a retry, and if the gateway did
     * process the reversal that retry is a second refund.
     */
    unsubscribe();

    const emitted = published.map((e) => e.type);
    expect(emitted).toContain('payment.unknown');
    expect(emitted).not.toContain('payment.failed');
    expect(emitted).not.toContain('payment.refunded');

    const unknownEvent = published.find((e) => e.type === 'payment.unknown');
    const unknownPayload = unknownEvent?.payload as {
      operation?: string;
      causeCode?: string;
      idempotencyKey?: string;
    };
    expect(unknownPayload?.operation).toBe('refund');
    // What reconciliation asks the provider with.
    expect(unknownPayload?.idempotencyKey).toBe('rrs-unknown-1');
    expect(unknownPayload?.causeCode).toBeTruthy();
    expect((original as any).pendingRefundAmount).toBe(9000);

    const refundAttempts = await mongoose.connection.db!
      .collection('revenue_payment_attempts')
      .find({ operation: 'refund' })
      .toArray();
    expect(refundAttempts).toHaveLength(1);
    expect(refundAttempts[0]!.outcome).toBe('unknown');

    // A retry must NOT double-refund: the reservation counts toward the cap, so a
    // fresh attempt is rejected as over-refund. Resolution is reconciliation, not retry.
    provider.failRefund = false;
    await expect(
      engine.repositories.transaction.refund(txn._id.toString(), 9000, { idempotencyKey: 'rrs-unknown-2' }),
    ).rejects.toThrow(/exceeds captured amount/i);
    expect(provider.refundCalls).toHaveLength(1); // only the first (unknown) attempt reached the gateway
  }, TIMEOUT);

  it('a DECLINED gateway reversal RELEASES the claim (retry allowed)', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedTxn(9000);
    provider.declineRefund = true; // provider declares a DECISION → classified `declined`

    await expect(
      engine.repositories.transaction.refund(txn._id.toString(), 9000, { idempotencyKey: 'rrs-decline-1' }),
    ).rejects.toBeInstanceOf(ValidationError);

    // A decision means no money moved → the claim is released so the caller can retry
    // (with different parameters, or once the issue is resolved).
    const original = await engine.repositories.transaction.getById(txn._id.toString());
    expect((original as any).status).toBe(TRANSACTION_STATUS.VERIFIED);
    expect((original as any).refundedAmount ?? 0).toBe(0);

    provider.declineRefund = false;
    const retry = await engine.repositories.transaction.refund(txn._id.toString(), 9000, { idempotencyKey: 'rrs-decline-2' });
    expect(retry.amount).toBe(9000);
    const settled = await engine.repositories.transaction.getById(txn._id.toString());
    expect((settled as any).status).toBe(TRANSACTION_STATUS.REFUNDED);
  }, TIMEOUT);

  it('MED: handleWebhook rejects an invalid signature before mutating anything', async () => {
    if (!mongoAvailable) return;

    // Provider under 'strict' rejects every signature (opt-in enforcement).
    await expect(
      engine.repositories.transaction.handleWebhook('strict', { type: 'x' }, { 'stripe-signature': 'bad' }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);

    // The accept-all default provider ('fake') still processes normally
    // (returns null when no matching transaction — no signature rejection).
    const res = await engine.repositories.transaction.handleWebhook('fake', { type: 'x', sessionId: 'nope' });
    expect(res).toBeNull();
  }, TIMEOUT);
});

// ── Fix #5: import tenant guard needs a separately-scoped engine ──
describe('Bank-feed import tenant guard (scoped engine)', () => {
  let scopedEngine: Awaited<ReturnType<typeof bindRevenue>>;

  function row(externalId: string): BankTransaction {
    return {
      externalId,
      postedDate: new Date('2026-05-01T00:00:00Z'),
      amount: { amount: 10000, currency: currencyCode('USD') },
      description: 'ACH CREDIT',
    } as BankTransaction;
  }

  beforeAll(async () => {
    if (!mongoAvailable) return;
    scopedEngine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: {},
      modules: {
        subscription: false, escrow: false, settlement: false,
        // Keep bank-feed ON (import() needs its batch plugin) but declare NO
        // indexes — this engine shares the 'Transaction' collection with the
        // unscoped engine above, and re-declaring `bank_feed_by_account` with
        // an org-prefixed key but the same name collides at index build.
        bankFeed: { enabled: true, indexes: { idempotentImport: false, byAccount: false, matchCandidates: false } },
      },
      scope: { enabled: true, fieldType: 'string', required: true },
      forceRecreate: true,
    });
    await warmModels(scopedEngine);
  }, TIMEOUT);

  afterAll(async () => {
    if (scopedEngine) await scopedEngine.close();
  });

  it('MED: refuses an unscoped import when organizationId is missing', async () => {
    if (!mongoAvailable) return;
    await expect(
      scopedEngine.repositories.transaction.import([row('FIT_NOORG')], {
        bankAccountId: 'acct_1', source: 'plaid', methodKind: 'bank_transfer',
      }),
    ).rejects.toBeInstanceOf(BankFeedImportError);
  }, TIMEOUT);

  it('MED: succeeds when organizationId IS present', async () => {
    if (!mongoAvailable) return;
    const report = await scopedEngine.repositories.transaction.import(
      [row('FIT_ORG_OK')],
      { bankAccountId: 'acct_1', source: 'plaid', methodKind: 'bank_transfer' },
      { organizationId: 'branch_dhaka' },
    );
    expect(report.inserted).toBe(1);
  }, TIMEOUT);
});
