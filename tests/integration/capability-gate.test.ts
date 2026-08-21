/**
 * THE FALSIFICATION for revenue's bind-time capability gate — which did not
 * exist until 2026-08-05.
 *
 * ## Why the gate was added
 *
 * Revenue is the money kernel, and five of its verbs are multi-document by
 * construction: `refund.repository` claims a refund, writes the refund row and
 * rolls the claim back on failure; `transaction.repository` settles a capture
 * and writes its allocation. All five call mongokit's `withTransaction` with NO
 * `allowFallback`. On a deployment that cannot start a transaction they
 * therefore threw at the FIRST capture or refund — in production, mid-payment —
 * instead of at boot. Every other money-adjacent kernel here (wallet, invoice,
 * ledger, purchase, promo, party) already refused that deployment at bind;
 * revenue was the gap.
 *
 * ## Why it could not have been written earlier
 *
 * `Repository#capabilities` was mongokit's STATIC `MONGOKIT_CAPABILITIES` with
 * `transactions` hard-coded `true`, so any gate would have been a tautology —
 * exactly the decoration AGENTS.md FAIL LOUD rule 4 describes. mongokit now
 * OBSERVES the live SDAM topology per connection, so the two servers below
 * genuinely disagree.
 */
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertRevenueCapabilities,
  defineRevenue,
  REVENUE_REQUIRED_CAPABILITIES,
  RevenueCapabilityError,
} from '@classytic/revenue';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let standalone: MongoMemoryServer;
let replset: MongoMemoryReplSet;
let standaloneConn: Connection;
let replsetConn: Connection;

const bindOn = (
  connection: Connection,
  opts: { allowNonTransactional?: boolean; warn?: (msg: string) => void } = {},
) =>
  defineRevenue({ scope: false, autoIndex: false, forceRecreate: true }).bind(connection, {
    defaultCurrency: 'USD',
    logger: { ...silentLogger, warn: (msg: unknown) => opts.warn?.(String(msg)) },
    ...(opts.allowNonTransactional !== undefined
      ? { allowNonTransactional: opts.allowNonTransactional }
      : {}),
  });

beforeAll(async () => {
  standalone = await MongoMemoryServer.create();
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  standaloneConn = await mongoose
    .createConnection(standalone.getUri('rev-cap-standalone'))
    .asPromise();
  replsetConn = await mongoose.createConnection(replset.getUri('rev-cap-replset')).asPromise();
}, 180_000);

afterAll(async () => {
  await standaloneConn?.close().catch(() => undefined);
  await replsetConn?.close().catch(() => undefined);
  await standalone?.stop().catch(() => undefined);
  await replset?.stop().catch(() => undefined);
});

describe('revenue bind-time capability gate — standalone vs replica set', () => {
  it('a REPLICA SET binds clean with no opt-in at all', async () => {
    const engine = bindOn(replsetConn);
    expect(engine.repositories.transaction.capabilities.transactions).toBe(true);
    await engine.close();
  });

  it('a STANDALONE mongod REFUSES to bind — money does not move on an unatomic backend', () => {
    let thrown: unknown;
    try {
      bindOn(standaloneConn);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RevenueCapabilityError);
    const err = thrown as RevenueCapabilityError;
    expect(err.missing).toEqual(['transactions']);
    expect(err.status).toBe(500);
    // An OBSERVED no ⇒ fix the deployment, not the bind order.
    expect(err.indeterminate).toBe(false);
    expect(err.message).toContain('does not support multi-document transactions');
    expect(err.message).toContain('replica set');
    expect(err.message).toContain('allowNonTransactional');
  });

  it('a STANDALONE binds when the runtime explicitly opts in — and warns about DOUBLE REFUND', async () => {
    const warnings: string[] = [];
    const engine = bindOn(standaloneConn, {
      allowNonTransactional: true,
      warn: (msg) => warnings.push(msg),
    });
    expect(engine.repositories.transaction.capabilities.transactions).toBe(false);
    expect(warnings.some((w) => w.includes('allowNonTransactional=true'))).toBe(true);
    expect(warnings.some((w) => w.includes('double refund'))).toBe(true);
    await engine.close();
  });

  it('allowNonTransactional: false is NOT an opt-in', () => {
    expect(() => bindOn(standaloneConn, { allowNonTransactional: false })).toThrow(
      RevenueCapabilityError,
    );
  });

  it('the observed standalone descriptor moved ONLY the deployment-dependent flags', () => {
    // Which is why waiving `transactions` cannot be quietly hiding a broken
    // backend: the idempotency contract is still intact.
    const engine = bindOn(standaloneConn, { allowNonTransactional: true });
    const caps = engine.repositories.transaction.capabilities;
    expect(caps.transactions).toBe(false);
    for (const flag of REVENUE_REQUIRED_CAPABILITIES) expect(caps[flag]).toBe(true);
    return engine.close();
  });
});

