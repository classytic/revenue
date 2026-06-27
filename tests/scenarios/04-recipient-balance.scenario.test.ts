/**
 * Scenario 04 — `SettlementRepository.recipientBalance()` certification suite.
 *
 * The marketplace "wallet" rollup: what the platform owes / has paid a
 * recipient, bucketed by settlement status. Because money correctness and
 * tenant isolation are non-negotiable, this suite covers:
 *
 *   - edge cases        : empty, single status, every status, failed excluded
 *                         from lifetime, cancelled excluded entirely
 *   - isolation         : per-recipient, per-currency, per-recipientType, and
 *                         MULTI-TENANT (same recipientId across two orgs)
 *   - integer-cents     : large sums with zero float drift
 *   - lifecycle         : balance tracks pending → processing → paidOut live
 *   - load              : 10k settlements aggregate to the exact totals, fast
 *
 * Tenant scope is enabled (`fieldType: 'objectId'`) so the aggregation is
 * proven to inject the multi-tenant `$match` — the whole reason the method
 * exists instead of a raw `Model.aggregate()`.
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
import { createRevenue, SETTLEMENT_STATUS } from '../../revenue/src/index.js';

const TIMEOUT = 60_000;
const oid = (): string => new mongoose.Types.ObjectId().toString();

let engine: Awaited<ReturnType<typeof createRevenue>>;
let mongoAvailable = false;
const ORG_A = oid();
const ORG_B = oid();

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'BDT',
    providers: { fake: new FakeProvider() },
    modules: { subscription: false, escrow: false, settlement: true },
    scope: { fieldType: 'objectId' },
    forceRecreate: true,
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

const ctx = (orgId: string) => ({ organizationId: orgId });
const settlement = () => engine.repositories.settlement!;

async function schedule(
  orgId: string,
  recipientId: string,
  amount: number,
  currency = 'BDT',
  recipientType = 'organization',
) {
  return settlement().schedule(
    {
      organizationId: orgId,
      recipientId,
      recipientType,
      type: 'split_payout',
      amount,
      currency,
      payoutMethod: 'manual',
    },
    ctx(orgId),
  );
}

const processAll = (orgId: string) =>
  settlement().processPending({ organizationId: orgId, limit: 100_000 }, ctx(orgId));
const complete = (orgId: string, id: string) =>
  settlement().complete(id, { transferReference: 'TR-1' }, ctx(orgId));
const fail = (orgId: string, id: string) =>
  settlement().fail(id, 'test failure', {}, ctx(orgId));
const balance = (
  orgId: string,
  recipientId: string,
  opts: { recipientType?: string; currency?: string } = {},
) => settlement().recipientBalance(recipientId, opts, ctx(orgId));

describe('recipientBalance — edge cases', () => {
  it('returns zeros + null currency when the recipient has no settlements', async () => {
    if (!mongoAvailable) return;
    const b = await balance(ORG_A, 'ghost');
    expect(b).toMatchObject({
      recipientId: 'ghost',
      currency: null,
      pending: 0,
      processing: 0,
      paidOut: 0,
      failed: 0,
      lifetime: 0,
    });
  });

  it('reports a single pending settlement (due now → available)', async () => {
    if (!mongoAvailable) return;
    await schedule(ORG_A, 'R', 50_000);
    const b = await balance(ORG_A, 'R');
    expect(b.pending).toBe(50_000);
    expect(b.available).toBe(50_000); // scheduledAt defaults to now → cleared
    expect(b.held).toBe(0);
    expect(b.lifetime).toBe(50_000);
    expect(b.processing + b.paidOut + b.failed).toBe(0);
    expect(b.currency).toBe('BDT');
  });

  it('buckets every status, excluding failed from lifetime', async () => {
    if (!mongoAvailable) return;
    const s1 = await schedule(ORG_A, 'R', 1_000); // → completed
    const s2 = await schedule(ORG_A, 'R', 2_000); // → processing
    const s4 = await schedule(ORG_A, 'R', 4_000); // → failed
    await processAll(ORG_A); // s1,s2,s4 → processing
    await complete(ORG_A, String(s1._id));
    await fail(ORG_A, String(s4._id));
    const s3 = await schedule(ORG_A, 'R', 3_000); // scheduled AFTER → stays pending
    void s2;
    void s3;

    const b = await balance(ORG_A, 'R');
    expect(b.paidOut).toBe(1_000);
    expect(b.processing).toBe(2_000);
    expect(b.pending).toBe(3_000);
    expect(b.failed).toBe(4_000);
    // lifetime = committed (pending+processing+paid), NOT failed.
    expect(b.lifetime).toBe(6_000);
  });

  it('excludes cancelled settlements entirely', async () => {
    if (!mongoAvailable) return;
    await engine.models.Settlement!.create({
      publicId: 'stl_cancelled_1',
      organizationId: ORG_A,
      recipientId: 'R',
      recipientType: 'organization',
      type: 'split_payout',
      status: SETTLEMENT_STATUS.CANCELLED,
      amount: 9_999,
      currency: 'BDT',
      payoutMethod: 'manual',
      scheduledAt: new Date(),
    });
    await schedule(ORG_A, 'R', 1_000);
    const b = await balance(ORG_A, 'R');
    expect(b.pending).toBe(1_000);
    expect(b.lifetime).toBe(1_000); // cancelled 9_999 not counted anywhere
  });
});

describe('recipientBalance — isolation', () => {
  it('does not bleed across recipients', async () => {
    if (!mongoAvailable) return;
    await schedule(ORG_A, 'R1', 5_000);
    await schedule(ORG_A, 'R2', 3_000);
    expect((await balance(ORG_A, 'R1')).pending).toBe(5_000);
    expect((await balance(ORG_A, 'R2')).pending).toBe(3_000);
  });

  it('filters by currency (multi-currency recipient)', async () => {
    if (!mongoAvailable) return;
    await schedule(ORG_A, 'R', 5_000, 'BDT');
    await schedule(ORG_A, 'R', 7_000, 'USD');
    const bdt = await balance(ORG_A, 'R', { currency: 'BDT' });
    const usd = await balance(ORG_A, 'R', { currency: 'USD' });
    expect(bdt.pending).toBe(5_000);
    expect(bdt.currency).toBe('BDT');
    expect(usd.pending).toBe(7_000);
    expect(usd.currency).toBe('USD');
  });

  it('filters by recipientType', async () => {
    if (!mongoAvailable) return;
    await schedule(ORG_A, 'R', 5_000, 'BDT', 'organization');
    await schedule(ORG_A, 'R', 3_000, 'BDT', 'vendor');
    expect((await balance(ORG_A, 'R', { recipientType: 'organization' })).pending).toBe(5_000);
    expect((await balance(ORG_A, 'R', { recipientType: 'vendor' })).pending).toBe(3_000);
  });

  it('is multi-tenant scoped: same recipientId across two orgs never sums together', async () => {
    if (!mongoAvailable) return;
    await schedule(ORG_A, 'shared', 5_000);
    await schedule(ORG_B, 'shared', 9_000);
    expect((await balance(ORG_A, 'shared')).pending).toBe(5_000);
    expect((await balance(ORG_B, 'shared')).pending).toBe(9_000);
  });
});

describe('recipientBalance — escrow (held vs available)', () => {
  it('splits pending into held (clearance window) and available (due)', async () => {
    if (!mongoAvailable) return;
    const future = new Date(Date.now() + 7 * 86_400_000); // clears in a week
    const past = new Date(Date.now() - 86_400_000); // already cleared
    const common = {
      organizationId: ORG_A,
      recipientId: 'R',
      recipientType: 'organization',
      type: 'split_payout',
      currency: 'BDT',
      payoutMethod: 'manual',
    };
    await settlement().schedule({ ...common, amount: 7_000, scheduledAt: future }, ctx(ORG_A));
    await settlement().schedule({ ...common, amount: 3_000, scheduledAt: past }, ctx(ORG_A));

    const b = await balance(ORG_A, 'R');
    expect(b.held).toBe(7_000); // escrowed, not payable yet
    expect(b.available).toBe(3_000); // cleared, ready to pay
    expect(b.pending).toBe(10_000); // held + available
    expect(b.lifetime).toBe(10_000);
  });
});

describe('recipientBalance — integer-cents correctness', () => {
  it('sums large minor-unit amounts with zero float drift', async () => {
    if (!mongoAvailable) return;
    await schedule(ORG_A, 'big', 999_999_999);
    await schedule(ORG_A, 'big', 999_999_999);
    await schedule(ORG_A, 'big', 1);
    const b = await balance(ORG_A, 'big');
    expect(b.pending).toBe(1_999_999_999);
    expect(Number.isInteger(b.pending)).toBe(true);
  });
});

describe('recipientBalance — lifecycle', () => {
  it('tracks a settlement pending → processing → paidOut', async () => {
    if (!mongoAvailable) return;
    const s = await schedule(ORG_A, 'R', 12_000);
    expect((await balance(ORG_A, 'R')).pending).toBe(12_000);

    await processAll(ORG_A);
    let b = await balance(ORG_A, 'R');
    expect(b.pending).toBe(0);
    expect(b.processing).toBe(12_000);

    await complete(ORG_A, String(s._id));
    b = await balance(ORG_A, 'R');
    expect(b.processing).toBe(0);
    expect(b.paidOut).toBe(12_000);
    expect(b.lifetime).toBe(12_000);
  });
});

describe('recipientBalance — load', () => {
  it('aggregates 10k settlements to the exact totals, fast', async () => {
    if (!mongoAvailable) return;
    const N = 10_000;
    const docs: Record<string, unknown>[] = [];
    let expectPending = 0;
    let expectPaid = 0;
    const orgOid = new mongoose.Types.ObjectId(ORG_A);
    const now = new Date();
    for (let i = 0; i < N; i++) {
      const completed = i % 2 === 0;
      const amount = 100 + (i % 137); // varied, integer
      if (completed) expectPaid += amount;
      else expectPending += amount;
      docs.push({
        publicId: `stl_load_${i}`,
        organizationId: orgOid,
        recipientId: 'load',
        recipientType: 'organization',
        type: 'split_payout',
        status: completed ? SETTLEMENT_STATUS.COMPLETED : SETTLEMENT_STATUS.PENDING,
        amount,
        currency: 'BDT',
        payoutMethod: 'manual',
        scheduledAt: now,
      });
    }
    await engine.models.Settlement!.insertMany(docs, { ordered: false });

    const t0 = performance.now();
    const b = await balance(ORG_A, 'load');
    const elapsedMs = performance.now() - t0;

    expect(b.pending).toBe(expectPending);
    expect(b.paidOut).toBe(expectPaid);
    expect(b.lifetime).toBe(expectPending + expectPaid);
    // One indexed grouped aggregation over 10k rows must stay well under a second.
    expect(elapsedMs).toBeLessThan(2_000);
  }, TIMEOUT);
});
