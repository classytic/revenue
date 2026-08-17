import { withTransaction, systemContext, isDuplicateKeyError } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import type { TransactionDocument } from '../../models/transaction.schema.js';
import type { PaymentAttemptDocument } from '../../models/payment-attempt.schema.js';
import type { RevenueContext } from '../../core/context.js';
import { executeProviderCommand } from '../../providers/execute-command.js';
import { buildPaymentCommandContext } from '../../providers/command-context.js';
import type { DomainEvent } from '@classytic/primitives/events';
import { PAYMENT_EVENT_TYPE } from '@classytic/primitives/payment-events';
import {
  toPaymentRefunded,
  toPaymentUnknown,
  type CanonicalSourceTransaction,
} from '../../events/canonical-payment-events.js';
import { createEvent } from '../../events/helpers.js';
import { TRANSACTION_STATUS } from '../../enums/transaction.enums.js';
import {
  ConfigurationError,
  TransactionNotFoundError,
  ValidationError,
  RefundOutcomeUnknownError,
} from '../../core/errors.js';
import { reverseCommission } from '../../shared/calculators/commission.js';
import { reverseTax } from '../../shared/calculators/tax.js';
import { TransactionBankFeedRepository } from './bank-feed.repository.js';
import type {
  PaymentAttemptHistory,
  PaymentAttemptView,
  RefundSummary,
  RefundView,
} from './transaction-types.js';
/**
 * Internal signal: the attempt outcome CAS lost to a concurrent (or prior) resolver
 * INSIDE the atomic finalize/release transaction. Thrown to abort that transaction so
 * nothing partial commits; the caller catches it and resolves idempotently (return the
 * existing refund, or report `won: false`). Never escapes the repository.
 */
class AttemptAlreadyResolvedError extends Error {
  constructor() {
    super('payment attempt already resolved by a concurrent writer');
    this.name = 'AttemptAlreadyResolvedError';
  }
}

/**
 * Refund + reconciliation lifecycle layer. Owns the refund verb, its atomic
 * reserve→provider→finalize/release helpers, the provider-driven reconciliation of stuck
 * attempts, the stale-attempt scanner and the refund read model. Extends the bank-feed base
 * so it inherits the shared dispatch helpers; the payment layer extends this.
 */
export abstract class TransactionRefundRepository extends TransactionBankFeedRepository {
  // ─── Domain: Refund ───

