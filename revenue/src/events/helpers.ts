/**
 * Event helpers — `createEvent` is a thin wrapper over `@classytic/primitives`'
 * `createEvent`. Takes a `RevenueContext` and maps actor/organization/trace
 * fields into the shared `EventMeta` shape.
 *
 * Callers always pass a fully-qualified event name from `REVENUE_EVENTS`
 * (e.g. `REVENUE_EVENTS.PAYMENT_VERIFIED`), so no prefix-handling magic is
 * needed here. See PACKAGE_RULES §14.
 */

import { createEvent as createPrimitiveEvent } from '@classytic/primitives/events';
import type { DomainEvent, EventMeta } from '@classytic/primitives/events';
import type { RevenueContext } from '../core/context.js';

export function createEvent<T>(
  type: string,
  payload: T,
  ctx?: RevenueContext,
  meta?: Partial<EventMeta>,
): DomainEvent<T> {
  return createPrimitiveEvent<T>(type, payload, {
    ...(ctx?.actorId !== undefined ? { userId: ctx.actorId } : {}),
    ...(ctx?.organizationId !== undefined ? { organizationId: ctx.organizationId } : {}),
    ...(ctx?.traceId !== undefined ? { correlationId: ctx.traceId } : {}),
    ...meta,
  });
}
