import { Repository, withTransaction, type PluginType, type BatchOperationsMethods } from '@classytic/mongokit';
import type { ClientSession, Model } from 'mongoose';
import type { TransactionDocument } from '../models/transaction.schema.js';
import type { RevenueContext } from '../core/context.js';
import type { RevenueBridges } from '../bridges/revenue-bridges.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { BankFeedProviderRegistry, FetchTransactionsParams } from '../providers/bank-feed.js';
import type {
  BankImportReport,
  BankImportRowError,
  BankTransaction,
} from '@classytic/primitives/bank-transaction';
import type { CommissionConfig } from '../engine/engine-types.js';
import type { DomainEvent } from '@classytic/primitives/events';
import type { PaymentMethodKind } from '@classytic/primitives/payment-method-kind';
import { RevenueRepositoryBase, type BaseRevenueRepoDeps } from './base.repository.js';
import { createEvent } from '../events/helpers.js';
import { REVENUE_EVENTS } from '../events/event-constants.js';
import { TRANSACTION_STATUS } from '../enums/transaction.enums.js';
import { HOLD_STATUS } from '../enums/escrow.enums.js';
import {
  TRANSACTION_KIND,
  type TransactionKindValue,
  initialStatusFor,
} from '../enums/bank-feed.enums.js';
import {
  TRANSACTION_STATE_MACHINE,
  smFor,
} from '../core/state-machines.js';
import {
  BankFeedImportError,
  MethodKindLockedError,
  TransactionNotFoundError,
  ValidationError,
  WrongTransactionKindError,
} from '../core/errors.js';
import { calculateCommission, reverseCommission } from '../shared/calculators/commission.js';
import { reverseTax } from '../shared/calculators/tax.js';
import { calculateSplits, calculateOrganizationPayout } from '../shared/calculators/splits.js';

/**
 * Deps for {@link TransactionRepository}. Extends {@link BaseRevenueRepoDeps}
 * (events / outbox? / logger?) with provider/bridge/config wiring specific
 * to the payment-flow + bank-feed lifecycles.
 */
export interface TransactionRepoDeps extends BaseRevenueRepoDeps {
  providers: ProviderRegistry;
  /**
   * Bank-feed provider registry (3.0). Optional — when omitted, the
   * `drainSync` and `parseAndImport` verbs throw on use. The host typically
   * wires Plaid / fin-io / a custom CSV provider here.
   */
  bankFeedProviders?: BankFeedProviderRegistry | undefined;
  bridges: RevenueBridges;
  commission?: CommissionConfig;
  defaultCurrency: string;
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
 * `createRevenue`), `bulkWrite` is also available — `import()` uses it.
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
type RepoWithBulkWrite = Repository<TransactionDocument> & Partial<BatchOperationsMethods>;

