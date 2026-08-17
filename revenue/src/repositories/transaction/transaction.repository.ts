import { withTransaction, isDuplicateKeyError, type PluginType } from '@classytic/mongokit';
import type { ClientSession, Model } from 'mongoose';
import { Types } from 'mongoose';
import type { TransactionDocument } from '../../models/transaction.schema.js';
import type { RevenueContext } from '../../core/context.js';
import { executeProviderCommand } from '../../providers/execute-command.js';
import { buildPaymentCommandContext } from '../../providers/command-context.js';
import { currencyCode } from '@classytic/primitives/currency';
import type { DomainEvent } from '@classytic/primitives/events';
import type { PaymentMethodKind } from '@classytic/primitives/payment-method-kind';
import { PAYMENT_EVENT_TYPE } from '@classytic/primitives/payment-events';
import {
  toPaymentFailed,
  toPaymentSucceeded,
  type CanonicalSourceTransaction,
} from '../../events/canonical-payment-events.js';
import { createEvent } from '../../events/helpers.js';
import { REVENUE_EVENTS } from '../../events/event-constants.js';
import { TRANSACTION_STATUS } from '../../enums/transaction.enums.js';
import { HOLD_STATUS } from '../../enums/escrow.enums.js';
import { TRANSACTION_STATE_MACHINE } from '../../core/state-machines.js';
import {
  ConfigurationError,
  TransactionNotFoundError,
  ValidationError,
  WebhookSignatureError,
  IntentOutcomeUnknownError,
  AlreadySplitError,
} from '../../core/errors.js';
import { calculateCommission } from '../../shared/calculators/commission.js';
import { calculateSplits, calculateOrganizationPayout } from '../../shared/calculators/splits.js';
import { TransactionRefundRepository } from './refund.repository.js';

/**
 * Common webhook-signature header names across gateways (Stripe, GitHub-style
 * HMAC, generic). Read case-insensitively so a host can forward headers in any
 * casing. Returns `''` when none present — the provider's
 * `verifyWebhookSignature` decides whether a missing signature is acceptable
 * (the base accept-all default says yes; a real gateway override says no).
 */
const WEBHOOK_SIGNATURE_HEADERS = [
  'stripe-signature',
  'x-signature',
  'x-webhook-signature',
  'x-hub-signature-256',
  'x-hub-signature',
  'x-razorpay-signature',
  'verify-signature',
] as const;

/**
 * Hold states that still have funds in escrow. Named once so the pre-CAS message
 * check, the in-transaction re-check and the `$in` inside the CAS filter can never
 * disagree — a second allowed-state list beside a CAS is exactly how a guard goes
 * quietly out of sync with the write it is supposed to protect.
 */
const ACTIVE_HOLD_STATUSES: string[] = [HOLD_STATUS.HELD, HOLD_STATUS.PARTIALLY_RELEASED];

