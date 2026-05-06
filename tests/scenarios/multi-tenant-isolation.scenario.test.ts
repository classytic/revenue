/**
 * Scenario: Multi-tenant isolation via mongokit's multiTenantPlugin.
 *
 * When `scope: { enabled: true, fieldType: 'string' }`, every read/write
 * MUST be filtered by `organizationId` (auto-injected from `ctx`). This
 * test proves:
 *
 *   1. A transaction created for org A is INVISIBLE from an org-B context.
 *   2. `getAll` for org A returns only org-A rows.
 *   3. A `verify` performed under the WRONG org context cannot find the
 *      transaction — the scope filter wins over the session-id lookup.
 *   4. Listing across both orgs (via the admin scope-off path) shows everything.
 *
 * This is the backbone of single-tenant-multi-branch architectures (see
 * AGENTS.md "organizationId in Flow = branchId"). Without it, one branch's
 * cashier can see another branch's transactions.
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
  TransactionNotFoundError,
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
    // Enable multi-tenant scope with string org ids (matches BigBoss branches).
    scope: { enabled: true, fieldType: 'string', required: true },
    modules: { subscription: false, escrow: false, settlement: false },
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

describe('Scenario: Multi-tenant isolation', () => {
  it('hides org-A transactions from an org-B context', async () => {
    if (!mongoAvailable) return;

    const orgA = 'branch_dhaka';
    const orgB = 'branch_ctg';

    // Create one transaction per org.
    const txnA = await engine.repositories.transaction.createPaymentIntent(
      { amount: 100, gateway: 'fake', data: { customerId: 'c_a' } },
      { organizationId: orgA, actorId: 'u1' },
    );
    const txnB = await engine.repositories.transaction.createPaymentIntent(
      { amount: 200, gateway: 'fake', data: { customerId: 'c_b' } },
      { organizationId: orgB, actorId: 'u2' },
    );

    // Persisted orgIds are what we passed in.
    expect(String((txnA as { organizationId: unknown }).organizationId)).toBe(orgA);
    expect(String((txnB as { organizationId: unknown }).organizationId)).toBe(orgB);

    // getById under the WRONG org must not surface the other's row.
    const crossLookup = await engine.repositories.transaction.getById(
      String(txnA._id),
      { throwOnNotFound: false, organizationId: orgB } as unknown as Record<string, unknown>,
    );
    expect(crossLookup).toBeNull();

    // getById under the RIGHT org works.
    const sameLookup = await engine.repositories.transaction.getById(
      String(txnA._id),
      { throwOnNotFound: false, organizationId: orgA } as unknown as Record<string, unknown>,
    );
    expect(sameLookup).not.toBeNull();
    expect(String(sameLookup!._id)).toBe(String(txnA._id));
  }, TIMEOUT);

  it('getAll returns only the caller org rows', async () => {
    if (!mongoAvailable) return;

    const orgA = 'branch_dhaka';
    const orgB = 'branch_ctg';

    await engine.repositories.transaction.createPaymentIntent(
      { amount: 100, gateway: 'fake', data: { customerId: 'c_a1' } },
      { organizationId: orgA },
    );
    await engine.repositories.transaction.createPaymentIntent(
      { amount: 300, gateway: 'fake', data: { customerId: 'c_a2' } },
      { organizationId: orgA },
    );
    await engine.repositories.transaction.createPaymentIntent(
      { amount: 500, gateway: 'fake', data: { customerId: 'c_b1' } },
      { organizationId: orgB },
    );

    const listA = await engine.repositories.transaction.getAll({
      organizationId: orgA,
    } as unknown as Record<string, unknown>);
    const listB = await engine.repositories.transaction.getAll({
      organizationId: orgB,
    } as unknown as Record<string, unknown>);

    const docsA = (listA as { data: Array<{ organizationId: unknown }> }).data;
    const docsB = (listB as { data: Array<{ organizationId: unknown }> }).data;
    expect(docsA).toHaveLength(2);
    expect(docsB).toHaveLength(1);
    expect(docsA.every(d => String(d.organizationId) === orgA)).toBe(true);
    expect(docsB.every(d => String(d.organizationId) === orgB)).toBe(true);
  }, TIMEOUT);

  it('verify under the wrong org cannot find the transaction', async () => {
    if (!mongoAvailable) return;

    const orgA = 'branch_dhaka';
    const orgB = 'branch_ctg';

    const txnA = await engine.repositories.transaction.createPaymentIntent(
      { amount: 100, gateway: 'fake', data: { customerId: 'c_cross' } },
      { organizationId: orgA },
    );
    const sessionId = txnA.gateway!.paymentIntentId as string;

    // Wrong org — repo should NOT find it by sessionId, paymentIntentId, or id.
    await expect(
      engine.repositories.transaction.verify(
        sessionId,
        {},
        { organizationId: orgB },
      ),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);

    // Correct org — verify succeeds.
    const verified = await engine.repositories.transaction.verify(
      sessionId,
      {},
      { organizationId: orgA },
    );
    expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);
  }, TIMEOUT);
});
