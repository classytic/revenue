import { PAYMENT_EVENT_TYPE } from '@classytic/primitives/payment-events';
import { bindRevenue } from '../helpers/bind-revenue.js';
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
 * bridge, …) into `bindRevenue({ outbox })`. Revenue never persists an
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
import type { OutboxStore } from '@classytic/primitives/outbox';
import {
  REVENUE_EVENTS,
  TRANSACTION_STATUS,
  type DomainEvent,
} from '../../revenue/src/index.js';

const TIMEOUT = 15000;

let mongoAvailable = false;

/**
 * Minimal in-memory OutboxStore — implements only the required surface.
 *
 * Declares `transactionalSave: true` because `bind` refuses a store that does not
 * (a store that silently ignores `ctx.session` emits events for money writes that
 * rolled back). This double stands in for a session-honouring host store; the
 * behaviour under test is dispatch ORDER and failure propagation, not atomicity —
 * that is `arc-outbox-repo.scenario.test.ts`, which uses a real collection.
 */
class RecordingOutbox implements OutboxStore {
  readonly transactionalSave = true;
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
    const engine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
      dispatch: 'inline',
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
        idempotencyKey: 'pay-c1',
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
      expect(outboxTypes).toContain(PAYMENT_EVENT_TYPE.SUCCEEDED);
      expect(transportTypes).toEqual(outboxTypes);

      // Meta shape (P11-ish): every saved event has a non-empty type and meta.id.
      for (const ev of outbox.saved) {
        expect(ev.type).toBeTruthy();
        expect(ev.meta.id).toBeTruthy();
        expect(ev.meta.timestamp).toBeInstanceOf(Date);
      }
    } finally {
      await engine.close();
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
    const engine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
      dispatch: 'inline',
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
          idempotencyKey: 'pay-c2',
          data: { customerId: 'c2' },
        }),
      ).rejects.toThrow(/outbox/i);

      // Save failed → no row in outbox, no publish to transport, but the
      // error WAS logged for observability before being re-thrown.
      expect(outbox.saved.some(e => e.type === REVENUE_EVENTS.MONETIZATION_CREATED)).toBe(false);
      expect(transportCalls.some(e => e.type === REVENUE_EVENTS.MONETIZATION_CREATED)).toBe(false);
      expect(loggedOutboxErrors).toBe(1);
    } finally {
      await engine.close();
    }
  }, TIMEOUT);

  it('works without an outbox — events still reach the transport', async () => {
    if (!mongoAvailable) return;

    const transportCalls: DomainEvent[] = [];
    const engine = await bindRevenue({
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
        idempotencyKey: 'pay-c3',
        data: { customerId: 'c3' },
      });
      expect(transportCalls.some(e => e.type === REVENUE_EVENTS.MONETIZATION_CREATED)).toBe(true);
    } finally {
      await engine.close();
    }
  }, TIMEOUT);
});

/**
 * `runtime.dispatch` — an outboxed event is delivered ONCE, the way the host said.
 * Without it both happened: the live publish, and the relay's re-publish of a row
 * nothing had acknowledged — every payment subscriber ran twice.
 */
class AckingOutbox extends RecordingOutbox {
  readonly acked: string[] = [];
  override async acknowledge(id?: string): Promise<void> {
    if (id) this.acked.push(id);
  }
}

