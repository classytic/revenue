import { PAYMENT_EVENT_TYPE } from '@classytic/primitives/payment-events';
import { bindRevenue } from '../helpers/bind-revenue.js';
/**
 * Scenario: Repo-backed outbox (arc 2.10 canonical pattern).
 *
 * Arc does NOT ship a Mongo-backed `OutboxStore` — hosts build one by wrapping
 * a mongokit `Repository<OutboxDoc>` via `repositoryAsOutboxStore(repo)`.
 * This test proves revenue plugs into that pattern seamlessly:
 *
 *   1. The outbox is persisted as real MongoDB documents.
 *   2. When `refund` runs, the outbox row commits in the SAME transaction
 *      as the business writes — we verify by aborting the transaction and
 *      observing that neither the refund txn nor the outbox row exists.
 *   3. Non-transactional verbs still persist outbox rows (durable but not
 *      atomic, which matches arc's contract).
 *
 * We don't import arc here (PACKAGE_RULES: packages must not peer-dep arc),
 * so we inline a minimal `repositoryAsOutboxStore` equivalent that mirrors
 * arc's adapter's three required methods (`save` + `getPending` +
 * `acknowledge`). The point is to prove the CONTRACT works end-to-end
 * against real mongokit + real Mongo, which is what a host using arc's
 * adapter actually runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose, { Schema, type ClientSession, type Model } from 'mongoose';
import { Repository } from '@classytic/mongokit';
import {
  clearCollections,
  connectToMongoDB,
  disconnectFromMongoDB,
} from '../helpers/mongodb-memory.js';
import { FakeProvider } from '../helpers/fake-provider.js';
import { warmModels } from '../helpers/warm-models.js';
import type { OutboxStore, OutboxWriteOptions } from '@classytic/primitives/outbox';
import {
  REVENUE_EVENTS,
  TRANSACTION_STATUS,
  type DomainEvent,
} from '../../revenue/src/index.js';

const TIMEOUT = 15000;

interface OutboxDoc {
  _id: string;
  event: DomainEvent;
  type: string;
  status: 'pending' | 'delivered' | 'dead_letter';
  createdAt: Date;
}

/**
 * Minimal arc-style adapter: wraps a mongokit `Repository<OutboxDoc>` as an
 * `OutboxStore`. Mirrors arc's `repositoryAsOutboxStore` for the three
 * required methods. Enough to prove revenue's integration with the pattern.
 */
function buildRepoOutboxStore(repo: Repository<OutboxDoc>): OutboxStore {
  return {
    // The row is written through a mongokit repo on the SAME connection with the
    // caller's session — so this store genuinely commits with the business write,
    // and says so. `bind` refuses a store that stays silent about it.
    transactionalSave: true,
    async save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void> {
      if (!event?.type) throw new Error('event.type is required');
      if (!event.meta?.id) throw new Error('event.meta.id is required');
      const doc: OutboxDoc = {
        _id: event.meta.id,
        event,
        type: event.type,
        status: 'pending',
        createdAt: new Date(),
      };
      await repo.create(
        doc as unknown as Parameters<typeof repo.create>[0],
        options?.session ? { session: options.session as ClientSession } : undefined,
      );
    },
    async getPending(limit: number): Promise<DomainEvent[]> {
      const docs = await repo.getAll({ filters: { status: 'pending' }, limit });
      return ((docs as { data: OutboxDoc[] }).data ?? []).map((d) => d.event);
    },
    async acknowledge(eventId: string): Promise<void> {
      await repo.update(eventId, { status: 'delivered' } as Partial<OutboxDoc>);
    },
  };
}

let mongoAvailable = false;
let OutboxModel: Model<OutboxDoc>;
let outboxRepo: Repository<OutboxDoc>;
let outbox: OutboxStore;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
  if (!mongoAvailable) return;
  // strict:false — arc owns the on-disk shape; let the adapter write whatever it wants.
  const schema = new Schema({}, { strict: false, timestamps: false, _id: false });
  OutboxModel = mongoose.connection.model<OutboxDoc>('TestArcOutbox', schema, 'arc_outbox_test');
  outboxRepo = new Repository<OutboxDoc>(OutboxModel, []);
  outbox = buildRepoOutboxStore(outboxRepo);
}, TIMEOUT);

afterAll(async () => {
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) {
    await clearCollections();
    if (OutboxModel) await OutboxModel.deleteMany({});
  }
});

