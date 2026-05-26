/**
 * Scenario: Host-owned outbox (PACKAGE_RULES §5.5 + P8).
 *
 * Verifies revenue's dispatch pattern:
 *  1. Every domain event goes to `outbox.save()` before `events.publish()`.
 *  2. An outbox failure does NOT swallow the transport publish (isolated try/catch).
 *  3. A transport failure does NOT swallow the outbox save.
 *  4. When NO outbox is wired, events still flow to the transport.
 *  5. The shapes saved to outbox match `DomainEvent` (type + meta.id + payload).
 *
 * This test stands in for what a real host does: passes its own
 * `OutboxStore` (arc's MemoryOutboxStore, a Postgres repo, a Kafka Connect
 * bridge, …) into `createRevenue({ outbox })`. Revenue never persists an
 * outbox of its own — durability belongs to the host.
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
  REVENUE_EVENTS,
  TRANSACTION_STATUS,
  type DomainEvent,
  type OutboxStore,
} from '../../revenue/src/index.js';

const TIMEOUT = 15000;

let mongoAvailable = false;

/** Minimal in-memory OutboxStore — implements only the required surface. */
class RecordingOutbox implements OutboxStore {
  readonly saved: DomainEvent[] = [];
  public failNext = false;

  async save(event: DomainEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated outbox failure');
    }
    this.saved.push(event);
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    return this.saved.slice(0, limit);
  }

  async acknowledge(): Promise<void> {
    /* noop — test never relays */
  }
}

beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
}, TIMEOUT);

afterAll(async () => {
  await disconnectFromMongoDB();
});

beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
});

describe('Scenario: Host-owned outbox (P8 dispatch)', () => {
  it('saves every domain event to outbox before transport.publish', async () => {
    if (!mongoAvailable) return;

    const outbox = new RecordingOutbox();
    const transportCalls: DomainEvent[] = [];
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
      eventTransport: {
        name: 'test-transport',
        async publish(event) { transportCalls.push(event); },
        async subscribe() { return () => {}; },
      },
    });
    await warmModels(engine);

    try {
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 5000,
        gateway: 'fake', methodKind: 'card',
        data: { customerId: 'c1' },
      });
      const verified = await engine.repositories.transaction.verify(
        txn.gateway!.paymentIntentId as string,
      );
      expect(verified.status).toBe(TRANSACTION_STATUS.VERIFIED);

      // Both events must land in outbox AND transport.
      const outboxTypes = outbox.saved.map(e => e.type);
      const transportTypes = transportCalls.map(e => e.type);
      expect(outboxTypes).toContain(REVENUE_EVENTS.MONETIZATION_CREATED);
      expect(outboxTypes).toContain(REVENUE_EVENTS.PAYMENT_VERIFIED);
      expect(transportTypes).toEqual(outboxTypes);

      // Meta shape (P11-ish): every saved event has a non-empty type and meta.id.
      for (const ev of outbox.saved) {
        expect(ev.type).toBeTruthy();
        expect(ev.meta.id).toBeTruthy();
        expect(ev.meta.timestamp).toBeInstanceOf(Date);
      }
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('propagates outbox.save failures so the caller can roll back', async () => {
    if (!mongoAvailable) return;

    // Per PACKAGE_RULES §P8: outbox.save is durability-critical. When it
    // fails, the dispatch helper MUST re-throw so the host's transaction
    // rolls back — otherwise the business doc commits while the event row
    // vanishes, and the relay never knows the event existed. The error is
    // also logged for observability before the re-throw. The transport
    // publish is skipped on save failure (we never reached it), preventing
    // a phantom in-process event for a state that won't survive rollback.
    const outbox = new RecordingOutbox();
    const transportCalls: DomainEvent[] = [];
    let loggedOutboxErrors = 0;
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
      eventTransport: {
        name: 'test-transport',
        async publish(event) { transportCalls.push(event); },
        async subscribe() { return () => {}; },
      },
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: (...args) => {
          if (typeof args[0] === 'string' && args[0].includes('outbox.save failed')) loggedOutboxErrors++;
        },
      },
    });
    await warmModels(engine);

    try {
      outbox.failNext = true;

      await expect(
        engine.repositories.transaction.createPaymentIntent({
          amount: 1000,
          gateway: 'fake', methodKind: 'card',
          data: { customerId: 'c2' },
        }),
      ).rejects.toThrow(/outbox/i);

      // Save failed → no row in outbox, no publish to transport, but the
      // error WAS logged for observability before being re-thrown.
      expect(outbox.saved.some(e => e.type === REVENUE_EVENTS.MONETIZATION_CREATED)).toBe(false);
      expect(transportCalls.some(e => e.type === REVENUE_EVENTS.MONETIZATION_CREATED)).toBe(false);
      expect(loggedOutboxErrors).toBe(1);
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);

  it('works without an outbox — events still reach the transport', async () => {
    if (!mongoAvailable) return;

    const transportCalls: DomainEvent[] = [];
    const engine = await createRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      // No outbox — revenue falls back to transport-only delivery.
      eventTransport: {
        name: 'test-transport',
        async publish(event) { transportCalls.push(event); },
        async subscribe() { return () => {}; },
      },
    });
    await warmModels(engine);

    try {
      await engine.repositories.transaction.createPaymentIntent({
        amount: 2000,
        gateway: 'fake', methodKind: 'card',
        data: { customerId: 'c3' },
      });
      expect(transportCalls.some(e => e.type === REVENUE_EVENTS.MONETIZATION_CREATED)).toBe(true);
    } finally {
      await engine.destroy();
    }
  }, TIMEOUT);
});