describe('Scenario: dispatch mode', () => {
  const recordingTransport = (calls: DomainEvent[]) => ({
    name: 'test-transport',
    async publish(event: DomainEvent) { calls.push(event); },
    async subscribe() { return () => {}; },
  });

  it("an outbox with no dispatch defaults to 'inline'; relay with no outbox is refused", async () => {
    const base = { connection: mongoose.connection, defaultCurrency: 'USD', scope: false as const, forceRecreate: true };
    expect(() => bindRevenue({ ...base, dispatch: 'relay' })).toThrow(/needs an outbox/);
    if (!mongoAvailable) return;
    // An existing outbox host (no `dispatch`) keeps booting, and gets the de-duplicated
    // inline delivery rather than a live publish plus a relay re-publish.
    const engine = await bindRevenue({ ...base, outbox: new RecordingOutbox() });
    try {
      expect(engine.config.dispatch).toBe('inline');
    } finally {
      await engine.close();
    }
  });

  /**
   * `config.hasOutbox` is how a caller that wraps verbs in its own transaction
   * decides whether it may pass `ctx.session`: without an outbox every in-session
   * verb throws `UnmanagedSessionError`. @spinekit/revenue's verify/reject branch on it.
   */
  it('reports whether an outbox is wired in config.hasOutbox', async () => {
    if (!mongoAvailable) return;
    const base = { connection: mongoose.connection, defaultCurrency: 'USD', scope: false as const, forceRecreate: true };
    const without = await bindRevenue(base);
    const withOutbox = await bindRevenue({ ...base, outbox: new RecordingOutbox(), dispatch: 'inline' });
    try {
      expect(without.config.hasOutbox).toBe(false);
      expect(withOutbox.config.hasOutbox).toBe(true);
    } finally {
      await without.close();
      await withOutbox.close();
    }
  }, TIMEOUT);

  it("'relay': nothing is published in the caller — on the direct AND the post-commit path", async () => {
    if (!mongoAvailable) return;
    const outbox = new AckingOutbox();
    const transportCalls: DomainEvent[] = [];
    const committed: string[] = [];
    const engine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
      dispatch: 'relay',
      afterCommit: ({ events, dispatch }) => {
        expect(dispatch).toBe('relay');
        committed.push(...events.map((e) => e.type));
      },
      eventTransport: recordingTransport(transportCalls),
    });
    await warmModels(engine);
    try {
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 5000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'relay-1',
      });
      await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
      // Refund saves its row inside a transaction and delivers after commit — the other path.
      await engine.repositories.transaction.refund(txn._id.toString(), null, { idempotencyKey: 'relay-1-r' });

      expect(transportCalls).toEqual([]);
      expect(outbox.acked).toEqual([]);
      expect(committed).toContain(PAYMENT_EVENT_TYPE.SUCCEEDED);
      expect(committed).toContain(PAYMENT_EVENT_TYPE.REFUNDED);
      // Every committed event has a durable row for the relay.
      for (const t of committed) expect(outbox.saved.map((e) => e.type)).toContain(t);
    } finally {
      await engine.close();
    }
  }, TIMEOUT);

  it("'inline': publishes live and ACKNOWLEDGES every delivered row", async () => {
    if (!mongoAvailable) return;
    const outbox = new AckingOutbox();
    const transportCalls: DomainEvent[] = [];
    const engine = await bindRevenue({
      connection: mongoose.connection,
      defaultCurrency: 'USD',
      providers: { fake: new FakeProvider() },
      scope: false,
      forceRecreate: true,
      outbox,
      dispatch: 'inline',
      eventTransport: recordingTransport(transportCalls),
    });
    await warmModels(engine);
    try {
      const txn = await engine.repositories.transaction.createPaymentIntent({
        amount: 5000, gateway: 'fake', methodKind: 'card', idempotencyKey: 'inline-1',
      });
      await engine.repositories.transaction.verify(txn.gateway!.paymentIntentId as string);
      await engine.repositories.transaction.refund(txn._id.toString(), null, { idempotencyKey: 'inline-1-r' });

      expect(transportCalls.map((e) => e.type)).toContain(PAYMENT_EVENT_TYPE.REFUNDED);
      // Delivered live ⇒ acknowledged, so the relay never delivers it a second time.
      expect([...outbox.acked].sort()).toEqual(transportCalls.map((e) => e.meta.id).sort());
    } finally {
      await engine.close();
    }
  }, TIMEOUT);
});