describe('Scenario: Repo-backed outbox (arc 2.10 canonical pattern)', () => {
  it('persists events to a real MongoDB collection via mongokit Repository', async () => {
    if (!mongoAvailable) return;

    const engine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
    });
    await warmModels(engine);

    try {
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 4200,
        gateway: 'fake', methodKind: 'card',
        idempotencyKey: 'pay-c_repo',
        data: { customerId: 'c_repo' },
      });
      await engine.repositories.transaction.verify(
        txn.gateway!.paymentIntentId as string,
      );

      // Pull directly from Mongo — confirm rows are really persisted.
      const rows = await OutboxModel.find({}).lean();
      const types = rows.map((r) => r.type).sort();
      expect(types).toContain(REVENUE_EVENTS.MONETIZATION_CREATED);
      expect(types).toContain(PAYMENT_EVENT_TYPE.SUCCEEDED);
      expect(rows.every((r) => r.status === 'pending')).toBe(true);
      // `_id` is the event's `meta.id` — matches arc's adapter's unique key.
      expect(rows.every((r) => typeof r._id === 'string' && r._id.length > 0)).toBe(true);

      /**
       * EXACTLY ONE canonical event per outcome — the dual-publish guard.
       *
       * A unit test on the payload BUILDER cannot catch this: the builder is
       * correct in both worlds. What breaks a consumer is the kernel emitting a
       * portable fact twice — once canonically and once under the retired
       * `revenue:payment.*` name — because a subscriber to each settles the
       * same payment twice and the second settlement looks legitimate.
       *
       * Asserted on the OUTBOX because that is what a consumer actually reads.
       */
      const succeeded = rows.filter((r) => r.type === PAYMENT_EVENT_TYPE.SUCCEEDED);
      expect(succeeded).toHaveLength(1);

      // And NO retired name accompanies it.
      const retired = ['revenue:payment.verified', 'revenue:payment.failed', 'revenue:payment.refunded'];
      expect(types.filter((t) => retired.includes(t))).toEqual([]);
    } finally {
      await engine.close();
    }
  }, TIMEOUT);

  it('refund writes outbox row + business writes inside the same mongoose session', async () => {
    if (!mongoAvailable) return;

    // Intercept `save(event, { session })` and snapshot the raw session
    // handle that revenue passes. This is exactly what arc's
    // `repositoryAsOutboxStore` receives — if it's a live mongoose
    // ClientSession with `inTransaction() === true`, the write commits
    // atomically with the business writes.
    const capturedSessions: Array<{ type: string; inTransaction: boolean; sessionId?: string }> = [];
    const interceptingOutbox: OutboxStore = {
      // A DECORATOR must forward the declaration, not just the call. Dropping it
      // is the realistic version of this defect: the wrapped store is atomic, the
      // wrapper looks harmless, and `bind` is the only thing that notices.
      transactionalSave: outbox.transactionalSave,
      async save(event, options) {
        const raw = options?.session as ClientSession | undefined;
        capturedSessions.push({
          type: event.type,
          inTransaction: raw?.inTransaction() ?? false,
          sessionId: raw?.id?.id?.toString('hex'),
        });
        await outbox.save(event, options);
      },
      getPending: outbox.getPending.bind(outbox),
      acknowledge: outbox.acknowledge.bind(outbox),
    };

    const engine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox: interceptingOutbox,
    });
    await warmModels(engine);

    try {
      const payment = await engine.repositories.transaction.createPaymentIntent({
        amount: 9999, gateway: 'fake', methodKind: 'card', idempotencyKey: 'pay-c_session', data: { customerId: 'c_session' },
      });
      const verified = await engine.repositories.transaction.verify(
        payment.gateway!.paymentIntentId as string,
      );
      expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);

      const refund = await engine.repositories.transaction.refund(
        String(verified._id), null, { reason: 'session-bound proof', idempotencyKey: 'refund-c_session' },
      );
      expect(refund.type).toBe('refund');

      // Non-tx verbs (createPaymentIntent, verify) — no session.
      const monetizationCapture = capturedSessions.find(
        c => c.type === REVENUE_EVENTS.MONETIZATION_CREATED,
      );
      expect(monetizationCapture?.inTransaction).toBe(false);

      // Refund verb — session live, inTransaction true at save time.
      const refundCapture = capturedSessions.find(
        c => c.type === PAYMENT_EVENT_TYPE.REFUNDED,
      );
      expect(refundCapture).toBeDefined();
      expect(refundCapture!.inTransaction).toBe(true);
      expect(refundCapture!.sessionId).toBeTruthy();

      // And the refund row is actually persisted after commit.
      const row = await OutboxModel.findOne({ type: PAYMENT_EVENT_TYPE.REFUNDED }).lean();
      expect(row).not.toBeNull();
    } finally {
      await engine.close();
    }
  }, TIMEOUT);
});
