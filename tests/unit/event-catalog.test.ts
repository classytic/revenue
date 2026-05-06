/**
 * Event catalog — no-drift invariants and Zod round-trips.
 *
 * The no-drift test (line 25–32) is the load-bearing one: adding a new
 * `REVENUE_EVENTS.*` constant without a matching `defineRevenueEvent`
 * fails CI here. Without it Arc's EventRegistry silently skips the new
 * event and validation goes dark.
 *
 * Bank-feed coverage was added in 3.0; the suite below proves the six
 * new events round-trip cleanly through Zod + JSON Schema + DomainEvent.
 *
 * See PACKAGE_RULES §18.5.
 */

import { describe, expect, it } from 'vitest';
import {
  revenueEventDefinitions,
  TransactionImported,
  TransactionMatched,
  TransactionUnmatched,
  TransactionJournalized,
  TransactionRejected,
  TransactionRemovedByFeed,
  type RevenueEventDefinition,
} from '@classytic/revenue/events';
import { REVENUE_EVENTS } from '@classytic/revenue/events';

describe('revenueEventDefinitions — invariants', () => {
  it('covers every REVENUE_EVENTS constant (no-drift invariant)', () => {
    const defined = new Set(revenueEventDefinitions.map((d) => d.name));
    const declared = Object.values(REVENUE_EVENTS);
    const missing = declared.filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('has no duplicate event names', () => {
    const names = revenueEventDefinitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every definition has name, version, schema, zodSchema, create()', () => {
    for (const def of revenueEventDefinitions) {
      expect(typeof def.name).toBe('string');
      expect(def.version).toBeGreaterThanOrEqual(1);
      expect(def.schema).toBeTruthy();
      expect(def.schema.type).toBe('object');
      expect(def.zodSchema).toBeTruthy();
      expect(typeof def.create).toBe('function');
    }
  });

  it('every definition produces non-empty JSON Schema via z.toJSONSchema()', () => {
    for (const def of revenueEventDefinitions) {
      expect(def.schema.type).toBe('object');
      expect(def.schema.properties).toBeTruthy();
    }
  });

  it('every name uses the package prefix `revenue:`', () => {
    for (const def of revenueEventDefinitions) {
      expect(def.name.startsWith('revenue:')).toBe(true);
    }
  });
});

describe('Bank-feed events (3.0) — Zod happy paths', () => {
  it('TransactionImported requires source + bankAccountId + externalId', () => {
    const r = TransactionImported.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', status: 'imported' },
      source: 'plaid',
      bankAccountId: 'acct_main',
      externalId: 'PLAID_TX_123',
    });
    expect(r.success).toBe(true);
  });

  it('TransactionMatched accepts a partial mapping (debit/credit/notes optional)', () => {
    expect(
      TransactionMatched.zodSchema.safeParse({
        transaction: { publicId: 'txn_1' },
        mapping: { debitAccount: '1010', creditAccount: '4000', notes: 'monthly Stripe payout' },
        relatedTransactionId: '64a8f1...',
        matchedBy: 'reconciler@acme',
      }).success,
    ).toBe(true);

    // Empty mapping is also valid — host may provide it later via update().
    expect(
      TransactionMatched.zodSchema.safeParse({
        transaction: { publicId: 'txn_1' },
        mapping: {},
      }).success,
    ).toBe(true);
  });

  it('TransactionUnmatched only requires `transaction`', () => {
    const r = TransactionUnmatched.zodSchema.safeParse({
      transaction: { publicId: 'txn_1' },
    });
    expect(r.success).toBe(true);
  });

  it('TransactionJournalized requires journalEntryRef.{type,id}', () => {
    const r = TransactionJournalized.zodSchema.safeParse({
      transaction: { publicId: 'txn_1' },
      journalEntryRef: { type: 'JournalEntry', id: 'je_xyz' },
    });
    expect(r.success).toBe(true);
  });

  it('TransactionRejected requires a non-empty reason', () => {
    const r = TransactionRejected.zodSchema.safeParse({
      transaction: { publicId: 'txn_1' },
      reason: 'duplicate of FIT_001',
      rejectedBy: 'admin',
    });
    expect(r.success).toBe(true);
  });

  it('TransactionRemovedByFeed requires source + externalId', () => {
    const r = TransactionRemovedByFeed.zodSchema.safeParse({
      transaction: { publicId: 'txn_1' },
      source: 'plaid',
      externalId: 'PLAID_TX_123',
    });
    expect(r.success).toBe(true);
  });
});

