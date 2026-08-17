/**
 * A builder's OUTPUT must satisfy the schema its CONSUMER validates with.
 *
 * ## The bug this exists to make impossible
 *
 * `toPaymentRefunded()` returns `occurredAt: Date` — correct, and typed that way
 * by `@classytic/primitives/events/payment-events`. `paymentRefundedCanonicalSchema`
 * had been narrowed to `z.iso.datetime()`, i.e. `string`. The two are INDEPENDENT
 * declarations of one contract and never meet in a type position, so:
 *
 *   - `npx tsc --noEmit` was rc 0 with 0 errors in this package, and
 *   - every consumer rejected every payload at runtime.
 *
 * `spine-accounting`'s posting handler validates with `PaymentRefunded.zodSchema`
 * and, on failure, logs `posting: payload validation failed — skipping` at WARN
 * and returns. So on 2026-08-16 a real refund executed, the customer was
 * refunded, the RMA stamped `settledAt` — and no revenue/output-VAT reversal
 * journal entry was ever posted. Nothing threw anywhere.
 *
 * The existing `canonical-payment-events.test.ts` asserts builder output against
 * the primitive TYPE, which is why it stayed green: it never ran the payload
 * through the Zod schema that actually gates delivery. That is the hole here.
 *
 * ## Both delivery shapes, because there are two delivery paths
 *
 * The transaction repositories publish TWICE: `saveToOutbox` inside the write
 * transaction, then `publishToTransport` after commit. Neither serialises —
 * mongokit's outbox row stores the envelope as `Schema.Types.Mixed` ("the event,
 * verbatim, as the relay will republish it"), so a `Date` round-trips through
 * BSON as a `Date`. LIVE is therefore the shape production actually delivers.
 *
 * SERIALISED is asserted anyway: it is what any future HTTP/Kafka relay would
 * deliver, and a schema that accepted only one of the two reproduces this bug
 * with the paths swapped — which is exactly how it was introduced.
 */
import { describe, expect, it } from 'vitest';
import {
  PaymentFailedEvent,
  PaymentRefunded,
  PaymentSucceeded,
} from '../src/events/revenue-event-catalog.js';
import {
  toPaymentFailed,
  toPaymentRefunded,
  toPaymentSucceeded,
  type CanonicalSourceTransaction,
} from '../src/events/canonical-payment-events.js';

const AT = new Date('2026-08-16T10:00:00.000Z');

const txn = (o: Partial<CanonicalSourceTransaction> = {}): CanonicalSourceTransaction => ({
  publicId: 'pay_1',
  amount: 115_000,
  currency: 'BDT',
  methodKind: 'card',
  providerCode: 'stripe',
  providerRef: 'pi_123',
  sourceModel: 'Order',
  sourceId: 'order-1',
  ...o,
});

/** Every canonical builder paired with the event definition consumers bind to. */
const CASES = [
  {
    name: 'payment.succeeded',
    event: PaymentSucceeded,
    build: () => toPaymentSucceeded(txn(), AT),
  },
  {
    name: 'payment.failed',
    event: PaymentFailedEvent,
    build: () => toPaymentFailed(txn(), 'card declined', AT, 'card_declined'),
  },
  {
    name: 'payment.refunded',
    event: PaymentRefunded,
    build: () =>
      toPaymentRefunded({
        original: txn(),
        refund: txn({ publicId: 'ref_1' }),
        refundedAmount: 50_000,
        occurredAt: AT,
        reason: 'customer return',
      }),
  },
] as const;

describe('canonical builder output satisfies its own event schema', () => {
  for (const { name, event, build } of CASES) {
    /**
     * The path production uses today: no serialisation on either publish, so the
     * subscriber receives the builder's object with its `Date` intact.
     */
    it(`${name} — LIVE (in-process and Mongo-outbox: Date survives)`, () => {
      const result = event.zodSchema.safeParse(build());
      expect(
        result.success,
        result.success ? '' : JSON.stringify(result.error.issues, null, 2),
      ).toBe(true);
    });

    /**
     * The shape a genuinely serialising transport would deliver. `JSON.parse(
     * JSON.stringify(x))` is exactly what such a relay does to the envelope.
     */
    it(`${name} — SERIALISED (a JSON relay: Date becomes an ISO string)`, () => {
      const wire = JSON.parse(JSON.stringify(build())) as unknown;
      const result = event.zodSchema.safeParse(wire);
      expect(
        result.success,
        result.success ? '' : JSON.stringify(result.error.issues, null, 2),
      ).toBe(true);
    });
  }

  /**
   * The narrowing must stay REFUSED, not merely tolerated.
   *
   * Without this, someone re-narrowing `canonicalInstant` to `z.iso.datetime()`
   * would break only the LIVE assertions above — and if a future refactor ever
   * makes the transport serialise, those would start passing again while the
   * schema was still wrong for a replay. Asserting the union directly pins the
   * intent rather than a symptom.
   */
  it('rejects a value that is neither an instant nor an ISO string', () => {
    const bad = { ...CASES[2].build(), occurredAt: 'not-a-date' } as unknown;
    expect(PaymentRefunded.zodSchema.safeParse(bad).success).toBe(false);
  });
});

describe('the JSON Schema projection never constrains the validation contract', () => {
  /**
   * `defineRevenueEvent` converts EAGERLY at module load. It ran with zod's
   * default `unrepresentable: 'throw'`, so any `z.date()` in any schema below
   * threw `Date cannot be represented in JSON Schema` at import — which is the
   * pressure that narrowed `canonicalInstant` in the first place. Under `'any'`
   * the docs degrade and runtime validation stays exact.
   *
   * Importing the catalog at all is most of this assertion (a throw would fail
   * collection); the explicit checks pin that `schema` is still produced and
   * still describes the union rather than silently becoming empty.
   */
  it('emits a JSON Schema for a union carrying an unrepresentable member', () => {
    const projected = PaymentRefunded.schema as {
      properties?: Record<string, { anyOf?: unknown[] }>;
    };
    expect(projected.properties?.occurredAt).toBeDefined();
    expect(Array.isArray(projected.properties?.occurredAt?.anyOf)).toBe(true);
  });
});