export class TransactionRepository extends RevenueRepositoryBase<TransactionDocument, TransactionRepoDeps> {
  constructor(model: Model<TransactionDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  // ─── Phased dispatch helpers (PACKAGE_RULES §P8 / §5.5) ───
  //
  // Phased dispatch — `saveToOutbox` runs INSIDE a `withTransaction` body
  // so the event row commits atomically with the business write;
  // `publishToTransport` runs AFTER the transaction commits so in-process
  // subscribers fire only when the parent write succeeded.
  //
  // For verbs that don't open their own session, the base `dispatch()` is
  // simpler: call `this.dispatch(event, ctx)` and the same atomicity is
  // achieved via `ctx.session` threading.

  /**
   * Save an event to the host-owned outbox, session-bound when available.
   *
   * Called INSIDE a `withTransaction` body. The outbox row commits
   * atomically with the business write (P8 true session-bound write) —
   * if outbox.save fails, this method re-throws so `withTransaction`
   * rolls the parent write back. Without propagation, the parent doc
   * would commit while the event row vanishes, defeating the whole
   * transactional-outbox correctness argument.
   *
   * Logging happens before the re-throw so the failure surfaces in
   * observability without losing the original stack trace.
   */
  protected async saveToOutbox(event: DomainEvent, session?: unknown): Promise<void> {
    if (!this.deps.outbox) return;
    try {
      await this.deps.outbox.save(event, session !== undefined ? { session } : {});
    } catch (err) {
      this.deps.logger?.error('[revenue] outbox.save failed for', event.type, err);
      throw err;
    }
  }

  /**
   * Publish an event to the in-process `EventTransport` after commit.
   * Transport failure is logged and swallowed — the host relay re-delivers
   * from the durable outbox row on the next poll, so in-process
   * subscribers missing an event is recoverable. Best-effort by design.
   */
  protected async publishToTransport(event: DomainEvent): Promise<void> {
    try {
      await this.deps.events.publish(event);
    } catch (err) {
      this.deps.logger?.error('[revenue] events.publish failed for', event.type, err);
    }
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
    const currency = params.currency ?? this.deps.defaultCurrency;
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
    if (params.amount > 0) {
      const intent = await provider.createIntent({
        amount: { amount: params.amount, currency },
        methodKind: params.methodKind,
        metadata: params.metadata, ...params.paymentData,
      });
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
    }

    const transaction = await this.create(
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
        idempotencyKey: params.idempotencyKey,
        metadata: params.metadata,
      } as any,
      this.optsFromCtx(ctx),
    );

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

    TRANSACTION_STATE_MACHINE.validate(transaction.status as any, newStatus as any, String(transaction._id));

    const updates: Record<string, unknown> = { status: newStatus };
    if (newStatus === TRANSACTION_STATUS.VERIFIED) {
      updates.verifiedAt = new Date();
      updates.verifiedBy = options.verifiedBy;
    } else if (newStatus === TRANSACTION_STATUS.FAILED) {
      updates.failedAt = new Date();
      updates.failureReason = 'Payment verification failed';
    }

    // Pass ObjectId directly — mongokit accepts string | ObjectId
    const updated = await this.update(transaction._id, updates, this.optsFromCtx(ctx));

    if (newStatus === TRANSACTION_STATUS.VERIFIED) {
      await this.deps.bridges.ledger?.onPaymentVerified?.(updated as any, ctx);
      await this.deps.bridges.notification?.onPaymentVerified?.(updated as any, ctx);
    }

    const eventName =
      newStatus === TRANSACTION_STATUS.VERIFIED ? REVENUE_EVENTS.PAYMENT_VERIFIED
      : newStatus === TRANSACTION_STATUS.FAILED ? REVENUE_EVENTS.PAYMENT_FAILED
      : newStatus === TRANSACTION_STATUS.REQUIRES_ACTION ? REVENUE_EVENTS.PAYMENT_REQUIRES_ACTION
      : REVENUE_EVENTS.PAYMENT_PROCESSING;

    await this.dispatch(
      createEvent(
        eventName,
        { transaction: updated, paymentResult, verifiedBy: options.verifiedBy },
        ctx,
        { resource: 'transaction', resourceId: (updated as any)?.publicId },
      ),
      ctx,
    );

    return updated as TransactionDocument;
  }

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
    options: { reason?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const transaction = await this.getById(transactionId, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(transactionId);

    const refundAmount = amount ?? transaction.amount;
    const existingRefunded = transaction.refundedAmount ?? 0;
    const totalAfterRefund = existingRefunded + refundAmount;
    const isPartialRefund = totalAfterRefund < transaction.amount;
    const newStatus = isPartialRefund ? TRANSACTION_STATUS.PARTIALLY_REFUNDED : TRANSACTION_STATUS.REFUNDED;
    TRANSACTION_STATE_MACHINE.validate(transaction.status as any, newStatus as any, transactionId);

    const provider = this.deps.providers.get(transaction.method);
    const paymentId = transaction.gateway?.paymentIntentId ?? transaction.gateway?.sessionId ?? transactionId;
    await provider.refund(paymentId as string, refundAmount, { reason: options.reason });

    const reversedCommission = reverseCommission(transaction.commission as any, transaction.amount, refundAmount);
    const reversedTax = transaction.tax ? reverseTax(
      { isApplicable: true, rate: 0, baseAmount: transaction.amount, taxAmount: transaction.tax, totalAmount: transaction.amount + transaction.tax, pricesIncludeTax: false },
      transaction.amount, refundAmount,
    ) : undefined;

    // Session-bound outbox save (P8): outbox.save runs INSIDE the business tx
    // with the same mongoose session, so the event row commits atomically with
    // the refund write. Transport publish is deferred until after commit — arc's
    // relay delivers the same event to in-process subscribers on the next poll,
    // so no duplication risk for consumers that follow the outbox.
    const pendingEvents: DomainEvent[] = [];
    const refundTransaction = await withTransaction(this.Model.db as unknown as { startSession(): Promise<ClientSession> }, async (session) => {
      const writeOpts = this.optsFromCtx(ctx, { session });
      const refundTxn = await this.create({
        organizationId: transaction.organizationId, customerId: transaction.customerId,
        type: 'refund', flow: 'outflow', tags: ['refund'],
        amount: refundAmount, currency: transaction.currency,
        fee: reversedCommission?.gatewayFeeAmount ?? 0,
        tax: reversedTax?.taxAmount ?? 0,
        net: refundAmount - (reversedCommission?.gatewayFeeAmount ?? 0) - (reversedTax?.taxAmount ?? 0),
        method: transaction.method, methodKind: transaction.methodKind, status: TRANSACTION_STATUS.VERIFIED,
        gateway: transaction.gateway, commission: reversedCommission ?? undefined,
        relatedTransactionId: transaction._id,
        sourceId: transaction.sourceId, sourceModel: transaction.sourceModel,
        verifiedAt: new Date(), metadata: { reason: options.reason },
      } as any, writeOpts);

      await this.update(
        transactionId,
        { status: newStatus, refundedAmount: existingRefunded + refundAmount, refundedAt: new Date() },
        writeOpts,
      );

      const event = createEvent(
        REVENUE_EVENTS.PAYMENT_REFUNDED,
        { transaction, refundTransaction: refundTxn, refundAmount, reason: options.reason, isPartialRefund },
        ctx,
        { resource: 'transaction', resourceId: (transaction as any).publicId },
      );
      await this.saveToOutbox(event, session);
      pendingEvents.push(event);
      return refundTxn;
    });

    await this.deps.bridges.ledger?.onRefundProcessed?.(transaction as any, refundTransaction as any, ctx);
    await this.deps.bridges.notification?.onRefundProcessed?.(refundTransaction as any, ctx);

    for (const ev of pendingEvents) await this.publishToTransport(ev);

    return refundTransaction;
  }

  // ─── Domain: Webhook ───

  /** Handles provider webhook. Returns the updated transaction doc (or null if not found). */
  async handleWebhook(providerName: string, payload: unknown, headers?: Record<string, string>, ctx: RevenueContext = {}): Promise<TransactionDocument | null> {
    const provider = this.deps.providers.get(providerName);
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

  /** Places hold on verified transaction. Returns the updated doc. */
  async hold(transactionId: string, options: { amount?: number; reason?: string; holdUntil?: Date; metadata?: Record<string, unknown> } = {}, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    const transaction = await this.getById(transactionId, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(transactionId);
    if (transaction.status !== TRANSACTION_STATUS.VERIFIED) {
      throw new ValidationError('Can only hold verified transactions', { status: transaction.status });
    }

    const holdAmount = options.amount ?? transaction.amount;
    const updated = await this.update(transactionId, {
      hold: {
        status: HOLD_STATUS.HELD, heldAmount: holdAmount, releasedAmount: 0,
        reason: options.reason ?? 'manual_hold', heldAt: new Date(),
        holdUntil: options.holdUntil, releases: [], metadata: options.metadata,
      },
    }, this.optsFromCtx(ctx));

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
   */
  async release(transactionId: string, options: {
    amount?: number; recipientId: string; recipientType: string;
    reason?: string; releasedBy?: string; createTransaction?: boolean; metadata?: Record<string, unknown>;
  }, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    const transaction = await this.getById(transactionId, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!transaction) throw new TransactionNotFoundError(transactionId);
    if (!transaction.hold || (transaction.hold.status !== HOLD_STATUS.HELD && transaction.hold.status !== HOLD_STATUS.PARTIALLY_RELEASED)) {
      throw new ValidationError('Transaction does not have an active hold');
    }

    const releaseAmount = options.amount ?? (transaction.hold.heldAmount - transaction.hold.releasedAmount);
    const newReleasedAmount = transaction.hold.releasedAmount + releaseAmount;
    const isFullRelease = newReleasedAmount >= transaction.hold.heldAmount;

    const release = {
      amount: releaseAmount, recipientId: options.recipientId, recipientType: options.recipientType,
      releasedAt: new Date(), releasedBy: options.releasedBy, reason: options.reason, metadata: options.metadata,
    };

    const pendingEvents: DomainEvent[] = [];
    const updated = await withTransaction(this.Model.db as unknown as { startSession(): Promise<ClientSession> }, async (session) => {
      const writeOpts = this.optsFromCtx(ctx, { session });
      const result = await this.update(
        transactionId,
        {
          hold: {
            ...transaction.hold,
            status: isFullRelease ? HOLD_STATUS.RELEASED : HOLD_STATUS.PARTIALLY_RELEASED,
            releasedAmount: newReleasedAmount,
            releasedAt: isFullRelease ? new Date() : transaction.hold!.releasedAt,
            releases: [...(transaction.hold!.releases ?? []), release],
          },
        },
        writeOpts,
      );

      if (options.createTransaction !== false) {
        await this.create({
          organizationId: transaction.organizationId, customerId: options.recipientId,
          type: 'escrow_release', flow: 'outflow', tags: ['escrow', 'release'],
          amount: releaseAmount, currency: transaction.currency,
          fee: 0, tax: 0, net: releaseAmount, method: transaction.method, methodKind: transaction.methodKind,
          status: TRANSACTION_STATUS.VERIFIED, relatedTransactionId: transaction._id,
          sourceId: transaction.sourceId, sourceModel: transaction.sourceModel,
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
    });

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

      const result = await this.update(
        transactionId,
        {
          splits,
          metadata: { ...transaction.metadata, organizationPayout: orgPayout },
        },
        writeOpts,
      );

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
    });

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
  async import(
    rows: BankTransaction[],
    opts: { bankAccountId: string; source: string; methodKind: PaymentMethodKind; method?: string },
    ctx: RevenueContext = {},
  ): Promise<BankImportReport> {
    // No default — callers must be intentional. A Stripe balance import
    // is `'card'`, not bank_transfer; a Plaid drain is `'bank_transfer'`;
    // a crypto-exchange CSV is `'cryptocurrency'`. Silently defaulting
    // to `'bank_transfer'` would mis-classify those into accounting
    // reports and analytics.
    if (!opts.methodKind) {
      throw new BankFeedImportError(
        '`opts.methodKind` is required on TransactionRepository.import() — ' +
          'pick the canonical PaymentMethodKind for the source (e.g. `\'bank_transfer\'` for Plaid/OFX, ' +
          '`\'card\'` for a Stripe balance, `\'wallet\'` for PayPal, `\'cryptocurrency\'` for an exchange).',
      );
    }
    const startedAt = Date.now();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { inserted: 0, updated: 0, skipped: 0, errors: [], durationMs: 0 };
    }

    const repo = this as unknown as RepoWithBulkWrite;
    if (!repo.bulkWrite) {
      throw new BankFeedImportError(
        'TransactionRepository requires `batchOperationsPlugin` for `import()`. ' +
          'Pass it via `createRevenue({ repositoryPlugins: { transaction: [batchOperationsPlugin()] } })` ' +
          '— or rely on the engine default which wires it automatically.',
      );
    }

    const errors: BankImportRowError[] = [];
    const tenantOption = ctx.organizationId !== undefined ? { organizationId: ctx.organizationId } : {};

    // Build bulk operations. `$setOnInsert` carries fields that must NOT be
    // overwritten by re-imports (kind, status, externalId, bankAccountId,
    // organizationId — anything that pins identity). `$set` carries fields
    // that MAY drift (description, category, balance, counterparty enrichment).
    const ops: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!row.externalId || typeof row.externalId !== 'string') {
        errors.push({ externalId: String(row.externalId), reason: 'missing_external_id', row });
        continue;
      }
      // primitives.Money.amount is already integer minor units (number),
      // signed by convention (positive = inflow). No bigint conversion.
      const signed = row.amount.amount;
      if (!Number.isFinite(signed) || !Number.isInteger(signed)) {
        errors.push({ externalId: row.externalId, reason: 'invalid_amount', row });
        continue;
      }
      const isInflow = signed >= 0;
      const absoluteAmount = Math.abs(signed);

      const filter: Record<string, unknown> = {
        bankAccountId: opts.bankAccountId,
        externalId: row.externalId,
      };
      if (ctx.organizationId !== undefined) filter.organizationId = ctx.organizationId;

      const set: Record<string, unknown> = {
        amount: absoluteAmount,
        currency: row.amount.currency,
        flow: isInflow ? 'inflow' : 'outflow',
        postedDate: row.postedDate,
        description: row.description,
        method: opts.method ?? opts.source,
      };
      if (row.valueDate !== undefined) set.valueDate = row.valueDate;
      if (row.counterparty !== undefined) set.counterparty = row.counterparty;
      if (row.reference !== undefined) set.reference = row.reference;
      if (row.category !== undefined) set.vendorCategory = row.category;
      if (row.balanceAfter !== undefined) set.balanceAfter = row.balanceAfter.amount;

      const setOnInsert: Record<string, unknown> = {
        kind: TRANSACTION_KIND.BANK_FEED,
        status: initialStatusFor(TRANSACTION_KIND.BANK_FEED),
        bankAccountId: opts.bankAccountId,
        externalId: row.externalId,
        source: opts.source,
        type: 'bank_feed',
        tags: ['bank_feed', opts.source],
        methodKind: opts.methodKind,
        fee: 0,
        tax: 0,
        net: absoluteAmount,
        deletedAt: null,
      };
      if (ctx.organizationId !== undefined) setOnInsert.organizationId = ctx.organizationId;

      ops.push({
        updateOne: {
          filter,
          update: { $set: set, $setOnInsert: setOnInsert },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) {
      return { inserted: 0, updated: 0, skipped: rows.length, errors, durationMs: Date.now() - startedAt };
    }

    const sessionOption: Record<string, unknown> = ctx.session !== undefined ? { session: ctx.session } : {};
    const result = (await repo.bulkWrite(ops, { ordered: false, ...sessionOption, ...tenantOption })) as {
      insertedCount: number;
      upsertedCount: number;
      modifiedCount: number;
      upsertedIds: Record<string | number, unknown>;
    };

    const inserted = (result.upsertedCount ?? 0) + (result.insertedCount ?? 0);
    const updated = result.modifiedCount ?? 0;
    const upsertedIds = Object.values(result.upsertedIds ?? {});

    // Fan out one event per *inserted* row. Re-imports (modifications only)
    // do not re-fire the imported event — subscribers can't tell idempotent
    // re-imports apart from genuine new rows otherwise.
    if (upsertedIds.length > 0) {
      for (let i = 0; i < upsertedIds.length; i++) {
        const id = upsertedIds[i];
        if (id === undefined || id === null) continue;
        const doc = await this.getById(String(id), this.optsFromCtx(ctx, { throwOnNotFound: false }));
        if (!doc) continue;
        const txn = doc as unknown as TransactionDocument;
        await this.dispatch(
          createEvent(
            REVENUE_EVENTS.TRANSACTION_IMPORTED,
            {
              transaction: txn,
              source: opts.source,
              bankAccountId: opts.bankAccountId,
              externalId: txn.externalId ?? '',
            },
            ctx,
            { resource: 'transaction', resourceId: txn.publicId },
          ),
          ctx,
        );
        await this.deps.bridges.ledger?.onTransactionImported?.(txn as unknown as Record<string, unknown>, ctx);
      }
    }

    return {
      inserted,
      updated,
      skipped: errors.length,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Drain a bank-feed provider into the collection.
   *
   * Pulls pages from `provider.fetchTransactions()` (Plaid cursor, QBO
   * CDC) and feeds each batch through `import()`. Yields the running
   * report so a host cron can stream-progress-report to logs / metrics.
   *
   * Stops when the provider returns no new rows AND no removals AND no
   * `nextCursor`. Caller is responsible for persisting the final cursor
   * in their own checkpoint table — `result.nextCursor` is returned so
   * the host can write it after a successful drain.
   *
   * Plaid `removed[]` rows (and any provider that retracts entries) are
   * routed through `removeByFeed` so the host's LedgerBridge can void
   * any JE that was already posted.
   */
  async drainSync(
    providerName: string,
    params: FetchTransactionsParams & { bankAccountId: string; methodKind: PaymentMethodKind },
    ctx: RevenueContext = {},
  ): Promise<{ totalImported: number; totalUpdated: number; totalRemoved: number; nextCursor?: string; errors: BankImportRowError[] }> {
    if (!this.deps.bankFeedProviders) {
      throw new ValidationError(
        '`bankFeedProviders` not wired on the engine. Pass `providers.bankFeed` to `createRevenue`.',
      );
    }
    const provider = this.deps.bankFeedProviders.get(providerName);

    let totalImported = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    let lastCursor: string | undefined;
    const errors: BankImportRowError[] = [];

    for await (const page of provider.drain(params)) {
      if (page.transactions && page.transactions.length > 0) {
        const report = await this.import(
          page.transactions,
          { bankAccountId: params.bankAccountId, source: providerName, methodKind: params.methodKind },
          ctx,
        );
        totalImported += report.inserted;
        totalUpdated += report.updated;
        if (report.errors.length > 0) errors.push(...report.errors);
      }
      if (page.removed && page.removed.length > 0) {
        const removed = await this.removeByFeed(
          page.removed.map((r) => r.externalId),
          { bankAccountId: params.bankAccountId, source: providerName },
          ctx,
        );
        totalRemoved += removed.removed;
      }
      if (page.nextCursor) lastCursor = page.nextCursor;
    }

    return {
      totalImported,
      totalUpdated,
      totalRemoved,
      ...(lastCursor !== undefined ? { nextCursor: lastCursor } : {}),
      errors,
    };
  }

  /**
   * Parse an upload (OFX / CAMT.053 / MT940 / CSV) via a registered
   * bank-feed provider, then `import()` the result.
   *
   * Convenience over manually calling `provider.parseUpload()` and
   * threading the canonical rows into `import()` — the file-upload
   * route handler is one line.
   */
  async parseAndImport(
    providerName: string,
    upload: { buffer: Buffer | string | Uint8Array; format?: string; bankAccountId: string; methodKind: PaymentMethodKind },
    ctx: RevenueContext = {},
  ): Promise<BankImportReport> {
    if (!this.deps.bankFeedProviders) {
      throw new ValidationError('`bankFeedProviders` not wired on the engine.');
    }
    const provider = this.deps.bankFeedProviders.get(providerName);
    if (!provider.parseUpload) {
      throw new ValidationError(`Provider '${providerName}' does not support parseUpload`);
    }
    const parsed = await provider.parseUpload({
      buffer: upload.buffer,
      ...(upload.format !== undefined ? { format: upload.format as never } : {}),
      bankAccountId: upload.bankAccountId,
    });
    return this.import(
      parsed.transactions,
      { bankAccountId: upload.bankAccountId, source: providerName, methodKind: upload.methodKind },
      ctx,
    );
  }

  /**
   * Hand-keyed entry — treasurer logs a cash deposit, owner injects
   * capital, refund correction. Created in `pending` (manual SM); host
   * proceeds with `match()` → `journalize()` to post it to the ledger.
   *
   * `kind: 'manual'` is enforced — calls passing other kinds throw.
   */
  async createManual(
    data: {
      amount: number;
      currency: string;
      flow: 'inflow' | 'outflow';
      type: string;
      methodKind: PaymentMethodKind;
      description?: string;
      counterparty?: TransactionDocument['counterparty'];
      reference?: string;
      postedDate?: Date;
      valueDate?: Date;
      bankAccountId?: string;
      sourceId?: string;
      sourceModel?: string;
      metadata?: Record<string, unknown>;
    },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const doc = await this.create(
      {
        organizationId: ctx.organizationId,
        kind: TRANSACTION_KIND.MANUAL,
        type: data.type,
        flow: data.flow,
        tags: ['manual'],
        amount: data.amount,
        currency: data.currency,
        fee: 0,
        tax: 0,
        net: data.amount,
        method: 'manual',
        methodKind: data.methodKind,
        status: initialStatusFor(TRANSACTION_KIND.MANUAL),
        source: 'manual',
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.counterparty !== undefined ? { counterparty: data.counterparty } : {}),
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.postedDate !== undefined ? { postedDate: data.postedDate } : {}),
        ...(data.valueDate !== undefined ? { valueDate: data.valueDate } : {}),
        ...(data.bankAccountId !== undefined ? { bankAccountId: data.bankAccountId } : {}),
        ...(data.sourceId !== undefined ? { sourceId: data.sourceId } : {}),
        ...(data.sourceModel !== undefined ? { sourceModel: data.sourceModel } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      } as never,
      this.optsFromCtx(ctx),
    );

    return doc as TransactionDocument;
  }

  /**
   * Backfill the `methodKind` on a Transaction created with kind
   * unknown — the canonical use case is hosted-checkout (Stripe
   * Checkout, PayPal redirect, Razorpay Checkout) where the customer
   * picks their payment method on the gateway's UI, AFTER the host has
   * already created the PaymentIntent + Transaction with
   * `methodKind: 'other'`.
   *
   * Call this from your verification / webhook handler once you know
   * the customer's actual choice — e.g. inside
   * `payment_intent.succeeded`:
   *
   * ```ts
   * await transactionRepository.backfillMethodKind(
   *   tx._id,
   *   stripePaymentIntentToKind(event.data.object),
   *   ctx,
   * );
   * ```
   *
   * **Guard rule.** Atomic CAS — succeeds only when the doc has
   * `methodKind === 'other'` AND `status === 'pending'`. Any other
   * combination throws `MethodKindLockedError` (HTTP 409): once a
   * transaction has a specific kind (or has settled past pending),
   * silently overwriting it would corrupt downstream analytics and
   * accounting reports.
   *
   * Emits `revenue:transaction.updated` with `changedFields:
   * ['methodKind']` so subscribers can re-bucket the row.
   */
  async backfillMethodKind(
    transactionId: string,
    methodKind: PaymentMethodKind,
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const updated = await this.findOneAndUpdate<TransactionDocument>(
      {
        _id: transactionId,
        methodKind: 'other',
        status: TRANSACTION_STATUS.PENDING,
      },
      { $set: { methodKind } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const existing = (await this.getById(
        transactionId,
        this.optsFromCtx(ctx, { throwOnNotFound: false }),
      )) as TransactionDocument | null;
      if (!existing) throw new TransactionNotFoundError(transactionId);
      throw new MethodKindLockedError(
        transactionId,
        existing.methodKind ?? 'unknown',
        existing.status ?? 'unknown',
      );
    }

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_UPDATED,
        { transaction: updated, changedFields: ['methodKind'] },
        ctx,
        { resource: 'transaction', resourceId: (updated as TransactionDocument).publicId },
      ),
      ctx,
    );

    return updated as TransactionDocument;
  }

  /**
   * Match a bank-feed / manual transaction to GL accounts, optionally
   * cross-linking to an upstream payment-flow transaction.
   *
   * Atomic state CAS via `claim()` — the `where: { kind: { $in: [...] } }`
   * predicate prevents a payment-flow row from being matched through this
   * verb. Multi-source `from` (`['imported', 'matched']`) supports
   * re-match after `unmatch()` (`matched → imported → matched`) without
   * losing the prior mapping if the host wants to overwrite it.
   *
   * After a successful claim, `LedgerBridge.onTransactionMatched` runs
   * — the canonical implementation creates a journal entry and chains
   * `journalize()` to record the JE ref. The bridge call is OUTSIDE the
   * claim's CAS window because JE posting is a side effect that may
   * take seconds (cross-process call to ledger).
   */
  async match(
    id: string,
    data: {
      mapping: { debitAccount?: string; creditAccount?: string; notes?: string };
      relatedTransactionId?: string;
      matchedBy?: string;
    },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }

    // Compile-time check — feeding the right machine; primitives' assertTransition fires
    // via the StateMachine wrapper and rejects illegal current states before the round-trip.
    const machine = smFor(existing.kind);
    machine.validate(existing.status as never, TRANSACTION_STATUS.MATCHED as never, id);

    const patch: Record<string, unknown> = {
      $set: {
        matching: {
          ...data.mapping,
          ...(data.matchedBy !== undefined ? { matchedBy: data.matchedBy } : {}),
          matchedAt: new Date(),
        },
        ...(data.matchedBy !== undefined ? { verifiedBy: data.matchedBy } : {}),
        verifiedAt: new Date(),
      },
      // Belt-and-suspenders: a re-match (matched → matched with new mapping)
      // must drop any prior `journalEntryRef`. The current SM blocks
      // journalized → matched so this is moot today, but if a future SM
      // loosening allows it, leaving a stale ref pointing at a now-
      // superseded JE is the worst class of accounting bug. Cheap to
      // unconditionally clear here.
      $unset: { journalEntryRef: 1 },
    };
    if (data.relatedTransactionId !== undefined) {
      (patch.$set as Record<string, unknown>).relatedTransactionId = data.relatedTransactionId;
    }

    // Multi-source CAS — `imported → matched` is the happy path; `matched → matched`
    // (re-match-with-different-mapping) lands as an idempotent no-state-write.
    const claimed = await this.claim(
      existing._id,
      {
        from: [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED, TRANSACTION_STATUS.PENDING],
        to: TRANSACTION_STATUS.MATCHED,
        where: { kind: existing.kind },
      },
      patch,
      this.optsFromCtx(ctx) as never,
    );
    if (!claimed) {
      throw new ValidationError(`Transaction ${id} could not be matched (race-loss or illegal state)`);
    }

    await this.deps.bridges.ledger?.onTransactionMatched?.(
      claimed as unknown as Record<string, unknown>,
      data.mapping,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_MATCHED,
        {
          transaction: claimed,
          mapping: data.mapping,
          ...(data.relatedTransactionId !== undefined ? { relatedTransactionId: data.relatedTransactionId } : {}),
          ...(data.matchedBy !== undefined ? { matchedBy: data.matchedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Revert a matched transaction back to `imported`. Clears the
   * `matching` block and `relatedTransactionId`. Notifies the
   * LedgerBridge (which typically voids the journal entry) AFTER the
   * state CAS lands.
   *
   * Only legal for `kind: 'bank_feed'` — manual entries don't allow
   * un-match (the manual SM has no `matched → pending` edge).
   */
  async unmatch(
    id: string,
    options: { unmatchedBy?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED) {
      throw new WrongTransactionKindError(id, 'bank_feed', existing.kind);
    }

    const priorJournalEntryRef = existing.journalEntryRef;

    const claimed = await this.claim(
      existing._id,
      {
        from: TRANSACTION_STATUS.MATCHED,
        to: TRANSACTION_STATUS.IMPORTED,
        where: { kind: TRANSACTION_KIND.BANK_FEED },
      },
      {
        $unset: {
          matching: 1,
          relatedTransactionId: 1,
          journalEntryRef: 1,
          verifiedBy: 1,
          verifiedAt: 1,
        },
      },
      this.optsFromCtx(ctx) as never,
    );
    if (!claimed) {
      throw new ValidationError(`Transaction ${id} could not be unmatched (current state is not 'matched')`);
    }

    await this.deps.bridges.ledger?.onTransactionUnmatched?.(
      claimed as unknown as Record<string, unknown>,
      priorJournalEntryRef,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_UNMATCHED,
        {
          transaction: claimed,
          ...(options.unmatchedBy !== undefined ? { unmatchedBy: options.unmatchedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Stamp the journal entry reference and transition `matched →
   * journalized`. Typical caller is the `LedgerBridge.onTransactionMatched`
   * implementation — after creating a JE, it calls this verb so the row
   * carries the back-reference.
   */
  async journalize(
    id: string,
    data: { journalEntryRef: { type: string; id: string }; journalizedBy?: string },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }

    const machine = smFor(existing.kind);
    machine.validate(existing.status as never, TRANSACTION_STATUS.JOURNALIZED as never, id);

    const claimed = await this.claim(
      existing._id,
      {
        from: TRANSACTION_STATUS.MATCHED,
        to: TRANSACTION_STATUS.JOURNALIZED,
        where: { kind: existing.kind },
      },
      { $set: { journalEntryRef: data.journalEntryRef } },
      this.optsFromCtx(ctx) as never,
    );
    if (!claimed) {
      throw new ValidationError(`Transaction ${id} could not be journalized (current state is not 'matched')`);
    }

    await this.deps.bridges.ledger?.onTransactionJournalized?.(
      claimed as unknown as Record<string, unknown>,
      data.journalEntryRef,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_JOURNALIZED,
        {
          transaction: claimed,
          journalEntryRef: data.journalEntryRef,
          ...(data.journalizedBy !== undefined ? { journalizedBy: data.journalizedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Operator skip — marks an imported / matched / pending row as
   * rejected (terminal). Use cases: duplicate of an already-imported
   * row, non-cash entry the host doesn't want in the ledger, manual
   * correction overrides.
   *
   * `relatedTransactionId` is preserved; reversal is the host's call.
   */
  async reject(
    id: string,
    data: { reason: string; rejectedBy?: string },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }

    const machine = smFor(existing.kind);
    machine.validate(existing.status as never, TRANSACTION_STATUS.REJECTED as never, id);

    const claimed = await this.claim(
      existing._id,
      {
        from: [
          TRANSACTION_STATUS.IMPORTED,
          TRANSACTION_STATUS.MATCHED,
          TRANSACTION_STATUS.PENDING,
        ],
        to: TRANSACTION_STATUS.REJECTED,
        where: { kind: existing.kind },
      },
      {
        $set: {
          failureReason: data.reason,
          failedAt: new Date(),
          ...(data.rejectedBy !== undefined ? { verifiedBy: data.rejectedBy } : {}),
        },
      },
      this.optsFromCtx(ctx) as never,
    );
    if (!claimed) {
      throw new ValidationError(`Transaction ${id} could not be rejected (illegal current state)`);
    }

    await this.deps.bridges.ledger?.onTransactionRejected?.(
      claimed as unknown as Record<string, unknown>,
      data.reason,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_REJECTED,
        {
          transaction: claimed,
          reason: data.reason,
          ...(data.rejectedBy !== undefined ? { rejectedBy: data.rejectedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Soft-delete bank-feed rows that the upstream feed has retracted
   * (Plaid `removed[]`, OFX correction).
   *
   * Each row is matched by `(orgId, bankAccountId, externalId)`; rows
   * already journalized are NOT silently kept — they're surfaced in
   * `retainedJournalized` so the caller can surface them in the UI
   * ("the feed retracted these N rows but they're posted; reverse
   * manually"). The host's `LedgerBridge` should post a reversing JE
   * for those before any subsequent `delete()` can succeed.
   *
   * @returns `removed` (count soft-deleted), `retainedJournalized`
   *          (rows kept because they're already in the GL).
   */
  async removeByFeed(
    externalIds: string[],
    opts: { bankAccountId: string; source: string },
    ctx: RevenueContext = {},
  ): Promise<{ removed: number; retainedJournalized: TransactionDocument[] }> {
    if (externalIds.length === 0) return { removed: 0, retainedJournalized: [] };

    // Pull EVERY row matching the feed retraction — both the deletable
    // ones AND the journalized ones — so the caller sees what was kept.
    const allFilter: Record<string, unknown> = {
      kind: TRANSACTION_KIND.BANK_FEED,
      bankAccountId: opts.bankAccountId,
      externalId: { $in: externalIds },
      deletedAt: null,
    };
    const allDocs = (await this.findAll(
      allFilter,
      this.optsFromCtx(ctx),
    )) as unknown as TransactionDocument[];
    if (!Array.isArray(allDocs) || allDocs.length === 0) {
      return { removed: 0, retainedJournalized: [] };
    }

    const retainedJournalized: TransactionDocument[] = [];
    const removable: TransactionDocument[] = [];
    for (const doc of allDocs) {
      if (doc.status === TRANSACTION_STATUS.JOURNALIZED) retainedJournalized.push(doc);
      else removable.push(doc);
    }

    let removed = 0;
    for (const doc of removable) {
      await this.delete(doc._id, this.optsFromCtx(ctx));
      removed += 1;
      await this.deps.bridges.ledger?.onTransactionRemovedByFeed?.(
        doc as unknown as Record<string, unknown>,
        ctx,
      );
      await this.dispatch(
        createEvent(
          REVENUE_EVENTS.TRANSACTION_REMOVED_BY_FEED,
          {
            transaction: doc,
            source: opts.source,
            externalId: doc.externalId ?? '',
          },
          ctx,
          { resource: 'transaction', resourceId: doc.publicId },
        ),
        ctx,
      );
    }
    return { removed, retainedJournalized };
  }

  /**
   * Find candidate matches for cross-referencing a payment-flow row to
   * its bank deposit (or vice-versa).
   *
   * Heuristic:
   *   - same currency by default; cross-currency requires `fxRate` on
   *     the candidate row (multi-currency reconciliation).
   *   - amount within `amountTolerancePct` (default 1%) — accounts for
   *     gateway fees / FX rounding.
   *   - posted/created within `toleranceDays` of the target date
   *     (default 3 days — covers ACH delays, weekend settlement).
   *   - terminal verified states only (`verified` / `completed` for
   *     payment_flow, `imported` / `matched` for bank_feed).
   *
   * Returned candidates are unsorted; callers rank by their own
   * confidence model (counterparty fuzzy match, currency identity,
   * exact-amount preference, …).
   */
  async findMatchCandidates(
    filter: {
      amount: number;
      currency?: string;
      postedDate: Date;
      toleranceDays?: number;
      amountTolerancePct?: number;
      counterpartyName?: string;
      kind?: TransactionKindValue;
    },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument[]> {
    const tolerance = filter.toleranceDays ?? 3;
    const pct = filter.amountTolerancePct ?? 0.01;
    const start = new Date(filter.postedDate.getTime() - tolerance * 86400_000);
    const end = new Date(filter.postedDate.getTime() + tolerance * 86400_000);
    const minAmount = filter.amount * (1 - pct);
    const maxAmount = filter.amount * (1 + pct);

    const targetKind = filter.kind ?? TRANSACTION_KIND.PAYMENT_FLOW;
    const validStatuses =
      targetKind === TRANSACTION_KIND.PAYMENT_FLOW
        ? [TRANSACTION_STATUS.VERIFIED, TRANSACTION_STATUS.COMPLETED]
        : [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED];

    // Settlement-window timestamp depends on kind:
    //   - `bank_feed` rows carry `postedDate` (the bank's settled-on date).
    //   - `payment_flow` rows carry `verifiedAt` (the gateway's confirm-on
    //     timestamp). `postedDate` is never set on payment_flow, and
    //     `createdAt` is "row insertion time" which can be hours-to-days
    //     after the actual charge — too noisy to anchor reconciliation.
    // Falling back to `createdAt` keeps legacy rows (verified before the
    // field existed) match-able, matching how upgraded ledgers usually
    // backfill `verifiedAt = createdAt` on the first migration.
    const dateClauses: Record<string, unknown>[] =
      targetKind === TRANSACTION_KIND.BANK_FEED
        ? [{ postedDate: { $gte: start, $lte: end } }]
        : [
            { verifiedAt: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } },
          ];

    const query: Record<string, unknown> = {
      kind: targetKind,
      status: { $in: validStatuses },
      amount: { $gte: minAmount, $lte: maxAmount },
      $or: dateClauses,
    };
    if (filter.currency !== undefined) query.currency = filter.currency;
    if (filter.counterpartyName !== undefined) {
      query['counterparty.name'] = { $regex: escapeRegex(filter.counterpartyName), $options: 'i' };
    }

    const docs = await this.findAll(query, this.optsFromCtx(ctx, { limit: 50 }));
    return (Array.isArray(docs) ? docs : []) as unknown as TransactionDocument[];
  }

  /**
   * Running balance for a bank account as of `asOf` (defaults to now).
   *
   * Uses mongokit's tenant-scoped read via `findAll` — inflows minus
   * outflows over `kind: 'bank_feed'`, terminal states only. For audit
   * pages where exact-to-the-cent reconciliation is required, prefer
   * the most recent row's `balanceAfter` (banks ship that field on
   * every entry).
   */
  async getRunningBalance(
    bankAccountId: string,
    asOf: Date = new Date(),
    ctx: RevenueContext = {},
  ): Promise<{ balance: number; currency: string | null; rowCount: number; asOf: Date }> {
    const filter: Record<string, unknown> = {
      kind: TRANSACTION_KIND.BANK_FEED,
      bankAccountId,
      postedDate: { $lte: asOf },
      status: { $in: [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED, TRANSACTION_STATUS.JOURNALIZED] },
      deletedAt: null,
    };
    const rows = (await this.findAll(filter, this.optsFromCtx(ctx))) as unknown as TransactionDocument[];

    let balance = 0;
    let currency: string | null = null;
    for (const row of rows) {
      if (currency === null) currency = row.currency;
      balance += row.flow === 'inflow' ? row.amount : -row.amount;
    }
    return { balance, currency, rowCount: rows.length, asOf };
  }
}

/** Escape user-provided strings before embedding in `$regex`. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
