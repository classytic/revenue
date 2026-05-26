/**
 * Probe — confirms `multiTenantPlugin` is wired on the transaction repo
 * by asserting the plugin throws on missing `organizationId` for both
 * the existing CRUD operations AND the new bank-feed verbs.
 *
 * The default revenue tenant config is `{ enabled: true, required: true }`
 * (PACKAGE_RULES §9). Without `ctx.organizationId`, every read/write
 * must throw `Missing 'organizationId'` — silent fallthrough is a
 * cross-tenant leak. This probe is the canary.
 *
 * Coverage matrix:
 *   - CRUD reads (findAll) — sanity check the plugin is mounted
 *   - import()  — bulk upsert via bulkWrite
 *   - match()   — atomic claim() with kind-gated where
 *   - journalize() / reject() / unmatch() — claim()-based state CAS
 *   - removeByFeed() — soft-delete pipeline
 *   - createManual() — direct create()
 *   - getRunningBalance() / findMatchCandidates() — read aggregations
 *
 * Each verb is exercised through the public API; if any forgets to
 * thread tenant scope (e.g. uses `Model.find()` directly bypassing
 * mongokit's hook stack), this test fails with no error or with a
 * different error class.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';
import {
  createRevenue,
  BANK_FEED_SOURCE,
  type RevenueContext,
} from '../../revenue/src/index.js';
import type { BankTransaction } from '@classytic/primitives/bank-transaction';

const TIMEOUT = 15000;

let engine: Awaited<ReturnType<typeof createRevenue>>;
let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  // Default scope (enabled, required) — the probe relies on this.
  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    modules: { bankFeed: true, subscription: false, escrow: false, settlement: false },
    forceRecreate: true,
  });
  await warmModels(engine);
}, TIMEOUT);

afterAll(async () => {
  if (mongoAvailable) await disconnectFromMongoDB();
});

const emptyCtx: RevenueContext = {};
const FAKE_ID = '507f1f77bcf86cd799439011';

function row(over: Partial<BankTransaction> = {}): BankTransaction {
  return {
    externalId: over.externalId ?? `FITID_PROBE_${Math.random().toString(36).slice(2, 8)}`,
    postedDate: over.postedDate ?? new Date('2026-05-01T00:00:00Z'),
    amount: over.amount ?? { amount: 1000, currency: 'USD' },
    description: over.description ?? 'PROBE',
  };
}

describe('multiTenantPlugin wiring probe — transaction repo (revenue 3.0)', () => {
  it('throws on transaction.findAll without organizationId', async () => {
    await expect(
      engine.repositories.transaction.findAll({}, {}),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on transaction.getAll without organizationId', async () => {
    await expect(
      engine.repositories.transaction.getAll({ filters: {} }, {}),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on import() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.import(
        [row()],
        { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.OFX, methodKind: 'bank_transfer' },
        emptyCtx,
      ),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on match() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.match(
        FAKE_ID,
        { mapping: { debitAccount: '1010' } },
        emptyCtx,
      ),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on journalize() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.journalize(
        FAKE_ID,
        { journalEntryRef: { type: 'JournalEntry', id: 'je_x' } },
        emptyCtx,
      ),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on unmatch() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.unmatch(FAKE_ID, {}, emptyCtx),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on reject() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.reject(
        FAKE_ID,
        { reason: 'duplicate' },
        emptyCtx,
      ),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on createManual() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.createManual(
        {
          amount: 1000,
          currency: 'USD',
          flow: 'inflow',
          type: 'capital_injection',
          methodKind: 'manual',
        },
        emptyCtx,
      ),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on removeByFeed() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.removeByFeed(
        ['FIT_999'],
        { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.PLAID },
        emptyCtx,
      ),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on findMatchCandidates() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.findMatchCandidates(
        { amount: 1000, postedDate: new Date('2026-05-01') },
        emptyCtx,
      ),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);

  it('throws on getRunningBalance() without organizationId', async () => {
    await expect(
      engine.repositories.transaction.getRunningBalance('acct_main', new Date(), emptyCtx),
    ).rejects.toThrow(/organizationId/i);
  }, TIMEOUT);
});
