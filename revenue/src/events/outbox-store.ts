/**
 * In-memory `OutboxStore` for tests + dev wiring — the shared
 * `MemoryOutboxStore` from `@classytic/primitives/memory-outbox`.
 *
 * The full outbox contract (`OutboxStore`, options types, error classes)
 * lives in `@classytic/primitives/outbox` and is re-exported from
 * `src/index.ts` so hosts have a single import surface. Production durability
 * belongs to the host — drop in arc's `MongoOutboxStore` (or any other
 * `OutboxStore` impl) and revenue's dispatch helper saves to it under
 * `ctx.session` before publishing to the event transport. See PACKAGE_RULES
 * §5.5 + §P8.
 */

export { MemoryOutboxStore } from '@classytic/primitives/memory-outbox';