  /**
   * Creates refund transaction, updates original. Returns the refund transaction doc.
   *
   * The provider call happens OUTSIDE the transaction — it's a non-idempotent external
   * side effect we can't roll back. The two Mongo writes (create refund + update original)
   * run inside `withTransaction` so they commit atomically or both abort. Bridges and
   * event emission run AFTER commit because they're independent side effects; rolling
   * them back would not undo external state anyway.
   *
   * Powered by mongokit 3.6's module-level `withTransaction` helper. Automatically
   * retries on `TransientTransactionError` / `UnknownTransactionCommitResult`.
   */
  async refund(
    transactionId: string,
    amount?: number | null,
    options: { reason?: string; idempotencyKey?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    // Scope + a STABLE caller key are both required before any DB write or provider
    // I/O. The key must be stable across retries (e.g. `refund.id`): a retried
    // partial refund with a fresh key would reverse the gateway twice, and the
    // reservation below cannot dedup what it cannot recognise.
    if (this.deps.tenantScopeEnabled && !ctx.organizationId) {
      throw new ValidationError(
        'organizationId is required for refund on a tenant-scoped engine — ' +
          'refusing to contact the payment provider without branch scope',
        { operation: 'refund' },
      );
    }
    if (!options.idempotencyKey) {
      throw new ValidationError(
        'idempotencyKey is required for refund: it must be stable across retries ' +
          '(e.g. derived from the refund command / refund id) so a lost-response retry ' +
          'reuses the same provider operation instead of reversing twice.',
        { operation: 'refund' },
      );
    }
    const attemptRepo = this.deps.paymentAttempts;
    if (!attemptRepo) {
      throw new ConfigurationError(
        'PaymentAttempt repository is not wired — defineRevenue must register it at bind (phase 3 core).',
      );
    }

    const transaction = await this.getById(transactionId, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(transactionId);

    // Idempotent replay — a refund already produced for this caller key returns the
    // existing refund transaction instead of charging the gateway again. Makes a
    // refund safely RETRYABLE: a caller that crashed after the money moved re-invokes
    // with the same key and gets the recorded refund, never a double reversal.
    if (options.idempotencyKey) {
      const existingRefund = await this.getByQuery(
        { idempotencyKey: options.idempotencyKey, type: 'refund' },
        this.optsFromCtx(ctx, { throwOnNotFound: false }),
      );
      if (existingRefund) return existingRefund as TransactionDocument;
    }

    const refundAmount = amount ?? transaction.amount;
    if (refundAmount <= 0) {
      throw new ValidationError('refund amount must be positive', { refundAmount });
    }

    // Cap counts BOTH confirmed refunds and reserved-but-unconfirmed ones:
    // `refundedAmount + pendingRefundAmount + this <= amount`. In-memory pre-check
    // for a clean error on the common path; the atomic `$expr` reservation below
    // is the concurrency-safe enforcement.
    const existingRefunded = transaction.refundedAmount ?? 0;
    const existingPending = transaction.pendingRefundAmount ?? 0;
    if (existingRefunded + existingPending + refundAmount > transaction.amount) {
      throw new ValidationError('refund exceeds captured amount', {
        amount: transaction.amount,
        alreadyRefunded: existingRefunded,
        pending: existingPending,
        requested: refundAmount,
      });
    }

    // ── RESERVE-BEFORE-I/O + durable refund attempt (phase 3, atomic) ──
    // The original is NOT flipped to refunded here — that happens only after the
    // provider confirms. Instead we RESERVE the amount against `pendingRefundAmount`
    // (which the cap counts), so a concurrent or retried refund cannot double-spend
    // the remaining balance, and we persist a `pending` refund PaymentAttempt whose
    // `_id` is the durable anchor + the source of the provider idempotency key. The
    // reservation `$inc` is atomic per-document; the `$expr` cap makes it race-safe.
    const refundAttemptId = new Types.ObjectId();
    const refundKey = options.idempotencyKey;
    const REFUNDABLE_STATUSES = [
      TRANSACTION_STATUS.VERIFIED,
      TRANSACTION_STATUS.COMPLETED,
      TRANSACTION_STATUS.PARTIALLY_REFUNDED,
    ];
    let reserved = false;
    let capBlocked = false;
    try {
      await withTransaction(
        this.Model.db as unknown as { startSession(): Promise<ClientSession> },
        async (session) => {
          const writeOpts = this.optsFromCtx(ctx, { session });
          const r = await this.findOneAndUpdate(
            {
              _id: transaction._id,
              status: { $in: REFUNDABLE_STATUSES },
              $expr: {
                $lte: [
                  {
                    $add: [
                      { $ifNull: ['$refundedAmount', 0] },
                      { $ifNull: ['$pendingRefundAmount', 0] },
                      refundAmount,
                    ],
                  },
                  '$amount',
                ],
              },
            },
            { $inc: { pendingRefundAmount: refundAmount } },
            { ...writeOpts, returnDocument: 'after' },
          );
          if (!r) {
            capBlocked = true;
            return; // cap hit or non-refundable status → reserved stays false
          }
          // ATOMIC CLAIM: the attempt's `attempt_command_identity` unique index. A
          // concurrent / retried refund with the SAME (org, refund, provider, key)
          // throws E11000 here → this withTransaction ABORTS, rolling back the `$inc`
          // reservation above, and the catch below loads the winner instead. Through the
          // repo (session-bound) so tenant scope + hooks stay consistent; the unique
          // index still fires (repo.create reaches Mongo).
          await attemptRepo.create(
            {
              _id: refundAttemptId,
              transactionId: transaction._id,
              operation: 'refund',
              provider: transaction.method,
              methodKind: transaction.methodKind,
              idempotencyKey: refundKey,
              amount: refundAmount,
              currency: transaction.currency,
              outcome: 'pending',
            } as never,
            this.optsFromCtx(ctx, { session }) as never,
          );
          reserved = true;
        },
        { allowFallback: this.allowNonTransactional });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // Someone already claimed this refund command. Replay a completed refund;
      // otherwise it is in-flight / unresolved — do NOT reverse again.
      const existingRefund = await this.getByQuery(
        { idempotencyKey: refundKey, type: 'refund' },
        this.optsFromCtx(ctx, { throwOnNotFound: false }),
      );
      if (existingRefund) return existingRefund as TransactionDocument;
      throw new ValidationError(
        'a refund for this idempotencyKey is already in progress or unresolved — ' +
          'reconcile the existing attempt before retrying (never reverse twice).',
        { transactionId, idempotencyKey: refundKey },
      );
    }
    if (!reserved) {
      // Cap hit or non-refundable status (a duplicate returned/threw above).
      throw new ValidationError(
        capBlocked
          ? 'refund exceeds captured amount'
          : `Transaction ${transactionId} refund could not be reserved (non-refundable status)`,
        { transactionId, requested: refundAmount },
      );
    }

    const provider = this.deps.providers.get(transaction.method);
    const paymentId = transaction.gateway?.paymentIntentId ?? transaction.gateway?.sessionId ?? transactionId;
    // Forward the idempotency key so a gateway that honours it (Stripe-style)
    // dedups a concurrent / retried first-time call at the source — no double
    // charge even before the local refund row exists. We are the unique CAS
    // winner, so this fires exactly once per logical refund.
    /**
     * The provider call, routed through the three-valued classifier.
     *
     * This used to be a bare try/catch that rolled the claim back on ANY error. That is
     * correct for a decline and catastrophic for a timeout: a timed-out reversal may well
     * have been processed upstream, and releasing the claim frees the amount for a second
     * refund. The customer gets their money twice and the books do not show why.
     */
    const refundCommand = buildPaymentCommandContext({
      operation: 'refund',
      subjectId: String(transaction._id),
      ...(transaction.organizationId ? { organizationId: transaction.organizationId } : {}),
      merchantReference: String(transaction._id),
      idempotencyKey: refundKey,
    });
    const outcome = await executeProviderCommand(
      () =>
        provider.refund(paymentId as string, refundAmount, refundCommand, {
          ...(options.reason !== undefined ? { reason: options.reason } : {}),
        }),
      {
        // Do NOT seed `providerReference` with the PAYMENT id. On a timeout it would be
        // stamped onto the refund attempt and later reused as `refundRef`, so Stripe's
        // `refunds.retrieve(pi_…)` would run instead of the metadata-matched
        // `refunds.list({ payment_intent })` fallback — leaving the refund unreconcilable
        // forever. `providerReference` must only ever hold a genuine refund id (`re_…`),
        // which we get from the provider RESULT, never the request. The payment id is
        // recovered from the transaction at reconcile time for the `paymentId` field.
        command: refundCommand,
      /**
       * The RAW provider error goes to the log, never into the result.
       *
       * `ProviderCommandResult.causeCode` is a closed set precisely because it is persisted
       * and shown to operators, and vendor errors carry URLs, tokens and request fragments.
       * But discarding the detail entirely is the opposite mistake — "payment skipped,
       * cause: unclassified" is unactionable. This seam is where the detail survives.
       */
      onDiagnostic: (error, ctxCommand) =>
        this.deps.logger?.error(
          '[revenue] provider command failed',
          {
            requestId: ctxCommand?.requestId,
            merchantReference: ctxCommand?.merchantReference,
            organizationId: ctxCommand?.organizationId,
          },
          error,
        ),
      },
    );

    if (outcome.outcome === 'unknown') {
      // OUTCOME NEVER OBSERVED — KEEP THE RESERVATION. The gateway may have processed
      // the reversal, so releasing `pendingRefundAmount` would free the amount for a
      // second refund. The reservation is the lock; the refund PaymentAttempt records
      // WHY it is held. The original transaction is NOT flipped to refunded — no refund
      // child, no event, no ledger reversal until the outcome is reconciled.
      const stamp: Record<string, unknown> = { outcome: 'unknown' };
      if (outcome.causeCode !== undefined) stamp.causeCode = outcome.causeCode;
      if (outcome.providerReference !== undefined) stamp.providerReference = outcome.providerReference;
      await attemptRepo
        .update(String(refundAttemptId), stamp as never, this.optsFromCtx(ctx) as never)
        .catch((err: unknown) =>
          this.deps.logger?.error(
            '[revenue] refund attempt unknown-stamp failed — reservation held but state invisible',
            { attemptId: refundAttemptId.toString(), transactionId: String(transaction._id) },
            err,
          ),
        );
      /**
       * ANNOUNCE the unobserved outcome — the third value, as its own fact.
       *
       * The reservation above is the safety mechanism; this is the SIGNAL. Without
       * it the state is correct and invisible: the amount stays locked, no refund
       * child exists, and nothing downstream knows a reconciliation is owed. An
       * operator sees a refund that neither succeeded nor failed.
       *
       * Emitted INSTEAD of `payment.failed`, never alongside it. Reporting failure
       * here licenses a retry, and if the gateway did process the reversal that
       * retry is a second refund — the asymmetry the whole three-valued contract
       * exists for.
       *
       * `idempotencyKey` rides along because it is what reconciliation asks the
       * provider with.
       */
      await this.dispatch(
        createEvent(
          PAYMENT_EVENT_TYPE.UNKNOWN,
          toPaymentUnknown({
            txn: transaction as unknown as CanonicalSourceTransaction,
            operation: 'refund',
            causeCode: outcome.causeCode ?? 'unclassified',
            occurredAt: new Date(),
            ...(refundKey !== undefined ? { idempotencyKey: refundKey } : {}),
          }),
          ctx,
          { resource: 'transaction', resourceId: (transaction as { publicId?: string }).publicId },
        ),
        ctx,
      );

      throw new RefundOutcomeUnknownError(String(transaction._id), refundAmount, {
        ...(outcome.providerReference !== undefined
          ? { providerReference: outcome.providerReference }
          : {}),
        ...(outcome.causeCode !== undefined ? { causeCode: outcome.causeCode } : {}),
      });
    }

    if (outcome.outcome === 'declined') {
      // A DECISION: no money moved → release the reservation once (shared helper, also
      // used by reconcileAttempt). If the release can't be confirmed, escalate to
      // unknown rather than tell the caller "declined, safe to retry".
      const { released } = await this.releaseRefundReservation(
        transaction,
        refundAmount,
        refundAttemptId,
        outcome.error.reason,
        ctx,
      );
      if (!released) {
        throw new RefundOutcomeUnknownError(String(transaction._id), refundAmount);
      }
      throw new ValidationError(
        `Refund declined by provider for transaction ${transactionId}: ${outcome.error.reason}`,
        { transactionId, reason: outcome.error.reason, retryable: outcome.error.retryable },
      );
    }

    // ── CONFIRMED — finalize once (shared helper, also used by reconcileAttempt) ──
    const { transaction: refundTxn } = await this.finalizeConfirmedRefund(
      transaction,
      refundAmount,
      refundKey,
      options.reason,
      refundAttemptId,
      ctx,
    );
    return refundTxn;
  }

  /**
   * Release a refund reservation and stamp its attempt `declined` — ATOMICALLY. Shared by
   * refund()'s decline path and reconcileAttempt. The attempt CAS (`pending`/`unknown` →
   * `declined`) and the `pendingRefundAmount` decrement commit in ONE transaction, so a
   * crash can never leave the attempt terminal with the reservation still held.
   *
   * Returns `{ released, won }`:
   *   - `won` — this call was the CAS winner (vs a concurrent/prior resolver). A loser
   *     (`won:false`) means someone else already handled it → `released:true` (idempotent).
   *   - `released` — the reservation decrement is durably applied. `released:false` (a lost
   *     reservation, or a transaction error) tells the caller to escalate to `unknown`
   *     rather than report a safe decline; the whole txn is rolled back in that case, so the
   *     attempt stays actionable for a later reconcile.
   */
  private async releaseRefundReservation(
    original: TransactionDocument,
    refundAmount: number,
    refundAttemptId: Types.ObjectId,
    declineReason: string,
    ctx: RevenueContext,
  ): Promise<{ released: boolean; won: boolean }> {
    const attemptRepo = this.deps.paymentAttempts;
    if (!attemptRepo) throw new ConfigurationError('PaymentAttempt repository is not wired.');
    try {
      return await withTransaction(
        this.Model.db as unknown as { startSession(): Promise<ClientSession> },
        async (session): Promise<{ released: boolean; won: boolean }> => {
          const writeOpts = this.optsFromCtx(ctx, { session });
          // (1) ATOMIC attempt CAS — the concurrency gate, now in the SAME txn as (2).
          const claimed = await attemptRepo.claim(
            String(refundAttemptId),
            { field: 'outcome', from: ['pending', 'unknown'], to: 'declined' },
            { declineReason },
            writeOpts,
          );
          if (!claimed) return { released: true, won: false }; // already resolved elsewhere
          // (2) release the reservation. A lost reservation is a real inconsistency →
          // ABORT so the attempt CAS rolls back too (stays actionable), and escalate.
          const rolledBack = await this.findOneAndUpdate(
            { _id: original._id, pendingRefundAmount: { $gte: refundAmount } },
            { $inc: { pendingRefundAmount: -refundAmount } },
            { ...writeOpts, returnDocument: 'after' },
          );
          if (!rolledBack) {
            throw new ValidationError('refund reservation lost before release', {
              transactionId: String(original._id),
              refundAmount,
            });
          }
          return { released: true, won: true };
        },
        { allowFallback: this.allowNonTransactional });
    } catch (rollbackErr) {
      this.deps.logger?.error(
        '[revenue] refund reservation release FAILED — reservation still held',
        { transactionId: String(original._id), refundAmount },
        rollbackErr,
      );
      return { released: false, won: false };
    }
  }

  /**
   * Finalize a CONFIRMED refund exactly once. Shared by refund()'s confirmed path and
   * reconcileAttempt. ONE transaction moves the reserved amount → `refundedAmount`, flips
   * the original's status (computed from the post-move total, guarded by the still-held
   * reservation so concurrent finalizes stay consistent), creates the refund child +
   * outbox event; then stamps the attempt confirmed, runs bridges, publishes. Idempotent:
   * once the reservation is consumed the guard fails, so it can never double-refund.
   */
  private async finalizeConfirmedRefund(
    original: TransactionDocument,
    refundAmount: number,
    refundKey: string,
    reason: string | undefined,
    refundAttemptId: Types.ObjectId,
    ctx: RevenueContext,
  ): Promise<{ transaction: TransactionDocument; won: boolean }> {
    const attemptRepo = this.deps.paymentAttempts;
    if (!attemptRepo) throw new ConfigurationError('PaymentAttempt repository is not wired.');
    const reversedCommission = reverseCommission(original.commission as any, original.amount, refundAmount);
    const reversedTax = original.tax ? reverseTax(
      { isApplicable: true, rate: 0, baseAmount: original.amount, taxAmount: original.tax, totalAmount: original.amount + original.tax, pricesIncludeTax: false },
      original.amount, refundAmount,
    ) : undefined;

    const pendingEvents: DomainEvent[] = [];
    let finalizedOriginal: TransactionDocument = original;
    let refundTransaction: TransactionDocument;
    try {
      refundTransaction = await withTransaction(this.Model.db as unknown as { startSession(): Promise<ClientSession> }, async (session) => {
      const writeOpts = this.optsFromCtx(ctx, { session });
      // (1) ATOMIC attempt CAS FIRST — pending/unknown → confirmed — in the SAME txn as the
      // reservation move + refund child + outbox row. All commit together or not at all, so
      // a crash can never leave the attempt terminal while the reservation stays reserved and
      // no child exists. A concurrent (or prior) resolver loses this CAS and aborts below —
      // this REPLACES the old claim-in-a-separate-transaction gate.
      const claimed = await attemptRepo.claim(
        String(refundAttemptId),
        { field: 'outcome', from: ['pending', 'unknown'], to: 'confirmed' },
        {},
        writeOpts,
      );
      if (!claimed) throw new AttemptAlreadyResolvedError();
      const current = (await this.getById(String(original._id), writeOpts)) as TransactionDocument;
      const newRefunded = (current.refundedAmount ?? 0) + refundAmount;
      const isPartial = newRefunded < original.amount;
      const newStatus = isPartial ? TRANSACTION_STATUS.PARTIALLY_REFUNDED : TRANSACTION_STATUS.REFUNDED;

      const finalized = (await this.findOneAndUpdate(
        { _id: original._id, pendingRefundAmount: { $gte: refundAmount } },
        {
          $inc: { refundedAmount: refundAmount, pendingRefundAmount: -refundAmount },
          $set: { status: newStatus, refundedAt: new Date() },
        },
        { ...writeOpts, returnDocument: 'after' },
      )) as TransactionDocument | null;
      if (!finalized) {
        throw new ValidationError(
          `Transaction ${String(original._id)} refund reservation was lost before finalize`,
          { transactionId: String(original._id), refundAmount },
        );
      }
      finalizedOriginal = finalized;

      const refundTxn = await this.create({
        organizationId: original.organizationId, customerId: original.customerId,
        type: 'refund', flow: 'outflow', tags: ['refund'],
        amount: refundAmount, currency: original.currency,
        fee: reversedCommission?.gatewayFeeAmount ?? 0,
        tax: reversedTax?.taxAmount ?? 0,
        net: refundAmount - (reversedCommission?.gatewayFeeAmount ?? 0) - (reversedTax?.taxAmount ?? 0),
        method: original.method, methodKind: original.methodKind, status: TRANSACTION_STATUS.VERIFIED,
        gateway: original.gateway, commission: reversedCommission ?? undefined,
        relatedTransactionId: original._id,
        sourceId: original.sourceId, sourceModel: original.sourceModel,
        verifiedAt: new Date(),
        idempotencyKey: refundKey,
        metadata: { reason },
      } as any, writeOpts);

      /**
       * CANONICAL `payment.refunded` — one portable fact, not two.
       *
       * The old payload was `{ transaction, refundTransaction, refundAmount,
       * reason, isPartialRefund }`, where the two transactions were raw
       * documents and `refundAmount` was a bare number with no currency. A
       * consumer had to know revenue's schema to read it, and could not
       * interpret the amount in a multi-currency deployment.
       *
       * `revenue:payment.refunded` is NOT also emitted: a consumer subscribed to
       * both would process one refund twice, and the second looks exactly like a
       * legitimate second refund.
       */
      const event = createEvent(
        PAYMENT_EVENT_TYPE.REFUNDED,
        toPaymentRefunded({
          original: finalized as unknown as CanonicalSourceTransaction,
          refund: refundTxn as unknown as CanonicalSourceTransaction,
          refundedAmount: refundAmount,
          occurredAt: new Date(),
          reason,
        }),
        ctx,
        { resource: 'transaction', resourceId: (finalized as any).publicId },
      );
      await this.saveToOutbox(event, session);
      pendingEvents.push(event);
      return refundTxn;
      },
        { allowFallback: this.allowNonTransactional });
    } catch (err) {
      if (err instanceof AttemptAlreadyResolvedError) {
        // A concurrent (or prior) writer resolved this exact attempt. This method's contract
        // is to return the REFUND transaction — never the original payment. So:
        //   confirmed → return the refund child the winner created;
        //   confirmed but no child → invariant violation (fail loud);
        //   declined → the winner did NOT refund → surface unknown for manual reconciliation.
        const existing = (await this.getByQuery(
          { idempotencyKey: refundKey, type: 'refund' },
          this.optsFromCtx(ctx, { throwOnNotFound: false }),
        )) as TransactionDocument | null;
        if (existing) return { transaction: existing, won: false };
        const resolved = (await this.deps.paymentAttempts?.getById(
          String(refundAttemptId),
          this.optsFromCtx(ctx, { throwOnNotFound: false }),
        )) as PaymentAttemptDocument | null;
        if (resolved?.outcome === 'declined') {
          // The winning resolver released the reservation — no money moved. Do not pretend
          // a refund happened; signal unknown so the caller reconciles rather than retries.
          throw new RefundOutcomeUnknownError(String(original._id), refundAmount);
        }
        throw new ValidationError(
          'refund attempt was resolved without a refund child — invariant violated',
          {
            transactionId: String(original._id),
            refundAttemptId: String(refundAttemptId),
            resolvedOutcome: resolved?.outcome ?? 'missing',
          },
        );
      }
      throw err;
    }

    // The attempt outcome is stamped INSIDE the transaction now (the CAS above) — no
    // separate best-effort confirm-stamp, which was the non-atomic step being removed.
    await this.deps.bridges.ledger?.onRefundProcessed?.(finalizedOriginal as any, refundTransaction as any, ctx);
    await this.deps.bridges.notification?.onRefundProcessed?.(refundTransaction as any, ctx);

    for (const ev of pendingEvents) await this.publishToTransport(ev);

    return { transaction: refundTransaction, won: true };
  }

  /**
   * RECONCILE a stuck attempt by asking the provider what actually happened (§4.5 phase 3).
   *
   * Only `pending`/`unknown` attempts are actionable — a terminal one is a no-op, so this
   * is safe to call repeatedly and from the scanner. Resolutions reuse the SAME
   * finalize/release helpers as refund(), so a confirmed refund is finalized ONCE and a
   * declined one is released ONCE; a genuinely-uncertain outcome is retained for a later
   * pass. A confirmed create-intent with no local transaction is left for an operator
   * rather than fabricating a transaction without its business context.
   */
  async reconcileAttempt(
    attemptId: string,
    ctx: RevenueContext = {},
  ): Promise<{ attemptId: string; previousOutcome: string; resolved: boolean; resolvedOutcome?: string; note?: string }> {
    const attemptRepo = this.deps.paymentAttempts;
    if (!attemptRepo) throw new ConfigurationError('PaymentAttempt repository is not wired.');

    // SCOPED read (#5): on a tenant-scoped engine an operator can only reconcile an
    // attempt their ctx is scoped to; the scanner passes the attempt's own org.
    const attempt = (await attemptRepo.getById(
      attemptId,
      this.optsFromCtx(ctx, { throwOnNotFound: false }),
    )) as PaymentAttemptDocument | null;
    if (!attempt) throw new ValidationError('payment attempt not found (or out of scope)', { attemptId });

    const previousOutcome = attempt.outcome;
    // Terminal = declined, or a create-intent/refund already confirmed AND linked. A
    // create-intent confirmed-but-UNLINKED (#3) is NOT terminal — it still needs relinking.
    const terminal =
      attempt.outcome === 'declined' ||
      (attempt.outcome === 'confirmed' && attempt.transactionId != null);
    if (terminal) return { attemptId, previousOutcome, resolved: false, note: 'already terminal' };

    // All subsequent reads/writes run under the attempt's OWN branch scope (#5).
    const ctxScoped: RevenueContext = attempt.organizationId
      ? { ...ctx, organizationId: attempt.organizationId }
      : ctx;
    const provider = this.deps.providers.get(attempt.provider);

    if (attempt.operation === 'refund') {
      const original = (await this.getById(
        String(attempt.transactionId),
        this.optsFromCtx(ctxScoped, { throwOnNotFound: false }),
      )) as TransactionDocument | null;
      if (!original) return { attemptId, previousOutcome, resolved: false, note: 'original transaction missing' };

      // #1: ask about the REFUND, never the payment. A provider without a refund-status
      // lookup cannot be auto-reconciled → RETAIN the reservation (no misclassification).
      if (typeof provider.getRefundStatus !== 'function') {
        return { attemptId, previousOutcome, resolved: false, note: 'provider has no refund-status lookup — reservation retained' };
      }
      const paymentId =
        original.gateway?.paymentIntentId ?? original.gateway?.sessionId ?? String(original._id);
      const status = await executeProviderCommand(() =>
        provider.getRefundStatus!({
          paymentId,
          idempotencyKey: attempt.idempotencyKey,
          ...(attempt.providerReference ? { refundRef: attempt.providerReference } : {}),
        }),
      );

      if (status.outcome === 'confirmed' && status.value.status === 'succeeded') {
        // #1/#4: the attempt CAS (pending/unknown → confirmed), the reserved→refunded move,
        // the refund child and the outbox row all commit ATOMICALLY inside
        // finalizeConfirmedRefund. There is NO separate pre-claim in its own transaction —
        // that was the crash-consistency hole. `won` elects a single winner among concurrent
        // reconciles, so finalize runs exactly once.
        const { won } = await this.finalizeConfirmedRefund(
          original,
          attempt.amount,
          attempt.idempotencyKey,
          undefined,
          attempt._id as Types.ObjectId,
          ctxScoped,
        );
        return won
          ? { attemptId, previousOutcome, resolved: true, resolvedOutcome: 'confirmed' }
          : { attemptId, previousOutcome, resolved: false, note: 'concurrently reconciled' };
      }
      if (status.outcome === 'confirmed' && status.value.status === 'failed') {
        // Same atomicity: the attempt CAS → declined and the reservation release commit in
        // ONE transaction inside releaseRefundReservation; `won` is the single-winner flag.
        const { won } = await this.releaseRefundReservation(
          original,
          attempt.amount,
          attempt._id as Types.ObjectId,
          'reconciled: provider reports refund did not succeed',
          ctxScoped,
        );
        return won
          ? { attemptId, previousOutcome, resolved: true, resolvedOutcome: 'declined' }
          : { attemptId, previousOutcome, resolved: false, note: 'concurrently reconciled' };
      }
      return { attemptId, previousOutcome, resolved: false, note: 'provider refund status uncertain — reservation retained' };
    }

    // ── create-intent ──
    // #3: confirmed-but-unlinked → the intent succeeded and a transaction exists under
    // the same key but the link write was lost. Relink it (idempotent).
    if (attempt.transactionId == null) {
      const linked = (await this.getByQuery(
        { idempotencyKey: attempt.idempotencyKey },
        this.optsFromCtx(ctxScoped, { throwOnNotFound: false }),
      )) as TransactionDocument | null;
      if (linked) {
        await attemptRepo.update(
          String(attempt._id),
          { transactionId: linked._id, outcome: 'confirmed' } as never,
          this.optsFromCtx(ctxScoped) as never,
        );
        return { attemptId, previousOutcome, resolved: true, resolvedOutcome: 'confirmed', note: 'relinked to existing transaction' };
      }
    } else {
      // pending/unknown but a transaction already exists → just confirm the attempt.
      const claimed = await attemptRepo.claim(
        String(attempt._id),
        { field: 'outcome', from: ['pending', 'unknown'], to: 'confirmed' },
        {},
        this.optsFromCtx(ctxScoped),
      );
      return { attemptId, previousOutcome, resolved: claimed != null, resolvedOutcome: 'confirmed' };
    }

    const providerRef = attempt.gateway?.paymentIntentId ?? attempt.gateway?.sessionId ?? attempt.providerReference;
    if (!providerRef) {
      // No intent id ever recorded — the provider call never returned one. The required
      // stable idempotency key makes the caller's same-key retry safe (re-driven on
      // create); there is nothing to resolve server-side.
      return { attemptId, previousOutcome, resolved: false, note: 'no provider reference — awaiting same-key retry' };
    }
    const status = await executeProviderCommand(() => provider.getStatus(providerRef));
    if (status.outcome === 'confirmed' && status.value.status === 'failed') {
      const claimed = await attemptRepo.claim(
        String(attempt._id),
        { field: 'outcome', from: ['pending', 'unknown'], to: 'declined' },
        { declineReason: 'reconciled: provider reports intent did not succeed' },
        this.optsFromCtx(ctxScoped),
      );
      return { attemptId, previousOutcome, resolved: claimed != null, resolvedOutcome: 'declined' };
    }
    // Live-but-orphan intent, or still uncertain → operator reconciliation (we will not
    // fabricate a transaction without customer / source / monetization context).
    return { attemptId, previousOutcome, resolved: false, note: 'intent live but no local transaction — operator reconciliation required' };
  }

  /**
   * Drain the reconciliation worklist: scan attempts stuck `pending`/`unknown` (or a
   * create-intent confirmed-but-UNLINKED, #3) past `olderThanMs` (default 15m) and
   * reconcile each UNDER ITS OWN BRANCH SCOPE (#5) — the scan is a cross-branch worklist
   * read (like the outbox relay), but each reconcile derives `organizationId` from the
   * attempt. The verb a host schedules on a timer.
   */
  async scanStaleAttempts(
    options: { olderThanMs?: number; limit?: number } = {},
  ): Promise<{ scanned: number; resolved: number; retained: number }> {
    const attemptRepo = this.deps.paymentAttempts;
    if (!attemptRepo) throw new ConfigurationError('PaymentAttempt repository is not wired.');
    const olderThanMs = options.olderThanMs ?? 15 * 60_000;
    const cutoff = new Date(Date.now() - olderThanMs);
    // Cross-branch worklist read (like the outbox relay): `systemContext()` is mongokit's
    // canonical "outside any tenant scope" opts bag ({ bypassTenant: true }), so this runs
    // through the repository pipeline — auditable via `after:tenant-bypass` — instead of a
    // raw model find. Each item is then reconciled UNDER ITS OWN branch scope below (#5).
    const stale = (await attemptRepo.findAll(
      {
        createdAt: { $lt: cutoff },
        $or: [
          { outcome: { $in: ['pending', 'unknown'] } },
          { operation: 'create-intent', outcome: 'confirmed', transactionId: null },
        ],
      },
      { ...systemContext(), sort: { createdAt: 1 }, limit: options.limit ?? 100 },
    )) as unknown as Array<{ _id: unknown; organizationId?: string }>;

    let resolved = 0;
    let retained = 0;
    for (const a of stale) {
      try {
        const r = await this.reconcileAttempt(
          String(a._id),
          a.organizationId ? { organizationId: a.organizationId } : {},
        );
        if (r.resolved) resolved += 1;
        else retained += 1;
      } catch (err) {
        retained += 1;
        this.deps.logger?.error('[revenue] reconcileAttempt failed', { attemptId: String(a._id) }, err);
      }
    }
    return { scanned: stale.length, resolved, retained };
  }

  /**
   * Refund READ MODEL (phase 3) — the Refund view PROJECTED over records, never a
   * stored collection (§4.5: "do not migrate rows"). Confirmed refunds ARE the child
   * transactions (`type:'refund'`, `relatedTransactionId`); in-flight / failed refunds
   * come from the refund `PaymentAttempt` rows (pending / unknown / declined) that have
   * no confirmed child yet — so an operator sees a timed-out reversal awaiting
   * reconciliation, not just the settled ones. The summary reads the aggregate counters.
   */
  async listRefunds(transactionId: string, ctx: RevenueContext = {}): Promise<RefundSummary> {
    const original = (await this.getById(
      transactionId,
      this.optsFromCtx(ctx, { throwOnNotFound: false }),
    )) as TransactionDocument | null;
    if (!original) throw new TransactionNotFoundError(transactionId);

    const childrenRes = await this.getAll(
      { filters: { type: 'refund', relatedTransactionId: original._id } } as never,
      this.optsFromCtx(ctx) as never,
    );
    const children = (((childrenRes as { data?: unknown })?.data ?? childrenRes) ?? []) as TransactionDocument[];

    const refunds: RefundView[] = children.map((c) => ({
      id: String(c._id),
      source: 'transaction' as const,
      amount: c.amount,
      currency: c.currency,
      status: 'succeeded' as const,
      createdAt: c.createdAt,
      ...((c.metadata as { reason?: string } | undefined)?.reason
        ? { reason: (c.metadata as { reason?: string }).reason }
        : {}),
      ...(c.idempotencyKey ? { idempotencyKey: c.idempotencyKey } : {}),
    }));

    const attemptRepo = this.deps.paymentAttempts;
    if (attemptRepo) {
      // Scoped read through the repo — the multi-tenant plugin injects the org filter from
      // ctx (no hand-rolled `organizationId` clause that would drift from the tenant policy).
      const inflight = (await attemptRepo.findAll(
        {
          operation: 'refund',
          transactionId: original._id,
          outcome: { $in: ['pending', 'unknown', 'declined'] },
        },
        this.optsFromCtx(ctx),
      )) as unknown as PaymentAttemptDocument[];
      for (const a of inflight) {
        refunds.push({
          id: String(a._id),
          source: 'attempt',
          amount: a.amount,
          currency: a.currency,
          status: a.outcome as 'pending' | 'unknown' | 'declined',
          createdAt: a.createdAt,
          ...(a.providerReference ? { providerReference: a.providerReference } : {}),
          ...(a.causeCode ? { causeCode: a.causeCode } : {}),
          ...(a.declineReason ? { reason: a.declineReason } : {}),
          ...(a.idempotencyKey ? { idempotencyKey: a.idempotencyKey } : {}),
        });
      }
    }

    refunds.sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime());

    return {
      refundedAmount: original.refundedAmount ?? 0,
      pendingRefundAmount: original.pendingRefundAmount ?? 0,
      refunds,
    };
  }

  /**
   * The payment's attempt HISTORY, oldest first — every provider round-trip, not just
   * the last one.
   *
   * This is the read phase 3 exists for. The embedded `gateway` block on the parent has
   * only ever had room for ONE attempt, so "three declines then a success" was
   * structurally unrepresentable before the `PaymentAttempt` collection; writing the
   * rows without a way to read them would leave the capability real and unreachable.
   *
   * Scoped through the repo (never a raw `find`), so the tenant filter is injected from
   * `ctx` by the same plugin as every other read — a hand-rolled `organizationId` clause
   * is how one branch's payment history leaks into another's.
   *
   * Returns an EMPTY history rather than throwing when the attempt repository is not
   * wired: a deployment that predates phase 3 has no attempts, which is a true answer.
   * The write path is the one that must refuse (`ConfigurationError`) — a payment taken
   * with no attempt row is unreconcilable, whereas an empty read is merely empty.
   */
  async listAttempts(transactionId: string, ctx: RevenueContext = {}): Promise<PaymentAttemptHistory> {
    const original = (await this.getById(
      transactionId,
      this.optsFromCtx(ctx, { throwOnNotFound: false }),
    )) as TransactionDocument | null;
    if (!original) throw new TransactionNotFoundError(transactionId);

    const attemptRepo = this.deps.paymentAttempts;
    const empty: PaymentAttemptHistory = {
      attempts: [],
      confirmedCount: 0,
      declinedCount: 0,
      unknownCount: 0,
      pendingCount: 0,
    };
    if (!attemptRepo) return empty;

    const rows = (await attemptRepo.findAll(
      { transactionId: original._id },
      this.optsFromCtx(ctx),
    )) as unknown as PaymentAttemptDocument[];

    const attempts: PaymentAttemptView[] = rows
      .map((a) => ({
        id: String(a._id),
        operation: a.operation,
        provider: a.provider,
        outcome: a.outcome,
        amount: a.amount,
        currency: a.currency,
        createdAt: a.createdAt,
        ...(a.methodKind ? { methodKind: a.methodKind as string } : {}),
        // `causeCode` only — `declineReason` holds the provider's raw text.
        ...(a.causeCode ? { causeCode: a.causeCode } : {}),
        ...(a.providerReference ? { providerReference: a.providerReference } : {}),
        ...(a.idempotencyKey ? { idempotencyKey: a.idempotencyKey } : {}),
      }))
      .sort((x, y) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime());

    const count = (o: PaymentAttemptView['outcome']) => attempts.filter((a) => a.outcome === o).length;
    return {
      attempts,
      confirmedCount: count('confirmed'),
      declinedCount: count('declined'),
      unknownCount: count('unknown'),
      pendingCount: count('pending'),
    };
  }
}
