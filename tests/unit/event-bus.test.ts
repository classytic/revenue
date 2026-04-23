/**
 * InProcessRevenueBus tests — exercises the arc-compatible fallback transport
 * shipped with the package so `createRevenue` works without arc installed.
 *
 * The bus is a structural match of `@classytic/arc`'s `MemoryEventTransport`:
 * same publish/subscribe contract, same glob rules (exact / `*` / `prefix.*`),
 * same fire-and-forget error handling. This suite verifies every branch so a
 * regression on the fallback doesn't silently break arc-drop-in compatibility.
 */

import { describe, it, expect, vi } from 'vitest';
import { InProcessRevenueBus } from '../../revenue/src/events/in-process-bus.js';
import { createEvent } from '../../revenue/src/events/helpers.js';
import { REVENUE_EVENTS } from '../../revenue/src/events/event-constants.js';

describe('InProcessRevenueBus', () => {
  it('publishes events to subscribers registered for the exact type', async () => {
    const bus = new InProcessRevenueBus();
    const handler = vi.fn();
    await bus.subscribe(REVENUE_EVENTS.PAYMENT_VERIFIED, handler);

    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, { amount: 1000 }));

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.type).toBe('revenue:payment.verified');
    expect(event.payload.amount).toBe(1000);
    expect(event.meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.meta.timestamp).toBeInstanceOf(Date);
  });

  it('delivers to every subscriber for the same event type', async () => {
    const bus = new InProcessRevenueBus();
    const a = vi.fn();
    const b = vi.fn();
    await bus.subscribe(REVENUE_EVENTS.PAYMENT_REFUNDED, a);
    await bus.subscribe(REVENUE_EVENTS.PAYMENT_REFUNDED, b);

    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_REFUNDED, { refundAmount: 50 }));

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  // ── Glob matching (arc-compatible) ──

  it('supports `*` wildcard for every event', async () => {
    const bus = new InProcessRevenueBus();
    const handler = vi.fn();
    await bus.subscribe('*', handler);

    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, {}));
    await bus.publish(createEvent(REVENUE_EVENTS.SUBSCRIPTION_ACTIVATED, {}));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('supports `prefix.*` glob — matches `prefix.<anything-after-dot>`', async () => {
    // revenue:payment.* should match payment.verified / payment.refunded but
    // NOT subscription.activated (different resource) or payment (no dot).
    const bus = new InProcessRevenueBus();
    const handler = vi.fn();
    await bus.subscribe('revenue:payment.*', handler);

    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, {}));
    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_REFUNDED, {}));
    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_FAILED, {}));
    await bus.publish(createEvent(REVENUE_EVENTS.SUBSCRIPTION_ACTIVATED, {}));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  // ── Unsubscribe contract ──

  it('`subscribe` returns an unsubscribe function that removes the listener', async () => {
    const bus = new InProcessRevenueBus();
    const handler = vi.fn();
    const off = await bus.subscribe(REVENUE_EVENTS.PAYMENT_VERIFIED, handler);

    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, {}));
    expect(handler).toHaveBeenCalledTimes(1);

    off();
    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, {}));
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });

  it('unsubscribing one listener does not affect siblings on the same event', async () => {
    const bus = new InProcessRevenueBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = await bus.subscribe(REVENUE_EVENTS.ESCROW_HELD, a);
    await bus.subscribe(REVENUE_EVENTS.ESCROW_HELD, b);

    offA();
    await bus.publish(createEvent(REVENUE_EVENTS.ESCROW_HELD, {}));

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  // ── Error isolation ──

  it('a throwing handler does not block other handlers on the same event', async () => {
    const bus = new InProcessRevenueBus({ logger: { error: vi.fn() } });
    const bad = vi.fn().mockRejectedValue(new Error('boom'));
    const good = vi.fn();

    await bus.subscribe(REVENUE_EVENTS.PAYMENT_VERIFIED, bad);
    await bus.subscribe(REVENUE_EVENTS.PAYMENT_VERIFIED, good);

    await expect(
      bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, {})),
    ).resolves.not.toThrow();

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('publish with no subscribers resolves without throwing', async () => {
    const bus = new InProcessRevenueBus();
    await expect(
      bus.publish(createEvent(REVENUE_EVENTS.WEBHOOK_PROCESSED, {})),
    ).resolves.not.toThrow();
  });

  it('`close()` clears every subscription', async () => {
    const bus = new InProcessRevenueBus();
    const handler = vi.fn();
    await bus.subscribe('*', handler);

    await bus.close();
    await bus.publish(createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, {}));

    expect(handler).not.toHaveBeenCalled();
  });

  // ── Transport shape (arc contract) ──

  it('exposes a readonly `name` field for transport identification', () => {
    const bus = new InProcessRevenueBus();
    expect(bus.name).toBe('in-process-revenue');
  });
});

describe('createEvent', () => {
  it('fills in meta.id (uuid) and meta.timestamp (now)', () => {
    const before = Date.now();
    const event = createEvent(REVENUE_EVENTS.PAYMENT_VERIFIED, { amount: 10 });
    const after = Date.now();

    expect(event.type).toBe('revenue:payment.verified');
    expect(event.payload.amount).toBe(10);
    expect(event.meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.meta.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(event.meta.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it('pulls userId / organizationId / correlationId from a RevenueContext', () => {
    const event = createEvent(
      REVENUE_EVENTS.PAYMENT_VERIFIED,
      { amount: 10 },
      { actorId: 'user_1', organizationId: 'org_1', traceId: 'trace_abc' },
    );

    expect(event.meta.userId).toBe('user_1');
    expect(event.meta.organizationId).toBe('org_1');
    expect(event.meta.correlationId).toBe('trace_abc');
  });

  it('accepts meta overrides (resource / resourceId)', () => {
    const event = createEvent(
      REVENUE_EVENTS.PAYMENT_VERIFIED,
      { amount: 10 },
      undefined,
      { resource: 'transaction', resourceId: 'txn_abc' },
    );

    expect(event.meta.resource).toBe('transaction');
    expect(event.meta.resourceId).toBe('txn_abc');
  });
});