describe('unknown is not a yes (FAIL LOUD rule 3)', () => {
  it('an UNOPENED connection refuses, and is reported as INDETERMINATE not observed', () => {
    const unopened = mongoose.createConnection();
    let thrown: unknown;
    try {
      bindOn(unopened);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RevenueCapabilityError);
    const err = thrown as RevenueCapabilityError;
    expect(err.indeterminate).toBe(true);
    expect(err.message).toContain('could NOT be determined');
    expect(err.message).toContain('probeMongoCapabilities');
    // Their cluster may be fine and the BIND was simply too early — sending
    // them to "run a replica set" would be wrong advice.
    expect(err.message).not.toContain('Run MongoDB as a replica set');
  });
});

/**
 * The SECOND thing bind verifies (2026-08-05): an injected outbox that cannot
 * enlist `ctx.session`.
 *
 * `OutboxWriteOptions.session` is best-effort BY CONTRACT, so a hand-rolled host
 * store satisfies `OutboxStore` structurally and then persists a
 * `payment.succeeded` row for a capture the transaction rolled back. Revenue's
 * per-call `UnmanagedSessionError` cannot see this: it guards the opposite hole
 * (a session with NO outbox). Here a store IS present and `save()` resolves —
 * the only evidence is a downstream consumer acting on money that never moved.
 */
describe('outbox.transactionalSave — the boot gate on injected outboxes', () => {
  const store = (transactionalSave?: boolean) =>
    ({
      ...(transactionalSave === undefined ? {} : { transactionalSave }),
      save: async () => undefined,
      getPending: async () => [],
      acknowledge: async () => undefined,
    }) as never;

  const bindWithOutbox = (outbox: never) =>
    defineRevenue({ scope: false, autoIndex: false, forceRecreate: true }).bind(replsetConn, {
      defaultCurrency: 'USD',
      logger: silentLogger,
      outbox,
    });

  it('REFUSES a store that does not declare transactionalSave (the hand-rolled shape)', () => {
    expect(() => bindWithOutbox(store())).toThrow(RevenueCapabilityError);
  });

  it('REFUSES a store that declares it FALSE, and names the flag', () => {
    let thrown: unknown;
    try {
      bindWithOutbox(store(false));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RevenueCapabilityError);
    expect((thrown as RevenueCapabilityError).missing).toEqual(['outbox.transactionalSave']);
    // The database is not the problem — do not send the operator to fix it.
    expect((thrown as RevenueCapabilityError).message).not.toContain('replica set');
  });

  it('runs BEFORE the model blueprint binds — a refused bind registers no model', () => {
    const fresh = mongoose.createConnection();
    expect(() =>
      defineRevenue({ scope: false, autoIndex: false, forceRecreate: true }).bind(fresh, {
        defaultCurrency: 'USD',
        logger: silentLogger,
        outbox: store(false),
      }),
    ).toThrow(RevenueCapabilityError);
    expect(fresh.modelNames()).toEqual([]);
  });

  it('ACCEPTS a store that declares transactionalSave: true', async () => {
    const engine = bindWithOutbox(store(true));
    expect(engine.repositories.transaction).toBeDefined();
    await engine.close();
  });

  it('no outbox at all is still legal — the requirement is conditional', async () => {
    const engine = bindOn(replsetConn);
    expect(engine.repositories.transaction).toBeDefined();
    await engine.close();
  });
});

describe('the unwaivable half', () => {
  it('an ABSENT descriptor is refused even WITH the opt-in', () => {
    // A backend too old to declare capabilities is broken, not a deployment
    // choice — rule 5: never inherit a permissive default.
    expect(() => assertRevenueCapabilities({}, { allowNonTransactional: true })).toThrow(
      RevenueCapabilityError,
    );
  });

  it('duplicateKeyError / upsert are refused even WITH the opt-in', () => {
    for (const flag of REVENUE_REQUIRED_CAPABILITIES) {
      const caps = {
        transactions: true,
        upsert: true,
        duplicateKeyError: true,
        [flag]: false,
      } as never;
      let thrown: unknown;
      try {
        assertRevenueCapabilities({ capabilities: caps }, { allowNonTransactional: true });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(RevenueCapabilityError);
      expect((thrown as RevenueCapabilityError).missing).toEqual([flag]);
    }
  });
});
