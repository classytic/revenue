/**
 * In-process event bus — default fallback when the host doesn't pass an
 * `EventTransport` into `createRevenue`. Structurally identical to
 * `@classytic/arc`'s `MemoryEventTransport` so semantics match whether the
 * host uses the fallback or drops in arc's version.
 *
 * Glob matching is delegated to `@classytic/primitives`' `matchEventPattern`
 * (exact / `*` wildcard / `prefix.*` glob) — same semantics as arc.
 *
 * Fire-and-forget error handling: one failing handler is logged and does
 * not block the other handlers on the same event. This matches arc.
 */

import type {
  DomainEvent,
  EventHandler,
  EventTransport,
} from '@classytic/primitives/events';
import { matchEventPattern } from '@classytic/primitives/events';

export interface InProcessRevenueBusOptions {
  /** Logger for handler errors (default: console). */
  logger?: { error: (msg: string, ...args: unknown[]) => void };
}

export class InProcessRevenueBus implements EventTransport {
  readonly name = 'in-process-revenue';
  private handlers = new Map<string, Set<EventHandler>>();
  private logger: { error: (msg: string, ...args: unknown[]) => void };

  constructor(options?: InProcessRevenueBusOptions) {
    this.logger = options?.logger ?? console;
  }

  async publish(event: DomainEvent): Promise<void> {
    const all = new Set<EventHandler>();
    for (const [pattern, set] of this.handlers.entries()) {
      if (matchEventPattern(pattern, event.type)) {
        for (const h of set) all.add(h);
      }
    }

    for (const handler of all) {
      try {
        await handler(event);
      } catch (err) {
        this.logger.error(`[InProcessRevenueBus] Handler error for ${event.type}:`, err);
      }
    }
  }

  async subscribe(pattern: string, handler: EventHandler): Promise<() => void> {
    if (!this.handlers.has(pattern)) this.handlers.set(pattern, new Set());
    this.handlers.get(pattern)?.add(handler);
    return () => {
      const set = this.handlers.get(pattern);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(pattern);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
