/**
 * In-memory `OutboxStore` for tests + dev wiring.
 *
 * The full outbox contract (`OutboxStore`, options types, error classes)
 * lives in [`@classytic/primitives/outbox`](../../package.json#L0) and is
 * re-exported from [`src/index.ts`](../index.ts) so hosts have a single
 * import surface for "everything I need to wire revenue's events." This
 * file ships a concrete `MemoryOutboxStore` so tests + dev hosts can
 * exercise the dispatch path without depending on `@classytic/arc`.
 *
 * Production durability belongs to the host — drop in arc's
 * `MongoOutboxStore` (or any other `OutboxStore` impl) and revenue's
 * dispatch helper saves to it under `ctx.session` before publishing to
 * the event transport. See PACKAGE_RULES §5.5 + §P8 and the `dispatch()`
 * helper in [`src/repositories/base.repository.ts`](../repositories/base.repository.ts#L175).
 *
 * Implements the required trio (`save` / `getPending` / `acknowledge`)
 * plus optional `purge`. Lease-based methods (`claimPending` / `fail` /
 * `getDeadLettered`) are intentionally omitted — single-process tests
 * don't need them, and the package only calls `save()` itself.
 */

import type { DomainEvent } from '@classytic/primitives/events';
import type {
  OutboxAcknowledgeOptions,
  OutboxStore,
  OutboxWriteOptions,
} from '@classytic/primitives/outbox';

export class MemoryOutboxStore implements OutboxStore {
  private events: Array<{ event: DomainEvent; acknowledgedAt?: Date }> = [];

  async save(event: DomainEvent, _options?: OutboxWriteOptions): Promise<void> {
    this.events.push({ event });
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    return this.events
      .filter((e) => !e.acknowledgedAt)
      .slice(0, limit)
      .map((e) => e.event);
  }

  async acknowledge(eventId: string, _options?: OutboxAcknowledgeOptions): Promise<void> {
    const entry = this.events.find((e) => e.event.meta.id === eventId);
    if (entry) entry.acknowledgedAt = new Date();
  }

  async purge(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const before = this.events.length;
    this.events = this.events.filter(
      (e) => !e.acknowledgedAt || e.acknowledgedAt.getTime() >= cutoff,
    );
    return before - this.events.length;
  }
}
