/**
 * Build the {@link PaymentCommandContext} every money-changing provider call now requires.
 *
 * The envelope has four jobs and each one has a failure it prevents:
 *
 *   - `idempotencyKey` — a retried command must not move money twice. This is the only
 *     field the gateway itself can act on.
 *   - `requestId` — correlates one attempt across our logs, the provider's dashboard and the
 *     audit trail. Without it, reconciling an `unknown` outcome means guessing by timestamp.
 *   - `merchantReference` — what the money is FOR, in our vocabulary. It is what an operator
 *     searches by when a customer calls.
 *   - `organizationId` — branch scope, so a command is attributable.
 *
 * ## On the derived idempotency key
 *
 * When a caller supplies no key we derive a deterministic one from the operation and its
 * subject rather than generating a random value. A random key makes every retry look like a
 * NEW operation to the gateway, which is worse than no key at all: it defeats the very
 * deduplication the field exists for, while appearing to be correctly wired.
 *
 * A derived key is not as good as a caller-supplied one — the caller knows which retries are
 * the same logical operation and we can only approximate — so callers should pass their own.
 */
import type { PaymentCommandContext } from '@classytic/primitives/payment-gateway';

let counter = 0;

/** Monotonic, process-local. Only ever used for correlation, never for deduplication. */
function nextRequestId(): string {
  counter += 1;
  return `rq_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function buildPaymentCommandContext(input: {
  operation: string;
  subjectId: string;
  /** Optional — absent on an unscoped (single-tenant / company-global) engine. */
  organizationId?: string;
  merchantReference?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): PaymentCommandContext {
  return {
    idempotencyKey: input.idempotencyKey ?? `${input.operation}:${input.subjectId}`,
    requestId: nextRequestId(),
    merchantReference: input.merchantReference ?? input.subjectId,
    ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}
