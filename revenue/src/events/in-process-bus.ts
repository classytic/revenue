/**
 * In-process fan-out transport — the default when the host injects none.
 *
 * A thin subclass of `@classytic/primitives/event-infra`'s shared
 * `InProcessEventBus` (the single implementation every kernel now defaults
 * to). Prior semantics preserved exactly: glob matching via
 * `matchEventPattern` (exact / `*` / `prefix.*` / `prefix:*`), Set-dedup so a
 * handler matched by multiple patterns fires once, per-handler error
 * isolation (errors logged; default `console`), idempotent `close()`.
 * Structurally identical to arc's `MemoryEventTransport`.
 */
import {
  InProcessEventBus,
  type InProcessEventBusOptions,
} from '@classytic/primitives/event-infra';

export type InProcessRevenueBusOptions = InProcessEventBusOptions;

export class InProcessRevenueBus extends InProcessEventBus {
  constructor(options: InProcessRevenueBusOptions = {}) {
    super({ name: 'in-process-revenue', logLabel: 'revenue', ...options });
  }
}
