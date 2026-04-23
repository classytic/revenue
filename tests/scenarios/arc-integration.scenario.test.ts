/**
 * Scenario: Arc integration parity.
 *
 * Proves revenue's repositories + event transport + outbox integrate with
 * `@classytic/arc` via structural compatibility — no adapters, no shims.
 * PACKAGE_RULES §11 / §13 / §14 demand this so a host using arc's
 * `defineResource`, `createMongooseAdapter`, and `EventOutbox` can drop in
 * revenue without branching.
 *
 * What this test pins:
 *
 *  1. `TransactionRepository` implements arc's structural `RepositoryLike`
 *     contract — `getAll`, `getById`, `create`, `update`, `delete` plus
 *     optional `getByQuery`, `count`, `exists`, `findOneAndUpdate`.
 *  2. Revenue's events carry the `DomainEvent { type, payload, meta }`
 *     shape arc expects, with stable `meta.id` (needed for outbox dedupe
 *     and at-least-once ack), `meta.timestamp`, and `meta.resource`/`resourceId`.
 *  3. Revenue subscribes to glob patterns (`revenue:payment.*`) just like
 *     arc's `MemoryEventTransport.subscribe`.
 *  4. When a host wires arc's `OutboxStore` (represented here by a minimal
 *     arc-contract-compatible store), revenue's `refund` path commits the
 *     outbox row atomically with the business writes via the mongoose
 *     session (P8 session-bound save).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientSession } from 'mongoose';
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
  REVENUE_EVENTS,
  TRANSACTION_STATUS,
  type DomainEvent,
  type OutboxStore,
  type OutboxWriteOptions,
} from '../../revenue/src/index.js';

const TIMEOUT = 15000;

/**
 * Minimal `OutboxStore` that records `save(event, { session })` calls as a
 * host-side arc `MongoOutboxStore` would. Captures whether a mongoose
 * session was passed — we assert it is NON-NULL for refund (session-bound)
 * and NULL for non-transactional verbs.
 */
class SessionRecordingOutbox implements OutboxStore {
  readonly saves: Array<{ event: DomainEvent; sessionBound: boolean }> = [];

  async save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void> {
    this.saves.push({
      event,
      sessionBound: options?.session !== undefined && options.session !== null,
    });
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    return this.saves.slice(0, limit).map(s => s.event);
  }

  async acknowledge(): Promise<void> {
    /* noop */
  }
}

let mongoAvailable = false;

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
}, TIMEOUT);

afterAll(async () => {
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
});

describe('Scenario: Arc integration parity', () => {
  it('TransactionRepository structurally satisfies arc\'s RepositoryLike', async () => {
    if (!mongoAvailable) return;
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
    });
    await warmModels(engine);
    try {
      const repo = engine.repositories.transaction;
      // MinimalRepo<TDoc>
      expect(typeof repo.getAll).toBe('function');
      expect(typeof repo.getById).toBe('function');
      expect(typeof repo.create).toBe('function');
      expect(typeof repo.update).toBe('function');
      expect(typeof repo.delete).toBe('function');
      // StandardRepo<TDoc> optional methods arc feature-detects
      expect(typeof repo.getByQuery).toBe('function');
      expect(typeof repo.count).toBe('function');
      expect(typeof repo.exists).toBe('function');
      expect(typeof repo.findOneAndUpdate).toBe('function');
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('emits events with arc-compatible DomainEvent shape (type + meta.id + meta.resource)', async () => {
    if (!mongoAvailable) return;
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
    });
    await warmModels(engine);
    try {
      const seen: DomainEvent[] = [];
      const unsubscribe = await engine.events.subscribe('revenue:payment.*', (e) => {
        seen.push(e);
      });
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 2500,
        gateway: 'fake',
        data: { customerId: 'cust_arc' },
      });
      await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
      unsubscribe();

      // A `payment.verified` must have arrived via the glob subscriber.
      const verified = seen.find(e => e.type === REVENUE_EVENTS.PAYMENT_VERIFIED);
      expect(verified).toBeDefined();
      expect(verified!.meta.id).toMatch(/.+/);
      expect(verified!.meta.timestamp).toBeInstanceOf(Date);
      expect(verified!.meta.resource).toBe('transaction');
      expect(verified!.meta.resourceId).toBeTruthy();
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('refund runs outbox.save session-bound so the event commits with the business writes', async () => {
    if (!mongoAvailable) return;

    const outbox = new SessionRecordingOutbox();
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
    });
    await warmModels(engine);

    try {
      const payment = await engine.repositories.transaction.createPaymentIntent({
        amount: 10_000, gateway: 'fake', data: { customerId: 'cust_refund' },
      });
      const verified = await engine.repositories.transaction.verify(
        payment.gateway!.paymentIntentId as string,
      );
      expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);

      const refund = await engine.repositories.transaction.refund(
        String(verified._id),
        null,
        { reason: 'requested_by_customer' },
      );
      expect(refund.type).toBe('refund');

      // Find the refund event — it must have been saved session-bound.
      const refundEntry = outbox.saves.find(
        s => s.event.type === REVENUE_EVENTS.PAYMENT_REFUNDED,
      );
      expect(refundEntry).toBeDefined();
      expect(refundEntry!.sessionBound).toBe(true);
      expect((refundEntry!.event.payload as { refundAmount?: number }).refundAmount).toBe(10_000);

      // Meanwhile `payment.verified` came through a non-tx dispatch — no session.
      const verifiedEntry = outbox.saves.find(
        s => s.event.type === REVENUE_EVENTS.PAYMENT_VERIFIED,
      );
      expect(verifiedEntry).toBeDefined();
      expect(verifiedEntry!.sessionBound).toBe(false);
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('accepts a session-bearing ctx and threads it into outbox.save for non-tx verbs', async () => {
    if (!mongoAvailable) return;

    const outbox = new SessionRecordingOutbox();
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
    });
    await warmModels(engine);

    try {
      // Host-driven transaction (mongokit's module-level helper is what
      // arc's handlers use when coordinating writes across repos).
      const session: ClientSession = await mongoose.connection.startSession();
      try {
        await session.withTransaction(async () => {
          await engine.repositories.transaction.createPaymentIntent(
            {
              amount: 1234,
              gateway: 'fake',
              data: { customerId: 'cust_host_tx' },
            },
            { actorId: 'test', session },
          );
        });
      } finally {
        await session.endSession();
      }

      const created = outbox.saves.find(
        s => s.event.type === REVENUE_EVENTS.MONETIZATION_CREATED,
      );
      expect(created).toBeDefined();
      expect(created!.sessionBound).toBe(true);
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);
});
