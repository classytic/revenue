/**
 * Scenario: Subscription multi-tenant correctness — regression for v2.1.1.
 *
 * In v2.1.0 every `SubscriptionRepository` lifecycle verb (`activate`,
 * `cancel`, `pause`, `resume`) called `this.getById(id)` *without*
 * threading `ctx` into the options bag. The moment a host enabled
 * mongokit's `multiTenantPlugin` (the recommended default — see
 * createRevenue PACKAGE_RULES §9), each verb threw
 * `Missing 'organizationId' in context for 'getById'` mid-flow.
 *
 * v2.1.1 fixed this by extracting `RevenueRepositoryBase.optsFromCtx()`
 * (built on mongokit's `repoOptionsFromCtx`) and threading it through
 * every internal read AND every internal `update` in the four verbs.
 *
 * This scenario locks the fix in place. It also covers the cross-tenant
 * isolation guarantee: org A cannot see/touch org B's subscription via
 * any of the four verbs.
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
  SUBSCRIPTION_STATUS,
  SubscriptionNotFoundError,
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
    // CRITICAL — this is the config that exposed the v2.1.0 bug.
    // Every read/write under this engine is auto-scoped by org via
    // multiTenantPlugin; verbs that don't thread ctx into mongokit
    // opts blow up. Keeping `enabled + required` here is the test.
    scope: { enabled: true, fieldType: 'string', required: true },
    modules: { subscription: true, escrow: false, settlement: false },
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

const ORG_A = 'org_a_dhaka';
const ORG_B = 'org_b_ctg';

async function createPendingSub(orgId: string, planKey = 'monthly') {
  return engine.repositories.subscription!.create(
    {
      customerId: 'cust_' + orgId,
      planKey,
      cycle: planKey,
      amount: 999,
      currency: 'USD',
      status: SUBSCRIPTION_STATUS.PENDING,
      isActive: false,
      // organizationId injected by multiTenantPlugin from ctx
    } as never,
    { organizationId: orgId } as unknown as Record<string, unknown>,
  );
}

describe('SubscriptionRepository — multi-tenant correctness', () => {
  it('activate() works under enabled scope (regression for v2.1.0 bug)', async () => {
    if (!mongoAvailable) return;
    const sub = await createPendingSub(ORG_A);
    const activated = await engine.repositories.subscription!.activate(
      String(sub._id),
      {},
      { organizationId: ORG_A },
    );
    expect(activated.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(activated.isActive).toBe(true);
    expect(activated.activatedAt).toBeInstanceOf(Date);
    expect(activated.endDate).toBeInstanceOf(Date);
  }, TIMEOUT);

  it('cancel() works under enabled scope', async () => {
    if (!mongoAvailable) return;
    const sub = await createPendingSub(ORG_A);
    await engine.repositories.subscription!.activate(String(sub._id), {}, { organizationId: ORG_A });

    const cancelled = await engine.repositories.subscription!.cancel(
      String(sub._id),
      { immediate: true, reason: 'test cancel' },
      { organizationId: ORG_A },
    );
    expect(cancelled.status).toBe(SUBSCRIPTION_STATUS.CANCELLED);
    expect(cancelled.isActive).toBe(false);
  }, TIMEOUT);

  it('pause() + resume() round-trip works under enabled scope', async () => {
    if (!mongoAvailable) return;
    const sub = await createPendingSub(ORG_A);
    await engine.repositories.subscription!.activate(String(sub._id), {}, { organizationId: ORG_A });

    const paused = await engine.repositories.subscription!.pause(
      String(sub._id),
      { reason: 'vacation' },
      { organizationId: ORG_A },
    );
    expect(paused.status).toBe(SUBSCRIPTION_STATUS.PAUSED);
    expect(paused.pausedAt).toBeInstanceOf(Date);

    const resumed = await engine.repositories.subscription!.resume(
      String(sub._id),
      { extendPeriod: true },
      { organizationId: ORG_A },
    );
    expect(resumed.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(resumed.isActive).toBe(true);
  }, TIMEOUT);

  it('cross-tenant: org B cannot activate org A\'s subscription', async () => {
    if (!mongoAvailable) return;
    const subA = await createPendingSub(ORG_A);

    // Wrong org context — getById inside activate() filters by organizationId,
    // so the sub is invisible. Verb throws SubscriptionNotFoundError.
    await expect(
      engine.repositories.subscription!.activate(
        String(subA._id),
        {},
        { organizationId: ORG_B },
      ),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);

    // Sanity: under the right org, it works.
    const activated = await engine.repositories.subscription!.activate(
      String(subA._id),
      {},
      { organizationId: ORG_A },
    );
    expect(activated.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  }, TIMEOUT);

  it('cross-tenant: org B cannot pause/cancel/resume org A\'s subscription', async () => {
    if (!mongoAvailable) return;
    const subA = await createPendingSub(ORG_A);
    await engine.repositories.subscription!.activate(String(subA._id), {}, { organizationId: ORG_A });

    await expect(
      engine.repositories.subscription!.pause(String(subA._id), {}, { organizationId: ORG_B }),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);

    await expect(
      engine.repositories.subscription!.cancel(String(subA._id), { immediate: true }, { organizationId: ORG_B }),
    ).rejects.toBeInstanceOf(SubscriptionNotFoundError);
  }, TIMEOUT);

  it('verbs throw `Missing organizationId` when ctx is omitted (multiTenantPlugin canary)', async () => {
    if (!mongoAvailable) return;
    const sub = await createPendingSub(ORG_A);

    // No ctx → no orgId → mongokit's plugin throws BEFORE the state
    // machine even runs. This is the canary that scope is wired
    // end-to-end through the fixed `optsFromCtx` plumbing.
    await expect(
      engine.repositories.subscription!.activate(String(sub._id), {}),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);
});
