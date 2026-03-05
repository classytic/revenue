/**
 * EventBus Tests
 * @classytic/revenue
 *
 * Tests type-safe event bus with async handlers
 */

import { describe, it, expect, vi } from 'vitest';
import { EventBus, createEventBus } from '../../revenue/src/core/events.js';

describe('EventBus', () => {
  describe('on / emit', () => {
    it('should subscribe and receive events', async () => {
      const bus = createEventBus();
      const handler = vi.fn();

      bus.on('payment.verified', handler);
      bus.emit('payment.verified', {
        transaction: { _id: 'tx_1' } as any,
        paymentResult: { id: 'pr_1', provider: 'manual', status: 'succeeded' } as any,
      });

      // Fire-and-forget, give microtask time
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledOnce();
      const event = handler.mock.calls[0][0];
      expect(event.type).toBe('payment.verified');
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.transaction._id).toBe('tx_1');
    });

    it('should support multiple handlers per event', async () => {
      const bus = createEventBus();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.on('payment.failed', handler1);
      bus.on('payment.failed', handler2);
      bus.emit('payment.failed', {
        transaction: {} as any,
        error: 'timeout',
        provider: 'stripe',
        paymentIntentId: 'pi_1',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should return unsubscribe function', async () => {
      const bus = createEventBus();
      const handler = vi.fn();

      const unsub = bus.on('payment.verified', handler);
      unsub();

      bus.emit('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('once', () => {
    it('should fire handler only once', async () => {
      const bus = createEventBus();
      const handler = vi.fn();

      bus.once('payment.verified', handler);

      bus.emit('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });
      bus.emit('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('off', () => {
    it('should unsubscribe handler', async () => {
      const bus = createEventBus();
      const handler = vi.fn();

      bus.on('payment.verified', handler);
      bus.off('payment.verified', handler);

      bus.emit('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('Wildcard', () => {
    it('should catch all events with * handler', async () => {
      const bus = createEventBus();
      const handler = vi.fn();

      bus.on('*', handler);

      bus.emit('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });
      bus.emit('payment.failed', {
        transaction: {} as any,
        error: 'x',
        provider: 'y',
        paymentIntentId: 'z',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('emitAsync', () => {
    it('should wait for all handlers to complete', async () => {
      const bus = createEventBus();
      const order: number[] = [];

      bus.on('payment.verified', async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      });

      bus.on('payment.verified', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
      });

      await bus.emitAsync('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });

      // Both handlers should complete
      expect(order).toHaveLength(2);
      expect(order).toContain(1);
      expect(order).toContain(2);
    });
  });

  describe('Error Handling', () => {
    it('should catch async handler errors and log them', async () => {
      const bus = createEventBus();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.on('payment.verified', async () => {
        throw new Error('async handler crash');
      });

      // Should not throw — error is caught internally
      bus.emit('payment.verified', {
        transaction: {} as any,
        paymentResult: {} as any,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('payment.verified'),
        expect.any(Error)
      );
      consoleSpy.mockRestore();
    });
  });

  describe('clear / listenerCount', () => {
    it('should clear all handlers', () => {
      const bus = createEventBus();
      bus.on('payment.verified', () => {});
      bus.on('payment.failed', () => {});
      bus.once('payment.refunded', () => {});

      bus.clear();

      expect(bus.listenerCount('payment.verified')).toBe(0);
      expect(bus.listenerCount('payment.failed')).toBe(0);
      expect(bus.listenerCount('payment.refunded')).toBe(0);
    });

    it('should count listeners correctly', () => {
      const bus = createEventBus();
      bus.on('payment.verified', () => {});
      bus.on('payment.verified', () => {});
      bus.once('payment.verified', () => {});

      expect(bus.listenerCount('payment.verified')).toBe(3);
      expect(bus.listenerCount('payment.failed')).toBe(0);
    });
  });

  describe('Auto-injected Fields', () => {
    it('should inject type and timestamp on emit', async () => {
      const bus = createEventBus();
      let receivedEvent: any;

      bus.on('escrow.held', (event) => {
        receivedEvent = event;
      });

      bus.emit('escrow.held', {
        transaction: {} as any,
        heldAmount: 5000,
        reason: 'pending_delivery',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(receivedEvent.type).toBe('escrow.held');
      expect(receivedEvent.timestamp).toBeInstanceOf(Date);
      expect(receivedEvent.heldAmount).toBe(5000);
      expect(receivedEvent.reason).toBe('pending_delivery');
    });
  });
});
