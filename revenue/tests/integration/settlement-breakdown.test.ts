/**
 * `breakdownByRecipient` is bounded by construction.
 *
 * It groups every settlement row its filter matches, which is inherent to the
 * question ("who is owed what") and fine — what is not fine is an unbounded
 * RESULT and an unbounded `$group` on a page-load path. A platform with a
 * hundred thousand payees is exactly the deployment that wants this view and
 * exactly the one it falls over on, late and in production.
 *
 * The cases that matter:
 *   • a default call returns at most `DEFAULT_BREAKDOWN_LIMIT` recipients,
 *   • `after` pages through the rest without dropping or repeating one,
 *   • and — the subtle one — a limit never cuts a recipient in HALF. The first
 *     group emits a row per status, so limiting there would return a recipient
 *     whose numbers are silently too low.
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

interface Breakdown {
  recipientId: string;
  recipientType: string;
  pending: number;
  available: number;
  paidOut: number;
  lifetime: number;
}

let mongod: MongoMemoryServer;
let Settlement: mongoose.Model<Record<string, unknown>>;
let repo: {
  breakdownByRecipient: (
    filter?: Record<string, unknown>,
    ctx?: Record<string, unknown>,
    options?: { limit?: number; after?: string; all?: boolean },
  ) => Promise<Breakdown[]>;
};
let DEFAULT_BREAKDOWN_LIMIT: number;

const PAST = new Date('2026-01-01T00:00:00.000Z');

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'revenue-breakdown' });

  const mod = await import('../../src/repositories/settlement.repository.js');
  const { buildSettlementSchema } = await import('../../src/models/settlement.schema.js');
  DEFAULT_BREAKDOWN_LIMIT = mod.DEFAULT_BREAKDOWN_LIMIT;

  const schema = buildSettlementSchema({ scoped: false } as never);
  Settlement = mongoose.model('BreakdownSettlement', schema as never) as never;

  const built = new (mod.SettlementRepository as never as new (...a: unknown[]) => Record<
    string,
    unknown
  >)(Settlement as never);
  (built as { inject?: (d: unknown) => void }).inject?.({ bridges: {}, outbox: undefined });
  repo = built as never;
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await Settlement.deleteMany({});
});

/** A settlement row — the fields the rollup reads, plus the ones the schema requires. */
const row = (recipientId: string, status: string, amount: number) => ({
  recipientId,
  recipientType: 'user',
  type: 'earning',
  payoutMethod: 'bank_transfer',
  status,
  amount,
  currency: 'USD',
  scheduledAt: PAST,
  metadata: { role: 'creator_earning' },
});

/** `r-007` — zero-padded so lexical order matches numeric order, as the cursor does. */
const id = (n: number) => `r-${String(n).padStart(4, '0')}`;

describe('breakdownByRecipient', () => {
  it('never returns more recipients than the default limit', async () => {
    await Settlement.insertMany(
      Array.from({ length: DEFAULT_BREAKDOWN_LIMIT + 25 }, (_, i) =>
        row(id(i), 'pending', 100),
      ) as never,
    );
    const page = await repo.breakdownByRecipient();
    expect(page).toHaveLength(DEFAULT_BREAKDOWN_LIMIT);
  });

  it('pages through every recipient exactly once', async () => {
    const total = 25;
    await Settlement.insertMany(
      Array.from({ length: total }, (_, i) => row(id(i), 'pending', 100)) as never,
    );

    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Breakdown[] = await repo.breakdownByRecipient(
        {},
        {},
        after === undefined ? { limit: 10 } : { limit: 10, after },
      );
      seen.push(...page.map((r) => r.recipientId));
      if (page.length < 10) break;
      after = page[page.length - 1]!.recipientId;
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // Ordered by recipientId, which is what makes `after` a cursor and not a guess.
    expect(seen).toEqual([...seen].sort());
  });

  it('never cuts a recipient in half at the limit boundary', async () => {
    // Each recipient has THREE status buckets. Limiting the per-status group
    // would return a last recipient missing two of them — a row that is present
    // and quietly wrong, which is worse than a row that is absent.
    for (let i = 0; i < 5; i += 1) {
      await Settlement.insertMany([
        row(id(i), 'pending', 100),
        row(id(i), 'processing', 200),
        row(id(i), 'completed', 300),
      ] as never);
    }

    const page = await repo.breakdownByRecipient({}, {}, { limit: 2 });
    expect(page).toHaveLength(2);
    for (const r of page) {
      // pending(100) is due (scheduledAt in the past) so it lands in `available`.
      expect(r.available).toBe(100);
      expect(r.paidOut).toBe(300);
      expect(r.lifetime).toBe(100 + 200 + 300);
    }
  });

  it('returns everything under `all`', async () => {
    await Settlement.insertMany(
      Array.from({ length: DEFAULT_BREAKDOWN_LIMIT + 25 }, (_, i) =>
        row(id(i), 'pending', 100),
      ) as never,
    );
    const everything = await repo.breakdownByRecipient({}, {}, { all: true });
    expect(everything).toHaveLength(DEFAULT_BREAKDOWN_LIMIT + 25);
  });

  it('refuses `all` together with `limit` rather than picking one', async () => {
    await expect(
      repo.breakdownByRecipient({}, {}, { all: true, limit: 10 }),
    ).rejects.toThrow(/either `all: true` or `limit`/);
  });

  it('still honours the caller filter while paging', async () => {
    await Settlement.insertMany([
      row(id(1), 'pending', 100),
      row(id(2), 'completed', 100),
      row(id(3), 'pending', 100),
    ] as never);
    const pending = await repo.breakdownByRecipient({ status: 'pending' }, {}, { limit: 10 });
    expect(pending.map((r) => r.recipientId)).toEqual([id(1), id(3)]);
  });
});
