import type { Model } from 'mongoose';
import type { TransactionDocument } from '../models/transaction.schema.js';
import type { PaymentAttemptDocument } from '../models/payment-attempt.schema.js';

/**
 * Backfill one `PaymentAttempt` per existing payment-flow transaction (phase 3, §4.5).
 *
 * The `Transaction.gateway` block holds exactly one attempt's worth of data (the LAST /
 * only provider attempt), so synthesizing ONE attempt per transaction is LOSSLESS — no
 * historical attempt data is invented. Every synthesized attempt is `confirmed`: the
 * transaction only exists because `createIntent` returned an intent to persist. Refund
 * children and free (amount 0, no-provider) transactions are skipped.
 *
 * Idempotent: a transaction that already has a `create-intent` attempt is skipped, so the
 * job is safe to re-run and to resume after interruption.
 */
export interface BackfillPaymentAttemptsOptions {
  /** Report what WOULD be created without writing. */
  dryRun?: boolean;
  /** Progress-log cadence (created rows). Default 500. */
  logEvery?: number;
  log?: (message: string) => void;
}

export interface BackfillPaymentAttemptsResult {
  scanned: number;
  created: number;
  skipped: number;
  dryRun: boolean;
}

export async function backfillCreatePaymentAttempts(
  models: {
    Transaction: Model<TransactionDocument>;
    PaymentAttempt: Model<PaymentAttemptDocument>;
  },
  options: BackfillPaymentAttemptsOptions = {},
): Promise<BackfillPaymentAttemptsResult> {
  const { dryRun = false, logEvery = 500, log = () => {} } = options;
  const { Transaction, PaymentAttempt } = models;

  let scanned = 0;
  let created = 0;
  let skipped = 0;

  // payment-flow transactions that actually reached a provider: kind is
  // 'payment_flow' (or legacy-absent), a gateway id is present, amount > 0, and it
  // is not a refund child.
  const cursor = Transaction.find({
    $and: [
      { $or: [{ kind: 'payment_flow' }, { kind: { $exists: false } }] },
      {
        $or: [
          { 'gateway.paymentIntentId': { $type: 'string' } },
          { 'gateway.sessionId': { $type: 'string' } },
        ],
      },
      { amount: { $gt: 0 } },
      { type: { $ne: 'refund' } },
    ],
  })
    .lean()
    .cursor();

  for await (const txn of cursor as unknown as AsyncIterable<TransactionDocument>) {
    scanned += 1;
    const gw = txn.gateway;
    const provider = txn.method ?? gw?.type ?? 'unknown';
    // DETERMINISTIC command identity: the txn's own key when it has one (so the
    // synthesized attempt matches what a live attempt would carry, and a txn that
    // already got a phase-3 attempt is deduped), else a stable per-txn marker.
    const idempotencyKey = txn.idempotencyKey ?? `backfill:${String(txn._id)}`;
    const identity = {
      ...(txn.organizationId ? { organizationId: txn.organizationId } : {}),
      operation: 'create-intent' as const,
      provider,
      idempotencyKey,
    };

    if (dryRun) {
      const exists = await PaymentAttempt.exists(identity);
      if (exists) skipped += 1;
      else created += 1;
      continue;
    }

    // ATOMIC UPSERT on the `attempt_command_identity` unique index — two migration
    // workers converge (one inserts, the other matches or loses the E11000 race) with
    // no existence-check gap. Not "one attempt per transaction" — keyed on the command
    // identity, so a txn's real live attempt is recognised, not duplicated.
    try {
      const res = await PaymentAttempt.updateOne(
        identity,
        {
          $setOnInsert: {
            transactionId: txn._id,
            ...(txn.methodKind ? { methodKind: txn.methodKind } : {}),
            amount: txn.amount,
            currency: txn.currency,
            // The transaction exists ⇒ createIntent confirmed. Settlement status
            // lives on the transaction; the attempt records the create call.
            outcome: 'confirmed',
            gateway: {
              ...(gw?.sessionId ? { sessionId: gw.sessionId } : {}),
              ...(gw?.paymentIntentId ? { paymentIntentId: gw.paymentIntentId } : {}),
              ...(gw?.chargeId ? { chargeId: gw.chargeId } : {}),
            },
            metadata: { backfilled: true },
          },
        },
        { upsert: true },
      );
      if ((res.upsertedCount ?? 0) > 0) {
        created += 1;
        if (created % logEvery === 0) log(`[backfill:payment-attempts] created ${created}...`);
      } else {
        skipped += 1;
      }
    } catch (err) {
      // A concurrent worker won the upsert race for this identity — already covered.
      if ((err as { code?: number } | null)?.code === 11000) skipped += 1;
      else throw err;
    }
  }

  log(
    `[backfill:payment-attempts] done — scanned=${scanned} created=${created} skipped=${skipped}` +
      (dryRun ? ' (dry run — nothing written)' : ''),
  );
  return { scanned, created, skipped, dryRun };
}
