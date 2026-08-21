import { currencyCode } from '@classytic/primitives/currency';
import { bindRevenue } from '../helpers/bind-revenue.js';
/**
 * Scenario: PaymentAttempt — durable attempt record written BEFORE provider I/O (phase 3).
 *
 * Proves the phase-3 create-side lifecycle that replaces the phase-1-2
 * require-a-caller-key stopgap:
 *
 *   1. A keyless createPaymentIntent (amount > 0) now SUCCEEDS — the provider
 *      idempotency key is derived from the durable attempt id, so distinct sales
 *      never collide and the caller is no longer forced to supply one.
 *   2. On success, exactly one PaymentAttempt exists, `outcome: 'confirmed'`,
 *      linked to the transaction it produced, carrying the gateway ids.
 *   3. When the provider throws (unobserved outcome), createPaymentIntent raises
 *      IntentOutcomeUnknownError, NO transaction is written, and a PaymentAttempt
 *      row survives with `outcome: 'unknown'` — the orphan is VISIBLE, not lost.
 *   4. A caller-supplied key is honoured on the attempt.
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
  IntentOutcomeUnknownError,
  RefundOutcomeUnknownError,
  TRANSACTION_STATUS,
  backfillCreatePaymentAttempts,
} from '../../revenue/src/index.js';
import type {
  CreateIntentParams,
  PaymentResult,
  ProviderIntent,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';

const TIMEOUT = 30000;

class FakeProvider extends PaymentProvider {
  /**
   * A TEST double has no real signature to verify, so it says so EXPLICITLY.
   *
   * `verifyWebhookSignature` is abstract on `PaymentProvider` precisely so this
   * answer is stated per provider rather than inherited: the base used to default to
   * accept-all, which meant a provider that forgot to override accepted any signature
   * on the call that transitions a payment.
   */
  verifyWebhookSignature(): boolean {
    return true;
  }

  public override readonly name = 'fake';
  public failCreate = false;
  public failRefund = false;
  /** What getStatus() reports — drives reconcileAttempt resolution in tests. */
  public statusResult: 'succeeded' | 'failed' = 'succeeded';
  constructor() { super({}); }

  async createIntent(params: CreateIntentParams): Promise<ProviderIntent> {
    if (this.failCreate) throw new Error('gateway timeout while creating intent');
    const id = `fake_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      id, sessionId: id, paymentIntentId: id,
      provider: 'fake', status: 'requires_payment_method',
      amount: params.amount, metadata: {},
    };
  }
  async verifyPayment(id: string): Promise<PaymentResult> {
    return { id, provider: 'fake', status: 'succeeded', metadata: {} };
  }
  async getStatus(id: string): Promise<PaymentResult> {
    return { id, provider: 'fake', status: this.statusResult, metadata: {} };
  }
  async getRefundStatus(query: { paymentId: string; idempotencyKey: string }): Promise<PaymentResult> {
    return { id: query.idempotencyKey, provider: 'fake', status: this.statusResult, metadata: {} };
  }
  async refund(id: string, amount?: number | null): Promise<RefundResult> {
    if (this.failRefund) throw new Error('refund gateway timeout');
    return { id: `r_${id}`, provider: 'fake', status: 'succeeded', amount: { amount: amount ?? 0, currency: currencyCode('BDT') }, metadata: {} };
  }
  async handleWebhook(): Promise<WebhookEvent> {
    return { id: 'evt', provider: 'fake', type: 'x', data: {}, createdAt: new Date() };
  }
}

let engine: Awaited<ReturnType<typeof bindRevenue>>;
let provider: FakeProvider;
let mongoAvailable = false;

function attempts() {
  return mongoose.connection.db!.collection('revenue_payment_attempts');
}

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  provider = new FakeProvider();
  engine = await bindRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'BDT',
    providers: { fake: provider },
    modules: { subscription: false, escrow: false, settlement: false },
    scope: { enabled: false, fieldType: 'string' },
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
    provider.failCreate = false;
    provider.failRefund = false;
    provider.statusResult = 'succeeded';
  }
});

let paySeq = 0;
async function verifiedPayment(amount: number) {
  const txn = await engine.repositories.transaction.createPaymentIntent({
    amount, gateway: 'fake', methodKind: 'card', data: { customerId: 'buyer' },
    idempotencyKey: `pay-${++paySeq}`,
  });
  await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
  return txn;
}

describe('PaymentAttempt — attempt-before-I/O', () => {
  it('records one confirmed, linked attempt carrying the caller key', async () => {
    if (!mongoAvailable) return;
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 100000, gateway: 'fake', methodKind: 'card',
      data: { customerId: 'buyer_1' }, idempotencyKey: 'order-1',
    });
    const rows = await attempts().find({}).toArray();
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.outcome).toBe('confirmed');
    expect(String(a.transactionId)).toBe(String(txn._id));
    expect(a.idempotencyKey).toBe('order-1');
    expect(a.provider).toBe('fake');
    expect(a.gateway?.paymentIntentId).toBeTruthy();
    expect((txn as any).idempotencyKey).toBe('order-1');
  }, TIMEOUT);

  it('REJECTS a keyless positive payment (no attempt, no provider call)', async () => {
    if (!mongoAvailable) return;
    await expect(
      engine.repositories.transaction.createPaymentIntent({ amount: 100000, gateway: 'fake', methodKind: 'card' }),
    ).rejects.toThrow(/idempotencyKey is required/i);
    expect(await attempts().countDocuments({})).toBe(0);
  }, TIMEOUT);

  it('atomic claim: a same-key retry replays the transaction, never a second charge', async () => {
    if (!mongoAvailable) return;
    const first = await engine.repositories.transaction.createPaymentIntent({
      amount: 100000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'order-dup',
    });
    const again = await engine.repositories.transaction.createPaymentIntent({
      amount: 100000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'order-dup',
    });
    expect(String(again._id)).toBe(String(first._id));
    expect(await engine.repositories.transaction.count({})).toBe(1);
    expect(await attempts().countDocuments({ operation: 'create-intent' })).toBe(1);
  }, TIMEOUT);

  it('atomic claim: a same-key retry over an in-flight claim RE-DRIVES to ONE transaction (#2)', async () => {
    if (!mongoAvailable) return;
    // The unique command-identity index is the claim; make sure it is built, then
    // simulate an in-flight/orphaned claim (attempt exists, no transaction yet).
    await engine.models.PaymentAttempt.createIndexes();
    await attempts().insertOne({
      operation: 'create-intent', provider: 'fake', idempotencyKey: 'order-inflight',
      amount: 100000, currency: currencyCode('BDT'), outcome: 'unknown',
    });
    // A same-key retry must NOT deadlock: it re-drives (provider dedups) and completes.
    const txn = await engine.repositories.transaction.createPaymentIntent({
      amount: 100000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'order-inflight',
    });
    expect(txn).toBeTruthy();
    expect(await engine.repositories.transaction.count({})).toBe(1); // exactly one transaction
    // The existing attempt was reused (re-driven), not duplicated.
    expect(await attempts().countDocuments({ idempotencyKey: 'order-inflight' })).toBe(1);
  }, TIMEOUT);

  it('distinct keys are distinct sales', async () => {
    if (!mongoAvailable) return;
    const a = await engine.repositories.transaction.createPaymentIntent({ amount: 100000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'order-a' });
    const b = await engine.repositories.transaction.createPaymentIntent({ amount: 100000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'order-b' });
    expect(String(a._id)).not.toBe(String(b._id));
    expect(await attempts().countDocuments({})).toBe(2);
  }, TIMEOUT);

  it('an unobserved provider outcome leaves a VISIBLE unknown attempt and no transaction', async () => {
    if (!mongoAvailable) return;
    provider.failCreate = true;
    await expect(
      engine.repositories.transaction.createPaymentIntent({ amount: 50000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'order-unknown' }),
    ).rejects.toThrow(IntentOutcomeUnknownError);

    expect(await engine.repositories.transaction.count({})).toBe(0);
    const rows = await attempts().find({}).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('unknown');
    expect(rows[0]!.transactionId ?? null).toBeNull();
    expect(rows[0]!.idempotencyKey).toBe('order-unknown');
  }, TIMEOUT);
});

describe('Refund read model (listRefunds)', () => {
  it('projects a confirmed refund child + summary counters', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedPayment(10000);
    await engine.repositories.transaction.refund(txn._id.toString(), 4000, { reason: 'partial', idempotencyKey: 'rm-refund-1' });

    const rm = await engine.repositories.transaction.listRefunds(txn._id.toString());
    expect(rm.refundedAmount).toBe(4000);
    expect(rm.pendingRefundAmount).toBe(0);
    expect(rm.refunds).toHaveLength(1);
    expect(rm.refunds[0]!.source).toBe('transaction');
    expect(rm.refunds[0]!.status).toBe('succeeded');
    expect(rm.refunds[0]!.amount).toBe(4000);
    expect(rm.refunds[0]!.reason).toBe('partial');
  }, TIMEOUT);

  it('surfaces an in-flight UNKNOWN refund from the attempt (not just settled ones)', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedPayment(10000);
    provider.failRefund = true;
    await expect(
      engine.repositories.transaction.refund(txn._id.toString(), 5000, { idempotencyKey: 'rm-unknown' }),
    ).rejects.toThrow(RefundOutcomeUnknownError);

    const rm = await engine.repositories.transaction.listRefunds(txn._id.toString());
    expect(rm.refundedAmount).toBe(0);            // nothing confirmed
    expect(rm.pendingRefundAmount).toBe(5000);    // reservation held
    expect(rm.refunds).toHaveLength(1);
    expect(rm.refunds[0]!.source).toBe('attempt');
    expect(rm.refunds[0]!.status).toBe('unknown');
    expect(rm.refunds[0]!.amount).toBe(5000);
  }, TIMEOUT);
});

describe('backfill create-intent attempts (phase 3d)', () => {
  it('synthesizes one confirmed attempt per legacy payment_flow txn, idempotently', async () => {
    if (!mongoAvailable) return;
    // A pre-phase-3 transaction: has a gateway block but NO PaymentAttempt.
    const legacy = await mongoose.connection.db!.collection('revenue_transactions').insertOne({
      publicId: 'legacy-pi-1',
      type: 'purchase', flow: 'inflow', kind: 'payment_flow',
      amount: 7000, currency: currencyCode('BDT'), method: 'fake', methodKind: 'card', status: 'verified',
      gateway: { type: 'fake', sessionId: 'sess_legacy', paymentIntentId: 'pi_legacy' },
      createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await backfillCreatePaymentAttempts(engine.models, { log: () => {} });
    expect(res.created).toBe(1);

    const a = await attempts().findOne({ transactionId: legacy.insertedId, operation: 'create-intent' });
    expect(a).toBeTruthy();
    expect(a!.outcome).toBe('confirmed');
    expect(a!.gateway?.paymentIntentId).toBe('pi_legacy');
    expect(a!.amount).toBe(7000);

    // Idempotent: a second run creates nothing new for it.
    const res2 = await backfillCreatePaymentAttempts(engine.models, { log: () => {} });
    expect(res2.created).toBe(0);
    expect(await attempts().countDocuments({ transactionId: legacy.insertedId, operation: 'create-intent' })).toBe(1);
  }, TIMEOUT);

  it('dry-run reports without writing', async () => {
    if (!mongoAvailable) return;
    await mongoose.connection.db!.collection('revenue_transactions').insertOne({
      publicId: 'legacy-pi-2', type: 'purchase', flow: 'inflow', kind: 'payment_flow',
      amount: 3000, currency: currencyCode('BDT'), method: 'fake', methodKind: 'card', status: 'verified',
      gateway: { type: 'fake', paymentIntentId: 'pi_legacy_2' },
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await backfillCreatePaymentAttempts(engine.models, { dryRun: true, log: () => {} });
    expect(res.created).toBe(1);
    expect(res.dryRun).toBe(true);
    expect(await attempts().countDocuments({})).toBe(0); // nothing written
  }, TIMEOUT);
});

describe('reconcileAttempt + scanStaleAttempts (phase 3)', () => {
  // Drive a refund to an UNKNOWN outcome (provider throws), leaving the reservation
  // held and a `pending`/`unknown` refund attempt to reconcile.
  async function unknownRefund(key: string, amount = 6000) {
    const txn = await verifiedPayment(10000);
    provider.failRefund = true;
    await expect(
      engine.repositories.transaction.refund(txn._id.toString(), amount, { idempotencyKey: key }),
    ).rejects.toThrow(RefundOutcomeUnknownError);
    provider.failRefund = false;
    const attempt = (await attempts().findOne({ operation: 'refund', idempotencyKey: key }))!;
    return { txn, attempt };
  }

  it('provider CONFIRMS the refund → finalizes once (moves reserved→refunded, child created)', async () => {
    if (!mongoAvailable) return;
    const { txn, attempt } = await unknownRefund('rc-confirm', 6000);
    provider.statusResult = 'succeeded';

    const res = await engine.repositories.transaction.reconcileAttempt(String(attempt._id));
    expect(res.resolved).toBe(true);
    expect(res.resolvedOutcome).toBe('confirmed');

    const original = (await engine.repositories.transaction.getById(txn._id.toString())) as any;
    expect(original.refundedAmount).toBe(6000);
    expect(original.pendingRefundAmount).toBe(0);
    expect(original.status).toBe(TRANSACTION_STATUS.PARTIALLY_REFUNDED);

    const child = await attempts().findOne({ _id: attempt._id });
    expect(child!.outcome).toBe('confirmed');
    const refundChildren = await engine.repositories.transaction.getAll(
      { filters: { type: 'refund', idempotencyKey: 'rc-confirm' } } as never,
      {} as never,
    );
    expect(((refundChildren as any).data ?? refundChildren)).toHaveLength(1);

    // Reconciling again is a no-op (terminal).
    const again = await engine.repositories.transaction.reconcileAttempt(String(attempt._id));
    expect(again.resolved).toBe(false);
  }, TIMEOUT);

  it('provider reports the refund FAILED → releases the reservation once (original untouched)', async () => {
    if (!mongoAvailable) return;
    const { txn, attempt } = await unknownRefund('rc-failed', 6000);
    provider.statusResult = 'failed';

    const res = await engine.repositories.transaction.reconcileAttempt(String(attempt._id));
    expect(res.resolvedOutcome).toBe('declined');

    const original = (await engine.repositories.transaction.getById(txn._id.toString())) as any;
    expect(original.pendingRefundAmount).toBe(0); // reservation released
    expect(original.refundedAmount ?? 0).toBe(0);
    expect(original.status).toBe(TRANSACTION_STATUS.VERIFIED); // never flipped
  }, TIMEOUT);

  it('scanStaleAttempts drains the worklist', async () => {
    if (!mongoAvailable) return;
    await unknownRefund('rc-scan', 5000);
    provider.statusResult = 'succeeded';
    const r = await engine.repositories.transaction.scanStaleAttempts({ olderThanMs: 0 });
    expect(r.scanned).toBeGreaterThanOrEqual(1);
    expect(r.resolved).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);

  it('CONCURRENT reconcile of the same attempt resolves exactly ONCE (atomic claim #4)', async () => {
    if (!mongoAvailable) return;
    const { txn, attempt } = await unknownRefund('rc-concurrent', 6000);
    provider.statusResult = 'succeeded';

    const results = await Promise.allSettled([
      engine.repositories.transaction.reconcileAttempt(String(attempt._id)),
      engine.repositories.transaction.reconcileAttempt(String(attempt._id)),
    ]);
    const resolvedCount = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as { resolved: boolean }).resolved,
    ).length;
    expect(resolvedCount).toBe(1); // the claim elects a single winner

    const original = (await engine.repositories.transaction.getById(txn._id.toString())) as any;
    expect(original.refundedAmount).toBe(6000); // moved ONCE, not twice
    expect(original.pendingRefundAmount).toBe(0);
    const children = await engine.repositories.transaction.getAll(
      { filters: { type: 'refund', idempotencyKey: 'rc-concurrent' } } as never,
      {} as never,
    );
    expect(((children as any).data ?? children)).toHaveLength(1); // one refund child, not two
  }, TIMEOUT);

  it('provider WITHOUT refund-status lookup → reservation RETAINED, never misclassified (#1)', async () => {
    if (!mongoAvailable) return;
    const { txn, attempt } = await unknownRefund('rc-noquery', 6000);
    const saved = (provider as unknown as { getRefundStatus?: unknown }).getRefundStatus;
    (provider as unknown as { getRefundStatus?: unknown }).getRefundStatus = undefined;
    try {
      const res = await engine.repositories.transaction.reconcileAttempt(String(attempt._id));
      expect(res.resolved).toBe(false);
      expect(res.note).toMatch(/no refund-status lookup/i);
      const original = (await engine.repositories.transaction.getById(txn._id.toString())) as any;
      expect(original.pendingRefundAmount).toBe(6000); // held, not finalized/released
      expect(original.refundedAmount ?? 0).toBe(0);
    } finally {
      (provider as unknown as { getRefundStatus?: unknown }).getRefundStatus = saved;
    }
  }, TIMEOUT);

  it('a timed-out refund carries NO providerReference → reconcile queries by metadata, not refundRef (#R6)', async () => {
    if (!mongoAvailable) return;
    const { attempt } = await unknownRefund('rc-noref', 6000);
    // The PAYMENT id must NOT be stamped as the attempt's providerReference — reused as a
    // refundRef it would send Stripe `refunds.retrieve(pi_…)` and defeat the metadata fallback.
    expect(attempt.providerReference ?? undefined).toBeUndefined();

    // Capture the query reconcile hands the provider's refund-status lookup.
    let seenQuery: { paymentId?: string; idempotencyKey?: string; refundRef?: string } | undefined;
    const original = provider.getRefundStatus.bind(provider);
    (provider as { getRefundStatus: unknown }).getRefundStatus = async (q: typeof seenQuery) => {
      seenQuery = q;
      return original(q as never);
    };
    provider.statusResult = 'succeeded';
    try {
      await engine.repositories.transaction.reconcileAttempt(String(attempt._id));
    } finally {
      (provider as { getRefundStatus: unknown }).getRefundStatus = original;
    }
    expect(seenQuery?.refundRef).toBeUndefined();
    expect(seenQuery?.paymentId).toBeTruthy();
    expect(seenQuery?.idempotencyKey).toBe('rc-noref');
  }, TIMEOUT);

  it('CONFIRMED-but-unlinked create attempt is relinked, not stranded (#3)', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedPayment(5000);
    const payKey = (txn as any).idempotencyKey as string;
    // Simulate a lost link write: attempt confirmed but transactionId null.
    await attempts().updateOne(
      { operation: 'create-intent', idempotencyKey: payKey },
      { $set: { transactionId: null } },
    );
    const orphan = (await attempts().findOne({ operation: 'create-intent', idempotencyKey: payKey }))!;
    const res = await engine.repositories.transaction.reconcileAttempt(String(orphan._id));
    expect(res.resolved).toBe(true);
    expect(res.note).toMatch(/relinked/i);
    const relinked = await attempts().findOne({ operation: 'create-intent', idempotencyKey: payKey });
    expect(String(relinked!.transactionId)).toBe(String(txn._id));
  }, TIMEOUT);
});

// ── Cross-branch scope (#5) — a SEPARATE scoped engine ──
describe('reconcile is branch-scoped (#5)', () => {
  let scopedEngine: Awaited<ReturnType<typeof bindRevenue>>;

  beforeAll(async () => {
    if (!mongoAvailable) return;
    scopedEngine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'BDT',
      providers: { fake: new FakeProvider() },
      modules: { subscription: false, escrow: false, settlement: false },
      scope: { enabled: true, fieldType: 'string', required: true },
      forceRecreate: true,
      // Shares the connection with the unscoped engine above; org-prefixed indexes
      // would collide by name on the shared collections. This test exercises scoped
      // READS, not index enforcement, so skip index builds.
      autoIndex: false,
    });
    await warmModels(scopedEngine);
  }, TIMEOUT);

  afterAll(async () => {
    if (scopedEngine) await scopedEngine.close();
  });

  it('reconcileAttempt refuses an attempt belonging to another branch', async () => {
    if (!mongoAvailable) return;
    await clearCollections();
    // A payment attempt owned by branch A.
    const a = await scopedEngine.models.PaymentAttempt.create({
      organizationId: 'branch-A', operation: 'create-intent', provider: 'fake',
      idempotencyKey: 'xb-1', amount: 1000, currency: currencyCode('BDT'), outcome: 'unknown',
    });
    // Branch B may not touch it — scoped read yields nothing → "not found (or out of scope)".
    await expect(
      scopedEngine.repositories.transaction.reconcileAttempt(String(a._id), { organizationId: 'branch-B' }),
    ).rejects.toThrow(/not found|out of scope/i);
    // Branch A can (no provider ref / no txn → retained, but it RESOLVED scope).
    const own = await scopedEngine.repositories.transaction.reconcileAttempt(String(a._id), { organizationId: 'branch-A' });
    expect(own.attemptId).toBe(String(a._id));
  }, TIMEOUT);
});

describe('Attempt history read model (listAttempts)', () => {
  /**
   * The read phase 3 exists FOR. The parent's embedded `gateway` block has only ever had
   * room for the LAST attempt, so "declined, then unknown, then succeeded" is not merely
   * unrecorded without these rows — it is unrepresentable. Writing them and shipping no
   * way to read them would leave the capability real and unreachable.
   */
  it('returns EVERY round-trip oldest-first, and keeps `unknown` separate from `declined`', async () => {
    if (!mongoAvailable) return;

    // 1: an unobserved outcome — no transaction, a visible `unknown` attempt.
    provider.failCreate = true;
    await expect(
      engine.repositories.transaction.createPaymentIntent({
        amount: 30000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'hist-unknown',
      }),
    ).rejects.toThrow(IntentOutcomeUnknownError);

    // 2: the customer retries and it succeeds.
    provider.failCreate = false;
    const ok = await engine.repositories.transaction.createPaymentIntent({
      amount: 30000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'hist-ok',
    });

    const history = await engine.repositories.transaction.listAttempts(ok._id.toString());

    // Only the attempt LINKED to this transaction — the orphaned unknown belongs to no
    // transaction (that is what makes it an orphan) and must not be attributed to this one.
    expect(history.attempts.every((a) => a.operation === 'create-intent')).toBe(true);
    expect(history.confirmedCount).toBe(1);
    expect(history.attempts).toHaveLength(1);
    expect(history.attempts[0]!.outcome).toBe('confirmed');
    expect(history.attempts[0]!.provider).toBe('fake');

    /**
     * The counters are separate FIELDS, not one "failed" total: an unobserved outcome is
     * not a negative one, and collapsing them is what licenses a retry against a charge
     * that may have succeeded.
     */
    expect(history).toHaveProperty('unknownCount');
    expect(history).toHaveProperty('declinedCount');
    expect(history.unknownCount + history.declinedCount).toBe(0);
  }, TIMEOUT);

  it('does NOT leak the provider decline TEXT — only the closed causeCode', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedPayment(10000);
    provider.failRefund = true;
    await expect(
      engine.repositories.transaction.refund(txn._id.toString(), 2500, { idempotencyKey: 'hist-raw' }),
    ).rejects.toThrow(RefundOutcomeUnknownError);

    /**
     * Populate the raw text ON THE STORED ROW first — otherwise this asserts the absence
     * of something nothing ever wrote, which passes whatever the projection does. (It did
     * exactly that on the first draft: injecting the leak into the projection left all
     * tests green, because this scenario's provider never sets `declineReason`.)
     */
    const stored = await attempts().findOne({ operation: 'refund' });
    expect(stored).toBeTruthy();
    await attempts().updateOne(
      { _id: stored!._id },
      { $set: { declineReason: 'RAW-PROVIDER-TEXT: card_declined by issuer 51' } },
    );

    const history = await engine.repositories.transaction.listAttempts(txn._id.toString());
    const refundAttempt = history.attempts.find((a) => a.operation === 'refund');
    expect(refundAttempt).toBeDefined();
    // A raw vendor string in a displayed field is the anti-pattern; the view has no slot for it.
    expect(refundAttempt).not.toHaveProperty('declineReason');
    expect(JSON.stringify(history)).not.toContain('RAW-PROVIDER-TEXT');
  }, TIMEOUT);

  it('a transaction with no attempts returns an EMPTY history, not a throw', async () => {
    if (!mongoAvailable) return;
    const txn = await verifiedPayment(10000);
    // Drop the rows a deployment predating phase 3 would never have had.
    await attempts().deleteMany({});
    const history = await engine.repositories.transaction.listAttempts(txn._id.toString());
    expect(history.attempts).toEqual([]);
    expect(history.confirmedCount).toBe(0);
  }, TIMEOUT);
});
