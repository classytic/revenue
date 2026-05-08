/**
 * Scenario: Settlement multi-tenant correctness — regression for v2.1.1.
 *
 * v2.1.0 had the same ctx-propagation bug as SubscriptionRepository:
 * `complete()` and `fail()` called `this.getById(settlementId)` without
 * threading ctx, and `processPending()` ran `getAll`/`update` calls
 * unscoped. Hosts running with `multiTenantPlugin` enabled couldn't
 * complete settlements at all under v2.1.0.
 *
 * v2.1.1 routes every read/write through `RevenueRepositoryBase.optsFromCtx`,
 * so each verb participates in tenant scoping.
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
  createRevenue,
  SETTLEMENT_STATUS,
  SettlementNotFoundError,
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
    scope: { enabled: true, fieldType: 'string', required: true },
    modules: { subscription: false, escrow: false, settlement: true },
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

const ORG_A = 'org_a';
const ORG_B = 'org_b';

async function schedulePending(orgId: string) {
  return engine.repositories.settlement!.schedule(
    {
      organizationId: orgId,
      recipientId: 'rec_' + orgId,
      recipientType: 'organization',
      type: 'payout',
      amount: 5000,
      currency: 'USD',
      payoutMethod: 'bank_transfer',
      // backdate so processPending picks it up
      scheduledAt: new Date(Date.now() - 1000),
    },
    { organizationId: orgId },
  );
}

describe('SettlementRepository — multi-tenant correctness', () => {
  it('schedule() works under enabled scope', async () => {
    if (!mongoAvailable) return;
    const s = await schedulePending(ORG_A);
    expect(s.status).toBe(SETTLEMENT_STATUS.PENDING);
  }, TIMEOUT);

  it('processPending() flips only own-org settlements', async () => {
    if (!mongoAvailable) return;
    const sA = await schedulePending(ORG_A);
    const sB = await schedulePending(ORG_B);

    const result = await engine.repositories.settlement!.processPending(
      {},
      { organizationId: ORG_A },
    );
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.settlements.every((x) => String(x.organizationId) === ORG_A)).toBe(true);

    // ORG_B still pending — was invisible to the ORG_A sweep.
    const stillPending = await engine.repositories.settlement!.getById(
      String(sB._id),
      { throwOnNotFound: false, organizationId: ORG_B } as unknown as Record<string, unknown>,
    );
    expect(stillPending).not.toBeNull();
    expect((stillPending as { status: string }).status).toBe(SETTLEMENT_STATUS.PENDING);

    // sanity: A flipped
    const flipped = await engine.repositories.settlement!.getById(
      String(sA._id),
      { throwOnNotFound: false, organizationId: ORG_A } as unknown as Record<string, unknown>,
    );
    expect((flipped as { status: string }).status).toBe(SETTLEMENT_STATUS.PROCESSING);
  }, TIMEOUT);

  it('complete() works under enabled scope', async () => {
    if (!mongoAvailable) return;
    const s = await schedulePending(ORG_A);
    await engine.repositories.settlement!.processPending({}, { organizationId: ORG_A });
    const completed = await engine.repositories.settlement!.complete(
      String(s._id),
      { transferReference: 'BANK-REF-001' },
      { organizationId: ORG_A },
    );
    expect(completed.status).toBe(SETTLEMENT_STATUS.COMPLETED);
    expect(completed.completedAt).toBeInstanceOf(Date);
  }, TIMEOUT);

  it('fail() with retry resets to pending', async () => {
    if (!mongoAvailable) return;
    const s = await schedulePending(ORG_A);
    await engine.repositories.settlement!.processPending({}, { organizationId: ORG_A });
    const failed = await engine.repositories.settlement!.fail(
      String(s._id),
      'bank rejected',
      { code: 'BANK_REJECT', retry: true },
      { organizationId: ORG_A },
    );
    expect(failed.status).toBe(SETTLEMENT_STATUS.PENDING);
    expect(failed.retryCount).toBe(1);
  }, TIMEOUT);

  it('cross-tenant: org B cannot complete org A\'s settlement', async () => {
    if (!mongoAvailable) return;
    const s = await schedulePending(ORG_A);
    await engine.repositories.settlement!.processPending({}, { organizationId: ORG_A });

    await expect(
      engine.repositories.settlement!.complete(
        String(s._id),
        { transferReference: 'spoof' },
        { organizationId: ORG_B },
      ),
    ).rejects.toBeInstanceOf(SettlementNotFoundError);
  }, TIMEOUT);
});
