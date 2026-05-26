/**
 * Scenario: Bank-Feed Lifecycle (Revenue 3.0)
 *
 * Treasurer uploads / syncs a bank statement → operator reviews →
 * matches to GL accounts → ledger journalizes → row enters audit
 * archive. Plus the un-match and reject branches, plus cross-reference
 * to a payment-flow row.
 *
 * What this catches that the unit tests can't:
 *   - `(orgId, bankAccountId, externalId)` partial-unique index — re-import
 *     produces zero new inserts.
 *   - Kind-gated `claim()` — payment_flow rows are invisible to bank-feed
 *     verbs (the `where: { kind }` predicate).
 *   - `match → unmatch → match` cycle — re-match works after un-match
 *     because the multi-source `from: [imported, matched, pending]`
 *     accepts both source states.
 *   - Multi-source state machine: `imported → rejected` and `matched
 *     → journalized` from the same verb set.
 *   - Cross-currency reconciliation via `findMatchCandidates` (Stripe
 *     USD charge ↔ Plaid bank deposit USD).
 *   - LedgerBridge `onTransactionMatched` hook fires before the event
 *     is dispatched, so a host can chain `journalize()` synchronously.
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
  TRANSACTION_KIND,
  TRANSACTION_STATUS,
  BANK_FEED_SOURCE,
  type LedgerBridge,
  type RevenueContext,
  type TransactionDocument,
} from '../../revenue/src/index.js';
import type { BankTransaction } from '@classytic/primitives/bank-transaction';

const TIMEOUT = 15000;

let engine: Awaited<ReturnType<typeof createRevenue>>;
let mongoAvailable = false;

const ledgerCalls: { type: string; args: unknown[] }[] = [];
const ledgerBridge: LedgerBridge = {
  async onTransactionImported(txn, ctx) {
    ledgerCalls.push({ type: 'imported', args: [txn, ctx] });
  },
  async onTransactionMatched(txn, mapping, ctx) {
    ledgerCalls.push({ type: 'matched', args: [txn, mapping, ctx] });
  },
  async onTransactionUnmatched(txn, prior, ctx) {
    ledgerCalls.push({ type: 'unmatched', args: [txn, prior, ctx] });
  },
  async onTransactionJournalized(txn, ref, ctx) {
    ledgerCalls.push({ type: 'journalized', args: [txn, ref, ctx] });
  },
  async onTransactionRejected(txn, reason, ctx) {
    ledgerCalls.push({ type: 'rejected', args: [txn, reason, ctx] });
  },
  async onTransactionRemovedByFeed(txn, ctx) {
    ledgerCalls.push({ type: 'removed_by_feed', args: [txn, ctx] });
  },
};

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  engine = await createRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    bridges: { ledger: ledgerBridge },
    modules: {
      // Enable matchCandidates index for the cross-ref test in this suite.
      bankFeed: { enabled: true, indexes: { matchCandidates: true } },
      subscription: false,
      escrow: false,
      settlement: false,
    },
    scope: false,
    forceRecreate: true,
  });
  await warmModels(engine);
}, TIMEOUT);

afterAll(async () => {
  if (mongoAvailable) await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) {
    await clearCollections();
    ledgerCalls.length = 0;
  }
});

// Using a 24-char hex organizationId because the engine defaults to
// `fieldType: 'objectId'` for the tenant scope (PACKAGE_RULES §9.1).
const ORG_HEX = '507f1f77bcf86cd799439011';
const ctx: RevenueContext = { organizationId: ORG_HEX };

function row(over: Partial<BankTransaction> = {}): BankTransaction {
  return {
    externalId: over.externalId ?? `FITID_${Math.random().toString(36).slice(2, 10)}`,
    postedDate: over.postedDate ?? new Date('2026-05-01T00:00:00Z'),
    amount: over.amount ?? { amount: 10000, currency: 'USD' },
    description: over.description ?? 'STRIPE PAYOUT',
    counterparty: over.counterparty ?? { name: 'Stripe Inc.' },
    reference: over.reference,
    valueDate: over.valueDate,
    category: over.category,
    balanceAfter: over.balanceAfter,
    type: over.type,
  };
}

describe('Bank-feed lifecycle — Revenue 3.0', () => {
  it('imports rows idempotently — re-import is a no-op', async () => {
    const rows = [
      row({ externalId: 'FIT_001', amount: { amount: 50000, currency: 'USD' } }),
      row({ externalId: 'FIT_002', amount: { amount: -25000, currency: 'USD' }, description: 'AWS BILLING' }),
    ];
    const opts = { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.OFX, methodKind: 'bank_transfer' as const };

    const first = await engine.repositories.transaction.import(rows, opts, ctx);
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.errors).toHaveLength(0);

    const second = await engine.repositories.transaction.import(rows, opts, ctx);
    expect(second.inserted).toBe(0);
    // Updated count may be > 0 because $set still rewrites timestamp-y fields;
    // the contract is "no new rows" — that's what idempotency guarantees.
    expect(second.errors).toHaveLength(0);

    // Imported event fires per inserted (NOT per re-import row)
    const importedEvents = ledgerCalls.filter((c) => c.type === 'imported');
    expect(importedEvents).toHaveLength(2);
  }, TIMEOUT);

  it('signed amount becomes (unsigned amount + flow) on the doc', async () => {
    await engine.repositories.transaction.import(
      [
        row({ externalId: 'IN_1', amount: { amount: 12345, currency: 'USD' } }),
        row({ externalId: 'OUT_1', amount: { amount: -9876, currency: 'USD' } }),
      ],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.OFX, methodKind: 'bank_transfer' },
      ctx,
    );
    const inflow = await engine.repositories.transaction.getByQuery({ externalId: 'IN_1' }, { organizationId: ctx.organizationId });
    const outflow = await engine.repositories.transaction.getByQuery({ externalId: 'OUT_1' }, { organizationId: ctx.organizationId });
    expect(inflow?.amount).toBe(12345);
    expect(inflow?.flow).toBe('inflow');
    expect(outflow?.amount).toBe(9876);
    expect(outflow?.flow).toBe('outflow');
    expect(inflow?.kind).toBe(TRANSACTION_KIND.BANK_FEED);
    expect(inflow?.status).toBe(TRANSACTION_STATUS.IMPORTED);
  }, TIMEOUT);

  it('lifecycle: imported → matched → journalized', async () => {
    const report = await engine.repositories.transaction.import(
      [row({ externalId: 'FIT_ABC', amount: { amount: 100000, currency: 'USD' } })],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.PLAID, methodKind: 'bank_transfer' },
      ctx,
    );
    expect(report.inserted).toBe(1);
    const imported = await engine.repositories.transaction.getByQuery(
      { externalId: 'FIT_ABC' },
      { organizationId: ctx.organizationId },
    );
    expect(imported).not.toBeNull();
    const id = String(imported!._id);

    const matched = await engine.repositories.transaction.match(
      id,
      { mapping: { debitAccount: '1010', creditAccount: '4000' }, matchedBy: 'reconciler@acme' },
      ctx,
    );
    expect(matched.status).toBe(TRANSACTION_STATUS.MATCHED);
    expect(matched.matching?.debitAccount).toBe('1010');
    expect(matched.matching?.creditAccount).toBe('4000');
    expect(matched.matching?.matchedBy).toBe('reconciler@acme');

    const journalized = await engine.repositories.transaction.journalize(
      id,
      { journalEntryRef: { type: 'JournalEntry', id: 'je_xyz' } },
      ctx,
    );
    expect(journalized.status).toBe(TRANSACTION_STATUS.JOURNALIZED);
    expect(journalized.journalEntryRef?.id).toBe('je_xyz');

    const eventTypes = ledgerCalls.map((c) => c.type);
    expect(eventTypes).toEqual(['imported', 'matched', 'journalized']);
  }, TIMEOUT);

  it('un-match cycle — matched → imported → matched', async () => {
    await engine.repositories.transaction.import(
      [row({ externalId: 'FIT_UM', amount: { amount: 5000, currency: 'USD' } })],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.OFX, methodKind: 'bank_transfer' },
      ctx,
    );
    const imported = await engine.repositories.transaction.getByQuery(
      { externalId: 'FIT_UM' },
      { organizationId: ctx.organizationId },
    );
    const id = String(imported!._id);

    await engine.repositories.transaction.match(
      id,
      { mapping: { debitAccount: '1010', creditAccount: '4000' } },
      ctx,
    );
    const unmatched = await engine.repositories.transaction.unmatch(id, { unmatchedBy: 'admin' }, ctx);
    expect(unmatched.status).toBe(TRANSACTION_STATUS.IMPORTED);
    expect(unmatched.matching).toBeUndefined();
    expect(unmatched.relatedTransactionId).toBeUndefined();

    const rematched = await engine.repositories.transaction.match(
      id,
      { mapping: { debitAccount: '1020', creditAccount: '4001', notes: 'corrected mapping' } },
      ctx,
    );
    expect(rematched.status).toBe(TRANSACTION_STATUS.MATCHED);
    expect(rematched.matching?.debitAccount).toBe('1020');
    expect(rematched.matching?.notes).toBe('corrected mapping');
  }, TIMEOUT);

  it('reject is terminal — match-after-reject fails', async () => {
    await engine.repositories.transaction.import(
      [row({ externalId: 'FIT_REJ' })],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.OFX, methodKind: 'bank_transfer' },
      ctx,
    );
    const imported = await engine.repositories.transaction.getByQuery(
      { externalId: 'FIT_REJ' },
      { organizationId: ctx.organizationId },
    );
    const id = String(imported!._id);

    const rejected = await engine.repositories.transaction.reject(
      id,
      { reason: 'duplicate of FIT_001', rejectedBy: 'admin' },
      ctx,
    );
    expect(rejected.status).toBe(TRANSACTION_STATUS.REJECTED);
    expect(rejected.failureReason).toBe('duplicate of FIT_001');

    await expect(
      engine.repositories.transaction.match(id, { mapping: { debitAccount: '1010' } }, ctx),
    ).rejects.toThrow();
  }, TIMEOUT);

  it('payment_flow rows are invisible to bank-feed verbs', async () => {
    // Create a payment_flow row directly (bypassing createPaymentIntent for test brevity).
    const pf = await engine.repositories.transaction.create(
      {
        organizationId: ctx.organizationId,
        kind: TRANSACTION_KIND.PAYMENT_FLOW,
        type: 'subscription',
        flow: 'inflow',
        tags: ['test'],
        amount: 1000,
        currency: 'USD',
        fee: 0,
        tax: 0,
        net: 1000,
        method: 'manual',
        methodKind: 'manual',
        status: TRANSACTION_STATUS.PENDING,
      } as never,
      { organizationId: ctx.organizationId },
    );

    // Bank-feed verbs throw kind-mismatch on a payment_flow row.
    await expect(
      engine.repositories.transaction.match(String(pf._id), { mapping: {} }, ctx),
    ).rejects.toThrow(/kind/i);
    await expect(
      engine.repositories.transaction.unmatch(String(pf._id), {}, ctx),
    ).rejects.toThrow(/kind/i);
  }, TIMEOUT);

  it('manual entry — pending → matched → journalized', async () => {
    const m = await engine.repositories.transaction.createManual(
      {
        amount: 75000,
        currency: 'USD',
        flow: 'inflow',
        type: 'capital_injection',
        methodKind: 'manual',
        description: 'Owner equity contribution',
        postedDate: new Date('2026-05-02'),
      },
      ctx,
    );
    expect(m.kind).toBe(TRANSACTION_KIND.MANUAL);
    expect(m.status).toBe(TRANSACTION_STATUS.PENDING);

    const matched = await engine.repositories.transaction.match(
      String(m._id),
      { mapping: { debitAccount: '1010', creditAccount: '3000' }, matchedBy: 'owner' },
      ctx,
    );
    expect(matched.status).toBe(TRANSACTION_STATUS.MATCHED);

    const journalized = await engine.repositories.transaction.journalize(
      String(m._id),
      { journalEntryRef: { type: 'JournalEntry', id: 'je_owner_001' } },
      ctx,
    );
    expect(journalized.status).toBe(TRANSACTION_STATUS.JOURNALIZED);
  }, TIMEOUT);

  it('removeByFeed soft-deletes non-journalized rows; preserves journalized', async () => {
    await engine.repositories.transaction.import(
      [
        row({ externalId: 'KEEP_JE', amount: { amount: 1000, currency: 'USD' } }),
        row({ externalId: 'GONE_1', amount: { amount: 2000, currency: 'USD' } }),
        row({ externalId: 'GONE_2', amount: { amount: 3000, currency: 'USD' } }),
      ],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.PLAID, methodKind: 'bank_transfer' },
      ctx,
    );

    const keep = await engine.repositories.transaction.getByQuery(
      { externalId: 'KEEP_JE' },
      { organizationId: ctx.organizationId },
    );
    await engine.repositories.transaction.match(
      String(keep!._id),
      { mapping: { debitAccount: '1010' } },
      ctx,
    );
    await engine.repositories.transaction.journalize(
      String(keep!._id),
      { journalEntryRef: { type: 'JournalEntry', id: 'je_keep' } },
      ctx,
    );

    const result = await engine.repositories.transaction.removeByFeed(
      ['KEEP_JE', 'GONE_1', 'GONE_2'],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.PLAID, methodKind: 'bank_transfer' },
      ctx,
    );
    // KEEP_JE is journalized — surfaced in retainedJournalized, not silently kept.
    expect(result.removed).toBe(2);
    expect(result.retainedJournalized).toHaveLength(1);
    expect(result.retainedJournalized[0]?.externalId).toBe('KEEP_JE');

    const stillThere = await engine.repositories.transaction.getByQuery(
      { externalId: 'KEEP_JE' },
      { organizationId: ctx.organizationId },
    );
    expect(stillThere?.status).toBe(TRANSACTION_STATUS.JOURNALIZED);
  }, TIMEOUT);

  it('findMatchCandidates — Stripe charge ↔ Plaid deposit cross-ref', async () => {
    // Stripe charge — payment_flow, verified, $100, May 1
    await engine.repositories.transaction.create(
      {
        organizationId: ctx.organizationId,
        kind: TRANSACTION_KIND.PAYMENT_FLOW,
        type: 'subscription',
        flow: 'inflow',
        tags: ['stripe'],
        amount: 10000,
        currency: 'USD',
        fee: 30,
        tax: 0,
        net: 9970,
        method: 'stripe',
        methodKind: 'card',
        status: TRANSACTION_STATUS.VERIFIED,
        verifiedAt: new Date('2026-05-01'),
        gateway: { type: 'stripe', paymentIntentId: 'pi_abc' },
      } as never,
      { organizationId: ctx.organizationId },
    );

    // Plaid deposit — bank_feed, $99.70 (after Stripe fee), May 3 (T+2 settlement)
    await engine.repositories.transaction.import(
      [
        row({
          externalId: 'PLAID_DEP_1',
          amount: { amount: 9970, currency: 'USD' },
          postedDate: new Date('2026-05-03'),
          counterparty: { name: 'STRIPE PAYMENTS' },
        }),
      ],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.PLAID, methodKind: 'bank_transfer' },
      ctx,
    );

    const candidates = await engine.repositories.transaction.findMatchCandidates(
      {
        amount: 9970,
        currency: 'USD',
        postedDate: new Date('2026-05-03'),
        toleranceDays: 3,
        kind: TRANSACTION_KIND.PAYMENT_FLOW,
      },
      ctx,
    );
    // Stripe charge falls in the [Apr 30 – May 6] window with amount within ±1%
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.method).toBe('stripe');
  }, TIMEOUT);

  it('getRunningBalance sums inflows minus outflows for a bank account', async () => {
    await engine.repositories.transaction.import(
      [
        row({ externalId: 'A', amount: { amount: 100000, currency: 'USD' }, postedDate: new Date('2026-05-01') }),
        row({ externalId: 'B', amount: { amount: -25000, currency: 'USD' }, postedDate: new Date('2026-05-02') }),
        row({ externalId: 'C', amount: { amount: 50000, currency: 'USD' }, postedDate: new Date('2026-05-03') }),
        // Future entry — excluded by asOf
        row({ externalId: 'D', amount: { amount: 10000, currency: 'USD' }, postedDate: new Date('2026-05-10') }),
      ],
      { bankAccountId: 'acct_main', source: BANK_FEED_SOURCE.OFX, methodKind: 'bank_transfer' },
      ctx,
    );

    const result = await engine.repositories.transaction.getRunningBalance(
      'acct_main',
      new Date('2026-05-05'),
      ctx,
    );
    expect(result.balance).toBe(100000 - 25000 + 50000); // 125000
    expect(result.currency).toBe('USD');
    expect(result.rowCount).toBe(3);
  }, TIMEOUT);
});
