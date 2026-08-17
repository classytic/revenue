/**
 * Revenue's portable payment facts must BE the primitives contract.
 *
 * The failure this guards is the one revenue already had: a documented payload
 * that drifted from the emitted one. A schema in a catalogue file is a
 * description, and a description nobody executes is decoration — so these tests
 * build the payload the way production builds it and assert against the
 * canonical TYPE, not against a second copy of the shape.
 *
 * See the external review that prompted revenue 4.x, and
 * `@classytic/primitives/payment-events`.
 */
import { PAYMENT_EVENT_TYPE, isFundsReceived, type PaymentEventPayload } from '@classytic/primitives/payment-events';
import { describe, expect, it } from 'vitest';
import {
  paymentIdOf,
  toPaymentFailed,
  toPaymentReconciled,
  toPaymentRefunded,
  toPaymentReversed,
  toPaymentSucceeded,
  toPaymentUnknown,
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

describe('payloads satisfy the canonical contract', () => {
  it('every builder produces a value assignable to PaymentEventPayload', () => {
    /**
     * The union is DISCRIMINATED, so this is not a formality: a payload whose
     * `eventType` does not match its own field set fails to narrow, and that is
     * exactly the drift shape — a refund event carrying a succeeded body.
     */
    const payloads: PaymentEventPayload[] = [
      toPaymentSucceeded(txn(), AT),
      toPaymentFailed(txn(), 'card declined', AT, 'card_declined'),
      toPaymentRefunded({ original: txn(), refund: txn({ publicId: 'ref_1' }), refundedAmount: 50_000, occurredAt: AT }),
      toPaymentReversed({ original: txn(), reversedAmount: 115_000, reason: 'duplicate capture', occurredAt: AT }),
      toPaymentReconciled({
        allocationId: 'alloc_1',
        paymentId: 'pay_1',
        externalRef: 'bank-line-9',
        reconciledAt: AT,
        reconciledBy: 'system',
      }),
      toPaymentUnknown({ txn: txn(), operation: 'refund', causeCode: 'timeout', occurredAt: AT }),
    ];
    expect(payloads).toHaveLength(6);
    for (const p of payloads) expect(p.eventType).toMatch(/^payment\./);
  });

  it('carries MONEY, never a bare number', () => {
    // `refundAmount: z.number()` carried no currency — survivable in a
    // single-currency deployment, wrong the moment there are two.
    const refunded = toPaymentRefunded({
      original: txn(),
      refund: txn({ publicId: 'ref_1' }),
      refundedAmount: 50_000,
      occurredAt: AT,
    });
    expect(refunded.refundedAmount).toEqual({ amount: 50_000, currency: 'BDT' });
    expect(refunded.originalAmount).toEqual({ amount: 115_000, currency: 'BDT' });
    expect(toPaymentSucceeded(txn(), AT).amount).toEqual({ amount: 115_000, currency: 'BDT' });
  });

  it('DERIVES isPartial rather than trusting a caller', () => {
    // Two sources for one boolean is one that can disagree.
    const partial = toPaymentRefunded({
      original: txn(),
      refund: txn({ publicId: 'r' }),
      refundedAmount: 50_000,
      occurredAt: AT,
    });
    const full = toPaymentRefunded({
      original: txn(),
      refund: txn({ publicId: 'r' }),
      refundedAmount: 115_000,
      occurredAt: AT,
    });
    expect(partial.isPartial).toBe(true);
    expect(full.isPartial).toBe(false);
  });

  it('lets a consumer compute remaining refundable WITHOUT a revenue lookup', () => {
    // The whole point of a portable fact: no consumer should need to know what
    // a revenue transaction document looks like.
    const r = toPaymentRefunded({
      original: txn(),
      refund: txn({ publicId: 'r' }),
      refundedAmount: 40_000,
      occurredAt: AT,
    });
    expect(r.originalAmount.amount - r.refundedAmount.amount).toBe(75_000);
  });
});

describe('correlation', () => {
  it('travels in METADATA, not as top-level fields', () => {
    // The canonical contract does not model the payer's domain; promoting these
    // would make every payment consumer carry revenue's notion of a source.
    const p = toPaymentSucceeded(txn(), AT);
    expect(p.metadata).toMatchObject({ sourceModel: 'Order', sourceId: 'order-1' });
    expect(p).not.toHaveProperty('sourceModel');
    expect(p).not.toHaveProperty('sourceId');
  });

  it('omits correlation keys rather than emitting empty ones', () => {
    const p = toPaymentSucceeded(txn({ sourceModel: undefined, sourceId: undefined, _id: undefined }), AT);
    expect(p.metadata).toEqual({});
  });

  it('carries the revenue ROW id so an existing lookup stays exact', () => {
    /**
     * `paymentId` prefers `publicId`, a `customIdPlugin` field. A consumer
     * calling `getById(paymentId)` without an explicit `idField` can match
     * NOTHING and skip silently — the trap `@classytic/order` documents for
     * `orderNumber`. `metadata.transactionId` keeps the row addressable
     * without promoting a revenue detail into the portable contract.
     */
    const p = toPaymentSucceeded(txn({ _id: 'row-oid-1' }), AT);
    expect(p.paymentId).toBe('pay_1');
    expect(p.metadata).toMatchObject({ transactionId: 'row-oid-1' });
  });
});

describe('the three-valued outcome', () => {
  it('emits UNKNOWN as its own fact, never approximated as failed', () => {
    /**
     * The provider port is `confirmed | declined | unknown` while revenue's
     * vocabulary was two-valued, so an adapter hitting the third case had to
     * pick a lie. Reporting `failed` is the dangerous direction: it licenses a
     * retry, and if the first attempt succeeded that retry is a double charge.
     */
    const u = toPaymentUnknown({
      txn: txn(),
      operation: 'refund',
      causeCode: 'timeout',
      occurredAt: AT,
      idempotencyKey: 'idem-1',
    });
    expect(u.eventType).toBe(PAYMENT_EVENT_TYPE.UNKNOWN);
    expect(u.eventType).not.toBe(PAYMENT_EVENT_TYPE.FAILED);
    // What reconciliation asks the provider with.
    expect(u.idempotencyKey).toBe('idem-1');
    expect(u.operation).toBe('refund');
  });

  it('is NOT treated as funds received', () => {
    // A consumer switching on `isFundsReceived` must never settle AR on an
    // unobserved outcome.
    expect(isFundsReceived(toPaymentUnknown({ txn: txn(), operation: 'verify', causeCode: 'timeout', occurredAt: AT }))).toBe(
      false,
    );
    expect(isFundsReceived(toPaymentSucceeded(txn(), AT))).toBe(true);
  });

  it('distinguishes REVERSED from REFUNDED — consumers unwind differently', () => {
    // A refund returns money post-settlement; a reversal undoes the settlement
    // itself and requires allocations to be unwound. Approximating one as the
    // other corrupts AR in a way that still balances.
    const rev = toPaymentReversed({ original: txn(), reversedAmount: 115_000, reason: 'duplicate capture', occurredAt: AT });
    expect(rev.eventType).toBe(PAYMENT_EVENT_TYPE.REVERSED);
    expect(rev.reason).toBe('duplicate capture');
  });

  it('keys RECONCILED on the allocation, not the payment', () => {
    // One payment can have many allocations; reconciling one says nothing about
    // the others, so emitting per payment would close an audit loop still open.
    const rec = toPaymentReconciled({
      allocationId: 'alloc_1',
      paymentId: 'pay_1',
      externalRef: 'bank-line-9',
      reconciledAt: AT,
      reconciledBy: 'operator-7',
    });
    expect(rec.allocationId).toBe('alloc_1');
    expect(rec.paymentId).toBe('pay_1');
    expect(rec.reconciledBy).toBe('operator-7');
  });
});

describe('identity', () => {
  it('prefers publicId, falls back to _id', () => {
    expect(paymentIdOf(txn())).toBe('pay_1');
    expect(paymentIdOf(txn({ publicId: undefined, _id: 'objid-9' }))).toBe('objid-9');
  });

  it('REFUSES a transaction it cannot identify', () => {
    // An event whose subject cannot be identified is not a fact, and an empty
    // id produces a consumer-side lookup that silently matches nothing.
    expect(() => paymentIdOf(txn({ publicId: undefined, _id: undefined }))).toThrow(/not a portable fact/);
  });

  it('normalises a missing provider rather than emitting an invalid payload', () => {
    // `providerCode` is required by the contract; `'unknown'` is greppable in a
    // way an absent key is not.
    expect(toPaymentSucceeded(txn({ providerCode: undefined }), AT).providerCode).toBe('unknown');
  });
});