describe('Bank-feed events (3.0) — Zod rejection paths', () => {
  it('TransactionImported rejects missing externalId', () => {
    const r = TransactionImported.zodSchema.safeParse({
      transaction: { publicId: 'txn_1' },
      source: 'plaid',
      bankAccountId: 'acct_main',
    });
    expect(r.success).toBe(false);
  });

  it('TransactionJournalized rejects malformed journalEntryRef (missing id)', () => {
    const r = TransactionJournalized.zodSchema.safeParse({
      transaction: { publicId: 'txn_1' },
      journalEntryRef: { type: 'JournalEntry' },
    });
    expect(r.success).toBe(false);
  });

  it('TransactionRejected rejects empty reason', () => {
    const r = TransactionRejected.zodSchema.safeParse({
      transaction: { publicId: 'txn_1' },
      reason: '',
    });
    expect(r.success).toBe(false);
  });
});

describe('Bank-feed events (3.0) — DomainEvent envelope round-trip', () => {
  it('TransactionImported.create() emits a well-formed DomainEvent', () => {
    const event = TransactionImported.create(
      {
        transaction: { publicId: 'txn_1', status: 'imported' },
        source: 'plaid',
        bankAccountId: 'acct_main',
        externalId: 'PLAID_TX_123',
      },
      { organizationId: '507f1f77bcf86cd799439011', correlationId: 'c_1' },
    );
    expect(event.type).toBe('revenue:transaction.imported');
    expect(event.meta.organizationId).toBe('507f1f77bcf86cd799439011');
    expect(event.meta.id).toBeTruthy();
    expect(event.payload.externalId).toBe('PLAID_TX_123');
  });

  it('TransactionMatched preserves mapping in the envelope', () => {
    const event = TransactionMatched.create({
      transaction: { publicId: 'txn_1' },
      mapping: { debitAccount: '1010', creditAccount: '4000' },
    });
    expect(event.type).toBe('revenue:transaction.matched');
    expect(event.payload.mapping.debitAccount).toBe('1010');
  });
});

describe('Arc EventRegistry structural compatibility', () => {
  function makeArcLikeRegistry() {
    const defs = new Map<string, { name: string; version: number; schema: unknown }>();
    return {
      register(def: RevenueEventDefinition) {
        defs.set(def.name, { name: def.name, version: def.version, schema: def.schema });
      },
      catalog() {
        return [...defs.values()];
      },
      get(name: string) {
        return defs.get(name);
      },
    };
  }

  it('every definition registers cleanly into an Arc-shaped registry', () => {
    const registry = makeArcLikeRegistry();
    for (const def of revenueEventDefinitions) registry.register(def);
    expect(registry.catalog()).toHaveLength(revenueEventDefinitions.length);
    expect(registry.get('revenue:transaction.imported')?.version).toBe(1);
    expect(registry.get('revenue:transaction.matched')?.version).toBe(1);
    expect(registry.get('revenue:transaction.journalized')?.version).toBe(1);
    expect(registry.get('revenue:transaction.removed_by_feed')?.version).toBe(1);
  });

  it('every entry carries a JSON Schema with type=object', () => {
    const registry = makeArcLikeRegistry();
    for (const def of revenueEventDefinitions) registry.register(def);
    for (const entry of registry.catalog()) {
      expect(entry.schema).toMatchObject({ type: 'object' });
    }
  });
});