function extractWebhookSignature(headers?: Record<string, string>): string {
  if (!headers) return '';
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  for (const name of WEBHOOK_SIGNATURE_HEADERS) {
    const val = lower[name];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return '';
}
/**
 * TransactionRepository — extends mongokit Repository.
 *
 * **Two lifecycles, one collection.** Revenue 3.0 introduced a `kind`
 * discriminator so the same repository handles three distinct flows
 * over a single audit-quality collection:
 *
 *   - `'payment_flow'` — Stripe / SSL / bKash / manual gateway lifecycle
 *     (createPaymentIntent → verify → refund → webhook + escrow).
 *   - `'bank_feed'`    — Plaid / OFX / QBO / Xero / CSV imports
 *     (import → match → journalize | reject; un-match supported).
 *   - `'manual'`       — hand-keyed entries (treasurer cash deposits,
 *     capital injections) with a clean `pending → matched → journalized`
 *     graph.
 *
 * Each lifecycle has its own state machine (`smFor(kind)`); the repo
 * verbs gate by `kind` via `claim()`'s `where:` predicate so cross-kind
 * state corruption is impossible at the database layer.
 *
 * **Inherited from mongokit:** getAll, getById, getByQuery, create,
 * update, delete, count, exists, claim, claimVersion, cursor, updateMany,
 * deleteMany. With `batchOperationsPlugin` wired (default in
 * `defineRevenue`), `bulkWrite` is also available — `import()` uses it.
 *
 * **Domain verbs (state transitions):**
 *   payment_flow: createPaymentIntent, verify, refund, handleWebhook,
 *                 hold, release, split
 *   bank_feed:    import, match, unmatch, journalize, reject,
 *                 removeByFeed, drainSync, parseAndImport
 *   manual:       createManual (then match / journalize / reject)
 *   read helpers: findMatchCandidates, getRunningBalance
 *
 * All domain verbs return raw mongokit docs — no custom envelopes
 * (PACKAGE_RULES §4). Composite results store the secondary docs on
 * the primary's `metadata` / `relatedTransactionId`.
 */
export class TransactionRepository extends TransactionRefundRepository {
  constructor(model: Model<TransactionDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  // ─── Domain: Create Payment Intent ───

  /** Creates transaction + calls provider. Returns the created transaction doc. */
  async createPaymentIntent(params: {
    data?: Record<string, unknown>;
    planKey?: string;
    monetizationType?: string;
    amount: number;
    currency?: string;
    gateway: string;
    methodKind: PaymentMethodKind;
    paymentData?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  }, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    // Inbound API boundary. `?? default` on an INVALID code would silently
    // re-denominate the payment into the engine default — the charge still
    // goes out, for a plausible-looking wrong amount. Absent ⇒ default;
    // present ⇒ must be valid.
    const currency =
      params.currency === undefined
        ? this.deps.defaultCurrency
        : currencyCode(params.currency);
    const provider = this.deps.providers.get(params.gateway);

    // Idempotency
    if (params.idempotencyKey) {
      const existing = await this.getByQuery(
        { idempotencyKey: params.idempotencyKey },
        this.optsFromCtx(ctx, { throwOnNotFound: false }),
      );
      if (existing) return existing;
    }

    // Commission
    const commissionRate = this.deps.commission?.defaultRate ?? 0;
    const gatewayFeeRate = this.deps.commission?.gatewayFeeRate ?? 0;
    const commission = calculateCommission(params.amount, commissionRate, gatewayFeeRate);

    // Provider call (skip for free)
    let gatewayData: Record<string, unknown> = { type: params.gateway };
    let effectiveIdempotencyKey = params.idempotencyKey;
    let createAttemptId: Types.ObjectId | undefined;
    if (params.amount > 0) {
      const attemptRepo = this.deps.paymentAttempts;
      if (!attemptRepo) {
        throw new ConfigurationError(
          'PaymentAttempt repository is not wired — defineRevenue must register it at bind (phase 3 core).',
        );
      }
      // Scope BEFORE any provider I/O. The attempt write below would reject a
      // missing org on a tenant-scoped engine anyway, but assert it explicitly so
      // the failure is a clean 4xx rather than a driver error mid-flight.
      if (this.deps.tenantScopeEnabled && !ctx.organizationId) {
        throw new ValidationError(
          'organizationId is required for create-intent on a tenant-scoped engine — ' +
            'refusing to contact the payment provider without branch scope',
          { operation: 'create-intent' },
        );
      }

      /**
       * REQUIRE a stable caller key, then CLAIM atomically before the provider call.
       *
       * The key MUST be caller-supplied and stable across retries (spine-order derives
       * it from the order id). Deriving it from a fresh attempt id — as an earlier draft
       * did — makes every retry a NEW provider operation, so a lost response after a
       * successful charge double-charges. Creating the attempt is the atomic claim: the
       * `attempt_command_identity` unique index means a concurrent or retried request
       * with the same (org, operation, provider, key) loses with a duplicate-key error
       * and LOADS the winner's attempt instead of contacting the provider again.
       */
      if (!params.idempotencyKey) {
        throw new ValidationError(
          'idempotencyKey is required for payment creation: it must be stable across ' +
            'retries (e.g. derived from the order/invoice/checkout id) so a lost-response ' +
            'retry reuses the same provider operation instead of charging twice.',
          { operation: 'create-intent' },
        );
      }
      const intentKey = params.idempotencyKey;
      effectiveIdempotencyKey = intentKey;
      createAttemptId = new Types.ObjectId();
      try {
        await attemptRepo.create(
          {
            _id: createAttemptId,
            operation: 'create-intent',
            provider: params.gateway,
            methodKind: params.methodKind,
            idempotencyKey: intentKey,
            amount: params.amount,
            currency,
            outcome: 'pending',
          } as never,
          this.optsFromCtx(ctx),
        );
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // This command identity is already claimed. Load it (branch-scoped):
        const claimedBy = (await attemptRepo.getByQuery(
          {
            operation: 'create-intent',
            provider: params.gateway,
            idempotencyKey: intentKey,
          },
          this.optsFromCtx(ctx, { throwOnNotFound: false }),
        )) as { _id?: unknown; transactionId?: unknown } | null;
        if (claimedBy?.transactionId) {
          // Already produced a transaction → replay it (idempotent).
          const txn = await this.getById(
            String(claimedBy.transactionId),
            this.optsFromCtx(ctx, { throwOnNotFound: false }),
          );
          if (txn) return txn as TransactionDocument;
        }
        // #2: pending/unknown claim (in-flight or a lost-response orphan). RE-DRIVE
        // rather than deadlock: reuse the existing attempt and fall through to the
        // provider call with the SAME key — the provider dedups, so a same-key retry
        // completes the payment instead of being rejected by its own claim. The
        // transaction create below is guarded against the concurrent winner (E11000
        // → replay), so two racing re-drives converge on ONE transaction.
        if (claimedBy?._id) {
          createAttemptId = claimedBy._id as Types.ObjectId;
        }
      }

      const intentCommand = buildPaymentCommandContext({
        operation: 'create-intent',
        subjectId: intentKey,
        ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
        idempotencyKey: intentKey,
      });
      const intentOutcome = await executeProviderCommand(
        () =>
          provider.createIntent(
            {
              amount: { amount: params.amount, currency },
              methodKind: params.methodKind,
              metadata: params.metadata, ...params.paymentData,
            },
            intentCommand,
          ),
        {
          command: intentCommand,
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

      if (intentOutcome.outcome !== 'confirmed') {
        /**
         * Neither a confirmed intent nor a clean decline can be treated the same way here.
         *
         * `declined` is safe: nothing was created upstream, so failing the call is honest.
         * `unknown` is NOT — the gateway may hold a live intent we never recorded. We raise a
         * distinct error so a caller cannot mistake it for a decline and immediately retry;
         * the idempotency key makes the eventual retry safe AT the gateway, and the
         * `PaymentAttempt` row (stamped just below) makes the orphan visible to US.
         */
        // Record the terminal attempt outcome — durable evidence of a decline or an
        // unobserved (unknown) intent. Non-silent: a failed stamp is logged, not swallowed.
        const stamp: Record<string, unknown> = { outcome: intentOutcome.outcome };
        if (intentOutcome.outcome === 'declined') {
          stamp.declineReason = intentOutcome.error.reason;
        } else {
          if (intentOutcome.causeCode !== undefined) stamp.causeCode = intentOutcome.causeCode;
          if (intentOutcome.providerReference !== undefined) {
            stamp.providerReference = intentOutcome.providerReference;
          }
        }
        await attemptRepo
          .update(String(createAttemptId), stamp as never, this.optsFromCtx(ctx) as never)
          .catch((err: unknown) =>
            this.deps.logger?.error(
              '[revenue] payment attempt outcome stamp failed',
              { attemptId: createAttemptId?.toString() },
              err,
            ),
          );

        if (intentOutcome.outcome === 'declined') {
          throw new ValidationError(
            `Payment intent declined by provider: ${intentOutcome.error.reason}`,
            { reason: intentOutcome.error.reason, retryable: intentOutcome.error.retryable },
          );
        }
        throw new IntentOutcomeUnknownError(intentCommand.idempotencyKey, {
          ...(intentOutcome.causeCode !== undefined ? { causeCode: intentOutcome.causeCode } : {}),
        });
      }
      const intent = intentOutcome.value;
      gatewayData = {
        type: params.gateway,
        sessionId: intent.sessionId,
        paymentIntentId: intent.paymentIntentId ?? intent.id,
        metadata: {
          clientSecret: intent.clientSecret,
          paymentUrl: intent.paymentUrl,
          instructions: intent.instructions,
        },
      };
      // Attempt confirmed — record the gateway identifiers on the durable row.
      await attemptRepo
        .update(
          String(createAttemptId),
          {
            outcome: 'confirmed',
            gateway: {
              sessionId: intent.sessionId,
              paymentIntentId: intent.paymentIntentId ?? intent.id,
            },
          } as never,
          this.optsFromCtx(ctx) as never,
        )
        .catch((err: unknown) =>
          this.deps.logger?.error(
            '[revenue] payment attempt confirm stamp failed',
            { attemptId: createAttemptId?.toString() },
            err,
          ),
        );
    }

    let transaction: TransactionDocument;
    try {
      transaction = (await this.create(
        {
          organizationId: ctx.organizationId,
          customerId: params.data?.customerId ?? null,
          type: params.monetizationType === 'subscription' ? 'subscription' : 'purchase',
          flow: 'inflow',
          tags: params.monetizationType ? [params.monetizationType] : [],
          amount: params.amount, currency,
          fee: commission?.gatewayFeeAmount ?? 0, tax: 0,
          net: params.amount - (commission?.gatewayFeeAmount ?? 0),
          method: params.gateway,
          methodKind: params.methodKind,
          status: params.amount === 0 ? TRANSACTION_STATUS.VERIFIED : TRANSACTION_STATUS.PENDING,
          gateway: gatewayData,
          commission: commission ?? undefined,
          sourceId: params.data?.sourceId,
          sourceModel: params.data?.sourceModel as string,
          idempotencyKey: effectiveIdempotencyKey,
          metadata: params.metadata,
        } as any,
        this.optsFromCtx(ctx),
      )) as TransactionDocument;
    } catch (err) {
      // #2 re-drive convergence: a concurrent same-key request already created the
      // transaction (unique idempotencyKey index) — replay it instead of erroring.
      if (isDuplicateKeyError(err) && effectiveIdempotencyKey) {
        const existing = await this.getByQuery(
          { idempotencyKey: effectiveIdempotencyKey },
          this.optsFromCtx(ctx, { throwOnNotFound: false }),
        );
        if (existing) return existing as TransactionDocument;
      }
      throw err;
    }

    // Link the durable attempt to the transaction it produced. Non-silent — a
    // failed link leaves an attempt with no `transactionId`, which the
    // reconciliation worklist reads as "confirmed intent, transaction unknown".
    if (createAttemptId) {
      await this.deps.paymentAttempts
        ?.update(
          String(createAttemptId),
          { transactionId: transaction._id } as never,
          this.optsFromCtx(ctx) as never,
        )
        .catch((err: unknown) =>
          this.deps.logger?.error(
            '[revenue] payment attempt transaction link failed',
            { attemptId: createAttemptId?.toString(), transactionId: String(transaction._id) },
            err,
          ),
        );
    }

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.MONETIZATION_CREATED,
        { monetizationType: params.monetizationType, transaction },
        ctx,
        { resource: 'transaction', resourceId: (transaction as any).publicId },
      ),
      ctx,
    );

    return transaction;
  }

  // ─── Domain: Verify ───

  /** Verifies payment via provider, updates status. Returns the updated doc. */
  async verify(paymentIntentId: string, options: { verifiedBy?: string } = {}, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    const readOpts = this.optsFromCtx(ctx, { throwOnNotFound: false });
    let transaction = await this.getByQuery({ 'gateway.sessionId': paymentIntentId }, readOpts);
    if (!transaction) transaction = await this.getByQuery({ 'gateway.paymentIntentId': paymentIntentId }, readOpts);
    if (!transaction) transaction = await this.getById(paymentIntentId, readOpts) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(paymentIntentId);

    const provider = this.deps.providers.get(transaction.method);
    const intentId = transaction.gateway?.paymentIntentId ?? transaction.gateway?.sessionId ?? paymentIntentId;
    const paymentResult = await provider.verifyPayment(intentId as string);

    let newStatus: string;
    if (paymentResult.status === 'succeeded') newStatus = TRANSACTION_STATUS.VERIFIED;
    else if (paymentResult.status === 'failed') newStatus = TRANSACTION_STATUS.FAILED;
    else if (paymentResult.status === 'requires_action') newStatus = TRANSACTION_STATUS.REQUIRES_ACTION;
    else newStatus = TRANSACTION_STATUS.PROCESSING;

    const set: Record<string, unknown> = {};
    if (newStatus === TRANSACTION_STATUS.VERIFIED) {
      set.verifiedAt = new Date();
      set.verifiedBy = options.verifiedBy;
    } else if (newStatus === TRANSACTION_STATUS.FAILED) {
      set.failedAt = new Date();
      set.failureReason = 'Payment verification failed';
    }

    // applyTransition (mongokit 3.22): the status write is a machine-gated
    // CAS — the old validate-then-update had a window where a concurrent
    // transition slipped between check and write. Safe here because the
    // provider call above is a verification READ (no money moved); refund's
    // post-provider write deliberately stays a plain update instead.
    const updated = (await this.applyTransition(
      String(transaction._id),
      TRANSACTION_STATE_MACHINE,
      { from: transaction.status, to: newStatus, set, history: false },
      this.optsFromCtx(ctx) as never,
    )) as TransactionDocument;

    if (newStatus === TRANSACTION_STATUS.VERIFIED) {
      await this.deps.bridges.ledger?.onPaymentVerified?.(updated as any, ctx);
      await this.deps.bridges.notification?.onPaymentVerified?.(updated as any, ctx);
    }

    /**
     * PORTABLE outcomes publish the CANONICAL contract; intermediate states
     * keep their revenue-internal names.
     *
     * `verified` and `failed` are facts any module reasons about — funds cleared,
     * or the obligation is still open. They now carry
     * `@classytic/primitives/payment-events` payloads so a consumer never has to
     * know what a revenue transaction document looks like.
     *
     * `requires_action` and `processing` are NOT outcomes. They are steps inside
     * a provider flow, and no other module can act on them without knowing this
     * one's state machine — so they stay `revenue:*` rather than being promoted
     * into a contract that has no name for them.
     *
     * ONE fact per outcome: the old `revenue:payment.verified` /
     * `revenue:payment.failed` are NOT also emitted. Publishing both would let a
     * consumer subscribed to each settle the same payment twice.
     */
    const occurredAt = new Date();
    if (newStatus === TRANSACTION_STATUS.VERIFIED) {
      await this.dispatch(
        createEvent(
          PAYMENT_EVENT_TYPE.SUCCEEDED,
          toPaymentSucceeded(updated as unknown as CanonicalSourceTransaction, occurredAt),
          ctx,
          { resource: 'transaction', resourceId: (updated as any)?.publicId },
        ),
        ctx,
      );
    } else if (newStatus === TRANSACTION_STATUS.FAILED) {
      await this.dispatch(
        createEvent(
          PAYMENT_EVENT_TYPE.FAILED,
          toPaymentFailed(
            updated as unknown as CanonicalSourceTransaction,
            // NORMALISED, never a raw vendor error — this value is persisted and
            // displayed, and vendor errors embed request URLs and tokens.
            (paymentResult as { message?: string } | undefined)?.message ?? 'payment failed',
            occurredAt,
          ),
          ctx,
          { resource: 'transaction', resourceId: (updated as any)?.publicId },
        ),
        ctx,
      );
    } else {
      await this.dispatch(
        createEvent(
          newStatus === TRANSACTION_STATUS.REQUIRES_ACTION
            ? REVENUE_EVENTS.PAYMENT_REQUIRES_ACTION
            : REVENUE_EVENTS.PAYMENT_PROCESSING,
          { transaction: updated, paymentResult, verifiedBy: options.verifiedBy },
          ctx,
          { resource: 'transaction', resourceId: (updated as any)?.publicId },
        ),
        ctx,
      );
    }

    return updated as TransactionDocument;
  }

  /**
   * Operator-driven payment failure — declines a payment-flow transaction the
   * gateway never confirmed (e.g. a manual-payment claim an operator rejects).
   * The sibling of `verify()`: same machine-gated CAS to a terminal status and
   * the same `revenue:payment.failed` event, but with NO provider read — the
   * decision is the operator's, not the gateway's.
   *
   * The CAS is the guard: it fails-closed on an already-verified (illegal
   * `verified → failed`) or already-failed (terminal) row, so callers no longer
   * hand-check status before a raw update.
   */
  async fail(
    id: string,
    data: { reason: string; failedBy?: string },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const transaction = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(id);

    // Machine-gated CAS — same as verify(). An illegal source (already-verified
    // / terminal) throws InvalidStateTransitionError natively, which hosts map
    // to 409; no hand-checked status guard needed.
    const updated = (await this.applyTransition(
      String(transaction._id),
      TRANSACTION_STATE_MACHINE,
      {
        from: transaction.status,
        to: TRANSACTION_STATUS.FAILED,
        set: {
          failedAt: new Date(),
          failureReason: data.reason,
          ...(data.failedBy !== undefined ? { verifiedBy: data.failedBy } : {}),
        },
        history: false,
      },
      this.optsFromCtx(ctx) as never,
    )) as TransactionDocument;

    await this.dispatch(
      createEvent(
        PAYMENT_EVENT_TYPE.FAILED,
        // Operator-declined is the SAME portable fact as a gateway decline: the
        // obligation remains unsettled. Who declined it is provenance, so it
        // travels in metadata rather than changing the event's meaning.
        {
          ...toPaymentFailed(updated as unknown as CanonicalSourceTransaction, data.reason, new Date()),
          metadata: {
            ...toPaymentFailed(updated as unknown as CanonicalSourceTransaction, data.reason, new Date()).metadata,
            ...(data.failedBy !== undefined ? { failedBy: data.failedBy } : {}),
          },
        },
        ctx,
        { resource: 'transaction', resourceId: (updated as TransactionDocument).publicId },
      ),
      ctx,
    );

    return updated as TransactionDocument;
  }

  // ─── Domain: Webhook ───

  /** Handles provider webhook. Returns the updated transaction doc (or null if not found). */
  async handleWebhook(providerName: string, payload: unknown, headers?: Record<string, string>, ctx: RevenueContext = {}): Promise<TransactionDocument | null> {
    const provider = this.deps.providers.get(providerName);

    /**
     * Signature gate — BEFORE the payload is parsed or any transaction mutated.
     *
     * `verifyWebhookSignature` is ABSTRACT on `PaymentProvider`, so every provider
     * has stated its answer. It used to default to `return true` here, described as
     * "enforcement is opt-in per provider" — which meant a provider that forgot to
     * override accepted any signature on the call that transitions a payment.
     */
    if (!provider.verifyWebhookSignature(payload, extractWebhookSignature(headers))) {
      throw new WebhookSignatureError(providerName);
    }

    const webhookEvent = await provider.handleWebhook(payload, headers);

    const readOpts = this.optsFromCtx(ctx, { throwOnNotFound: false });
    const sessionId = webhookEvent.data?.sessionId;
    const intentId = webhookEvent.data?.paymentIntentId;
    let transaction = sessionId ? await this.getByQuery({ 'gateway.sessionId': sessionId }, readOpts) : null;
    if (!transaction && intentId) transaction = await this.getByQuery({ 'gateway.paymentIntentId': intentId }, readOpts);
    if (!transaction) return null;

    // Atomic dedup — a sequential pre-check + update had a read-then-write
    // race: LB double-submits or manual replay during an in-flight
    // delivery could both read a pre-stamp snapshot, both write the
    // same webhook.eventId, and both dispatch WEBHOOK_PROCESSED. Move
    // the dedup into the filter: `webhook.eventId: { $ne: eventId }`
    // (matches missing / null / different) so only the first writer's
    // CAS lands and subsequent replays short-circuit to the idempotent
    // "already processed" path.
    if (transaction.webhook?.eventId === webhookEvent.id) return transaction;

    const nextWebhook = {
      eventId: webhookEvent.id,
      eventType: webhookEvent.type,
      receivedAt: new Date(),
      processedAt: new Date(),
      data: webhookEvent.data,
    };
    const updated = await this.findOneAndUpdate<TransactionDocument>(
      { _id: transaction._id, 'webhook.eventId': { $ne: webhookEvent.id } },
      { $set: { webhook: nextWebhook } },
      { returnDocument: 'after' },
    );

    if (!updated) {
      // Another concurrent replay won the CAS — return the canonical
      // doc without re-dispatching the event.
      return (await this.getByQuery({ _id: transaction._id }, readOpts)) ?? transaction;
    }

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.WEBHOOK_PROCESSED,
        {
          webhookType: webhookEvent.type,
          provider: providerName,
          event: webhookEvent,
          transaction: updated,
        },
        ctx,
        { resource: 'transaction', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated as TransactionDocument;
  }

  // ─── Domain: Escrow Hold ───

  /**
   * Places hold on verified transaction. Returns the updated doc.
   *
   * **The guard is in the FILTER.** `hold` is a single embedded escrow record that
   * ACCUMULATES state — a running `releasedAmount` and the `releases[]` ledger. This
   * used to `$set` the whole subdocument unconditionally, so a second `hold()` on a
   * transaction that had already been partially (or fully) released reset
   * `releasedAmount` to `0` and ERASED `releases[]`: money that had already left
   * escrow became releasable all over again, the audit trail of who received it was
   * gone, and NOTHING threw — the doc simply looked like a fresh hold.
   *
   * `hold: null` matches "absent OR explicitly null" in MongoDB, so it makes the write
   * conditional on there being nothing to erase; a duplicate or concurrent hold matches
   * ZERO documents instead of overwriting the winner. `status` is in the filter for the
   * same reason — the `if` above it is a friendly pre-CAS message, not the enforcement
   * (a check-then-act pair is a race by construction).
   *
   * One transaction, one hold. Re-holding a released escrow is a caller error, not a
   * reset: create a new transaction.
   */
  async hold(transactionId: string, options: { amount?: number; reason?: string; holdUntil?: Date; metadata?: Record<string, unknown> } = {}, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    const transaction = await this.getById(transactionId, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(transactionId);
    if (transaction.status !== TRANSACTION_STATUS.VERIFIED) {
      throw new ValidationError('Can only hold verified transactions', { status: transaction.status });
    }

    const holdAmount = options.amount ?? transaction.amount;
    if (!Number.isFinite(holdAmount) || holdAmount <= 0) {
      throw new ValidationError('hold amount must be positive', { holdAmount });
    }

    const updated = await this.findOneAndUpdate<TransactionDocument>(
      { _id: transaction._id, status: TRANSACTION_STATUS.VERIFIED, hold: null },
      {
        $set: {
          hold: {
            status: HOLD_STATUS.HELD, heldAmount: holdAmount, releasedAmount: 0,
            reason: options.reason ?? 'manual_hold', heldAt: new Date(),
            holdUntil: options.holdUntil, releases: [], metadata: options.metadata,
          },
        },
      },
      this.optsFromCtx(ctx, { returnDocument: 'after' }),
    );

    if (!updated) {
      // Zero matches = the doc already carries a hold (or its status moved off
      // `verified` between the read and the write). Report the escrow state we
      // refused to overwrite so the operator can see WHY.
      const current = (await this.getByQuery(
        { _id: transaction._id },
        this.optsFromCtx(ctx, { throwOnNotFound: false }),
      )) as TransactionDocument | null;
      throw new ValidationError(
        'Transaction already has an escrow hold — re-holding would erase the release ledger',
        {
          transactionId,
          status: current?.status,
          holdStatus: current?.hold?.status,
          heldAmount: current?.hold?.heldAmount,
          releasedAmount: current?.hold?.releasedAmount,
          releaseCount: current?.hold?.releases?.length ?? 0,
        },
      );
    }

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.ESCROW_HELD,
        { transaction: updated, heldAmount: holdAmount, reason: options.reason },
        ctx,
        { resource: 'transaction', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated as TransactionDocument;
  }

  // ─── Domain: Escrow Release ───

  /**
   * Releases held funds. Returns the updated transaction doc.
   *
   * The hold update and the escrow_release transaction create happen inside
   * `withTransaction` — a mid-flow crash can't leave the hold marked released
   * without the corresponding outflow record (or vice versa).
   *
   * **Two things this method gets right that the previous version did not.**
   *
   * 1. **The escrow state is read INSIDE the transaction.** It used to be read before
   *    `withTransaction` opened, and `releaseAmount` / `releasedAmount` were computed
   *    from that pre-transaction snapshot. `withTransaction` RE-RUNS its body on a
   *    transient error, so a retry re-applied a decision made against a value that was
   *    already stale when the first attempt started. Everything the write depends on is
   *    now derived from a session-scoped read inside the body, so a retry necessarily
   *    re-reads.
   *
   * 2. **The cap is in the FILTER, not in an `if` above the write.** An `$expr` gate
   *    asserts `releasedAmount + releaseAmount <= heldAmount` on the very write that
   *    applies the `$inc`. Two concurrent FULL releases of a 1,000 hold each used to
   *    compute 1,000 and each `$set` `releasedAmount = 1000` — the hold LOOKED correct
   *    afterwards while **two 1,000 outflow transactions had been created**. Now the
   *    loser matches ZERO documents and its whole transaction (outflow record and
   *    outbox row included) aborts.
   *
   * The mutation is a `$inc` + `$push` on the accumulating fields rather than a `$set`
   * of the recomputed subdocument, so the write itself carries no assumption about what
   * the on-disk total was.
   */
  async release(transactionId: string, options: {
    amount?: number; recipientId: string; recipientType: string;
    reason?: string; releasedBy?: string; createTransaction?: boolean; metadata?: Record<string, unknown>;
  }, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    // Pre-CAS friendly errors only — the AUTHORITATIVE read is inside the transaction.
    const initial = await this.getById(transactionId, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!initial) throw new TransactionNotFoundError(transactionId);
    if (!initial.hold || !ACTIVE_HOLD_STATUSES.includes(initial.hold.status)) {
      throw new ValidationError('Transaction does not have an active hold');
    }
    if (options.amount !== undefined && !(Number.isFinite(options.amount) && options.amount > 0)) {
      throw new ValidationError('release amount must be positive', { amount: options.amount });
    }

    const pendingEvents: DomainEvent[] = [];
    const updated = await withTransaction(this.Model.db as unknown as { startSession(): Promise<ClientSession> }, async (session) => {
      // A transient-error retry re-enters here. Reset the queue and re-derive EVERY
      // input from a session-scoped read so no attempt can inherit an earlier one's
      // snapshot.
      pendingEvents.length = 0;
      const writeOpts = this.optsFromCtx(ctx, { session });

      const current = (await this.getByQuery(
        { _id: initial._id },
        { ...writeOpts, throwOnNotFound: false },
      )) as TransactionDocument | null;
      if (!current) throw new TransactionNotFoundError(transactionId);
      const hold = current.hold;
      if (!hold || !ACTIVE_HOLD_STATUSES.includes(hold.status)) {
        throw new ValidationError('Transaction does not have an active hold');
      }

      const heldAmount = hold.heldAmount;
      const alreadyReleased = hold.releasedAmount ?? 0;
      const releaseAmount = options.amount ?? (heldAmount - alreadyReleased);
      if (!(releaseAmount > 0)) {
        throw new ValidationError('release amount must be positive', { releaseAmount });
      }
      const newReleasedAmount = alreadyReleased + releaseAmount;
      if (newReleasedAmount > heldAmount) {
        throw new ValidationError('release exceeds the held amount', {
          transactionId, heldAmount, alreadyReleased, requested: releaseAmount,
        });
      }
      const isFullRelease = newReleasedAmount >= heldAmount;
      const releasedAt = new Date();

      const release = {
        amount: releaseAmount, recipientId: options.recipientId, recipientType: options.recipientType,
        releasedAt, releasedBy: options.releasedBy, reason: options.reason, metadata: options.metadata,
      };

      const result = (await this.findOneAndUpdate<TransactionDocument>(
        {
          _id: current._id,
          'hold.status': { $in: ACTIVE_HOLD_STATUSES },
          // THE GUARD. Same write, same document, one round trip.
          $expr: {
            $lte: [
              { $add: [{ $ifNull: ['$hold.releasedAmount', 0] }, releaseAmount] },
              { $ifNull: ['$hold.heldAmount', 0] },
            ],
          },
        },
        {
          $inc: { 'hold.releasedAmount': releaseAmount },
          $push: { 'hold.releases': release },
          $set: {
            'hold.status': isFullRelease ? HOLD_STATUS.RELEASED : HOLD_STATUS.PARTIALLY_RELEASED,
            ...(isFullRelease ? { 'hold.releasedAt': releasedAt } : {}),
          },
        },
        { ...writeOpts, returnDocument: 'after' },
      )) as TransactionDocument | null;

      if (!result) {
        // The cap refused the write. Abort so the outflow record below never exists —
        // this is the branch that used to silently create a second 1,000 payout.
        throw new ValidationError(
          'escrow release refused: it would exceed the held amount (a concurrent or duplicate release already claimed it)',
          { transactionId, heldAmount, alreadyReleased, requested: releaseAmount },
        );
      }

      if (options.createTransaction !== false) {
        await this.create({
          organizationId: current.organizationId, customerId: options.recipientId,
          type: 'escrow_release', flow: 'outflow', tags: ['escrow', 'release'],
          amount: releaseAmount, currency: current.currency,
          fee: 0, tax: 0, net: releaseAmount, method: current.method, methodKind: current.methodKind,
          status: TRANSACTION_STATUS.VERIFIED, relatedTransactionId: current._id,
          sourceId: current.sourceId, sourceModel: current.sourceModel,
          verifiedAt: new Date(), metadata: options.metadata,
        } as any, writeOpts);
      }

      const event = createEvent(
        REVENUE_EVENTS.ESCROW_RELEASED,
        {
          transaction: result,
          releaseAmount,
          recipientId: options.recipientId,
          recipientType: options.recipientType,
          isFullRelease,
          isPartialRelease: !isFullRelease,
        },
        ctx,
        { resource: 'transaction', resourceId: (result as any)?.publicId },
      );
      await this.saveToOutbox(event, session);
      pendingEvents.push(event);
      return result;
    },
        { allowFallback: this.allowNonTransactional });

    for (const ev of pendingEvents) await this.publishToTransport(ev);

    return updated as TransactionDocument;
  }

  // ─── Domain: Escrow Split ───

  /**
   * Splits payment among recipients. Returns the updated transaction doc.
   *
   * N + 2 writes (one create per recipient, one update on the parent, one
   * platform_revenue create) all commit atomically. Partial splits are the
   * worst class of bug in a payments system — this is exactly what
   * `withTransaction` is for.
   */
  async split(transactionId: string, rules: Array<{ type: string; recipientId: string; recipientType: string; rate: number }>, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    const transaction = await this.getById(transactionId, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(transactionId);

    const gatewayFeeRate = this.deps.commission?.gatewayFeeRate ?? 0;
    const splits = calculateSplits(transaction.amount, rules, gatewayFeeRate);
    const orgPayout = calculateOrganizationPayout(transaction.amount, splits);

    const pendingEvents: DomainEvent[] = [];
    const updated = await withTransaction(this.Model.db as unknown as { startSession(): Promise<ClientSession> }, async (session) => {
      const writeOpts = this.optsFromCtx(ctx, { session });

      /**
       * CLAIM THE PARENT FIRST — the fence must precede the payouts.
       *
       * `split()` creates one commission transaction per recipient plus a
       * platform-revenue row, then stamped `splits` on the parent with an
       * unconditional write. Nothing keyed the operation, so a second call — a
       * concurrent one, or a plain retry after a partial failure — created the WHOLE
       * payout set again and simply overwrote `splits`, leaving a parent that reads
       * as split exactly once. Every recipient paid twice; the evidence erased by
       * the same write.
       *
       * The claim is ordered BEFORE the creates so it acts as the fence: the loser
       * writes nothing and its transaction rolls back. Guarding only the final update
       * would leave the duplicate payouts already committed.
       *
       * `from === to` keeps the status untouched (yard-style dedup); the real
       * predicate is `where` — a parent that already carries splits is not eligible.
       */
      const claimed = await this.claim(
        transactionId,
        {
          from: transaction.status,
          to: transaction.status,
          where: { $or: [{ splits: { $exists: false } }, { splits: { $size: 0 } }] },
        },
        { $set: { splits, metadata: { ...transaction.metadata, organizationPayout: orgPayout } } },
        writeOpts,
      );
      if (!claimed) {
        throw new AlreadySplitError(transactionId);
      }

      for (const s of splits) {
        await this.create({
          organizationId: transaction.organizationId, customerId: s.recipientId,
          type: 'commission', flow: 'outflow', tags: ['split', s.type],
          amount: s.grossAmount, currency: transaction.currency,
          fee: s.gatewayFeeAmount, tax: 0, net: s.netAmount, method: transaction.method, methodKind: transaction.methodKind,
          status: TRANSACTION_STATUS.VERIFIED, relatedTransactionId: transaction._id,
          sourceId: transaction.sourceId, sourceModel: transaction.sourceModel, verifiedAt: new Date(),
        } as any, writeOpts);
      }

      // Already written by the fence above.
      const result = claimed;

      await this.create({
        organizationId: transaction.organizationId, type: 'platform_revenue',
        flow: 'inflow', tags: ['split', 'platform'],
        amount: orgPayout, currency: transaction.currency,
        fee: 0, tax: 0, net: orgPayout, method: transaction.method, methodKind: transaction.methodKind,
        status: TRANSACTION_STATUS.VERIFIED, relatedTransactionId: transaction._id, verifiedAt: new Date(),
      } as any, writeOpts);

      const event = createEvent(
        REVENUE_EVENTS.ESCROW_SPLIT,
        { transaction: result, splits, organizationPayout: orgPayout },
        ctx,
        { resource: 'transaction', resourceId: (transaction as any).publicId },
      );
      await this.saveToOutbox(event, session);
      pendingEvents.push(event);
      return result;
    },
        { allowFallback: this.allowNonTransactional });

    for (const ev of pendingEvents) await this.publishToTransport(ev);

    return updated as TransactionDocument;
  }

  // ════════════════════════════════════════════════════════════════════════
  //                       BANK FEED / ACCOUNTING (3.0)
  // ════════════════════════════════════════════════════════════════════════

  /**
   * Idempotent bulk import of bank-feed rows.
   *
   * Each row is upserted by `(orgId, bankAccountId, externalId)` — the
   * partial unique index declared in `create-models.ts`. Re-running the
   * same Plaid sync, OFX upload, or QBO CDC drain produces zero new
   * inserts on the second call (modified counts may rise as
   * descriptions/categories evolve upstream).
   *
   * Signed bank `amount` is normalized into the (`amount` >= 0, `flow`)
   * shape revenue uses internally so downstream queries (`flow:
   * 'inflow'`) work uniformly across kinds.
   *
   * Emits one `revenue:transaction.imported` event per **inserted** row
   * (not per row in `rows` — re-imports do not re-fire). Hosts wanting
   * batch-level signal subscribe to the per-doc events and aggregate.
   *
   * Per-row failures (validation, hash collisions on a non-unique
   * `externalId`) collect into `errors[]` instead of aborting the whole
   * batch — the typical Plaid drain pulls thousands of rows; one bad
   * row should not block the rest.
   *
   * @param rows  Canonical bank transactions, structurally compatible
   *              with `@classytic/fin-io` parsers' output.
   * @param opts  `bankAccountId` (required, polymorphic ID) and
   *              `source` (provenance — `'plaid'`, `'ofx'`, …).
   */
}

// Public type surface (unchanged import path for consumers that referenced the repo file).
export type {
  TransactionRepoDeps,
  PaymentAttemptHistory,
  PaymentAttemptView,
  RefundView,
  RefundSummary,
} from './transaction-types.js';
