/**
 * `cancel()` — the VOID verb, and the correction path a posted payment had none of.
 *
 * ## Why this verb exists
 *
 * Generic CRUD refuses to touch a transaction that has left `pending` (see
 * `@spinekit/revenue`'s mutability guard), so before this a mistaken capture
 * could only be refunded — which returns money that may never have been taken —
 * or edited behind the guard, which desyncs the GL silently. Every real ERP
 * answers a refusal with a route: Odoo offers revert / cancel / reset-to-draft.
 *
 * ## The two things that must not regress
 *
 * 1. **The CAS is the only guard.** Which transitions are legal is
 *    `TRANSACTION_STATE_MACHINE`'s call, and it is consulted inside the WRITE's
 *    filter. A hand-checked status list beside it is how a guard drifts out of
 *    sync with the write it protects.
 *
 * 2. **`payment.reversed` is CONDITIONAL on money having been recognised.**
 *    Cancelling a `pending` row unwinds nothing; emitting a reversal for it
 *    would tell the ledger to contra a posting that was never made — producing a
 *    one-sided entry that balances on its own and is therefore invisible. That
 *    is this codebase's signature failure, so it is asserted in BOTH directions.
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TRANSACTION_STATUS } from '../../src/enums/transaction.enums.js';
import { PAYMENT_EVENT_TYPE } from '@classytic/primitives/payment-events';

let mongod: MongoMemoryServer;
let Transaction: mongoose.Model<Record<string, unknown>>;
let repo: {
  cancel: (id: string, data: { reason: string; cancelledBy?: string }, ctx?: unknown) => Promise<Record<string, unknown>>;
};
/** Every event the repo dispatched, newest last. */
let events: Array<{ type: string; payload: Record<string, unknown> }>;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: 'revenue-cancel' });

  const { TransactionRepository } = await import('../../src/repositories/transaction/transaction.repository.js');
  const { buildTransactionSchema } = await import('../../src/models/transaction.schema.js');

  const schema = buildTransactionSchema({ scoped: false } as never);
  Transaction = mongoose.model('CancelTransaction', schema as never) as never;

  const built = new (TransactionRepository as never as new (...a: unknown[]) => Record<string, unknown>)(
    Transaction as never,
  );
  (built as { inject?: (d: unknown) => void }).inject?.({
    bridges: {},
    outbox: {
      save: async (e: { type: string; payload: Record<string, unknown> }) => {
        events.push({ type: e.type, payload: e.payload });
      },
    },
  });
  repo = built as never;
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  events = [];
  await Transaction.deleteMany({});
});

/** A transaction sitting in `status`, with real money on it. */
async function seed(status: string) {
  const doc = await Transaction.create({
    kind: 'payment_flow',
    type: 'purchase',
    flow: 'inflow',
    amount: 695500,
    currency: 'BDT',
    method: 'cash',
    methodKind: 'cash',
    status,
  });
  return String(doc._id);
}

const reversals = () => events.filter((e) => e.type === PAYMENT_EVENT_TYPE.REVERSED);

describe('cancel — the state machine decides, and it decides in the write', () => {
  it.each([
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PAYMENT_INITIATED,
    TRANSACTION_STATUS.REQUIRES_ACTION,
    TRANSACTION_STATUS.VERIFIED,
  ])('cancels a %s transaction', async (status) => {
    const id = await seed(status);
    const out = await repo.cancel(id, { reason: 'operator void' });
    expect(out.status).toBe(TRANSACTION_STATUS.CANCELLED);
  });

  it.each([
    TRANSACTION_STATUS.REFUNDED,
    TRANSACTION_STATUS.FAILED,
    TRANSACTION_STATUS.CANCELLED,
    TRANSACTION_STATUS.EXPIRED,
    TRANSACTION_STATUS.COMPLETED,
  ])('refuses a %s transaction — the machine has no such edge', async (status) => {
    const id = await seed(status);
    await expect(repo.cancel(id, { reason: 'nope' })).rejects.toThrow();
    const after = await Transaction.findById(id).lean();
    expect((after as { status: string }).status, 'must not have moved').toBe(status);
  });

  it('a second cancel is refused — cancelled is terminal, so this is not idempotent by design', async () => {
    const id = await seed(TRANSACTION_STATUS.VERIFIED);
    await repo.cancel(id, { reason: 'first' });
    await expect(repo.cancel(id, { reason: 'second' })).rejects.toThrow();
    // And exactly ONE reversal reached the ledger, not two.
    expect(reversals()).toHaveLength(1);
  });

  it('concurrent cancels: one wins, the other is refused', async () => {
    const id = await seed(TRANSACTION_STATUS.VERIFIED);
    const results = await Promise.allSettled([
      repo.cancel(id, { reason: 'a' }),
      repo.cancel(id, { reason: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reversals(), 'a lost race must not post a second reversal').toHaveLength(1);
  });
});

describe('the reversal event is conditional on money having been recognised', () => {
  it('cancelling a VERIFIED transaction emits payment.reversed for the full amount', async () => {
    const id = await seed(TRANSACTION_STATUS.VERIFIED);
    await repo.cancel(id, { reason: 'duplicate capture' });

    expect(reversals()).toHaveLength(1);
    const p = reversals()[0]!.payload as {
      reversedAmount?: { amount?: number };
      originalAmount?: { amount?: number };
      isPartial?: boolean;
      reason?: string;
    };
    expect(p.reversedAmount?.amount).toBe(695500);
    expect(p.originalAmount?.amount).toBe(695500);
    // A void unwinds the WHOLE settlement — a partial unwind is a refund.
    expect(p.isPartial).toBe(false);
    expect(p.reason).toBe('duplicate capture');
  });

  it.each([
    TRANSACTION_STATUS.PENDING,
    TRANSACTION_STATUS.PAYMENT_INITIATED,
    TRANSACTION_STATUS.REQUIRES_ACTION,
  ])('cancelling a %s transaction emits NO reversal — nothing was posted to unwind', async (status) => {
    const id = await seed(status);
    await repo.cancel(id, { reason: 'never captured' });
    expect(reversals(), 'a contra entry for a posting that never happened is invisible').toHaveLength(0);
  });
});

describe('the decision is RECORDED — the fields must survive the write', () => {
  // Mongoose strips paths absent from the schema without erroring, so a verb
  // can "succeed" and persist none of its provenance.
  it('persists cancelledAt, cancellationReason and cancelledBy', async () => {
    const id = await seed(TRANSACTION_STATUS.VERIFIED);
    await repo.cancel(id, { reason: 'keyed twice', cancelledBy: 'user-42' });

    const after = (await Transaction.findById(id).lean()) as {
      cancelledAt?: Date;
      cancellationReason?: string;
      cancelledBy?: string;
      failedAt?: Date;
    };
    expect(after.cancelledAt).toBeInstanceOf(Date);
    expect(after.cancellationReason).toBe('keyed twice');
    expect(after.cancelledBy).toBe('user-42');
    // A cancellation is NOT a failure — collapsing them loses who decided.
    expect(after.failedAt ?? null).toBeNull();
  });

  it('cancelledBy is optional and simply absent when not supplied', async () => {
    const id = await seed(TRANSACTION_STATUS.PENDING);
    await repo.cancel(id, { reason: 'no actor' });
    const after = (await Transaction.findById(id).lean()) as { cancelledBy?: string };
    expect(after.cancelledBy ?? null).toBeNull();
  });
});
