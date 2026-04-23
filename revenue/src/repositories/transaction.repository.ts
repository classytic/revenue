import { Repository, withTransaction, type PluginType } from '@classytic/mongokit';
import type { ClientSession, Model } from 'mongoose';
import type { TransactionDocument } from '../models/transaction.schema.js';
import type { RevenueContext } from '../core/context.js';
import type { RevenueBridges } from '../bridges/revenue-bridges.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CommissionConfig } from '../engine/engine-types.js';
import type { DomainEvent, EventTransport } from '@classytic/primitives/events';
import type { OutboxStore } from '@classytic/primitives/outbox';
import { createEvent } from '../events/helpers.js';
import { REVENUE_EVENTS } from '../events/event-constants.js';
import { TRANSACTION_STATUS } from '../enums/transaction.enums.js';
import { HOLD_STATUS } from '../enums/escrow.enums.js';
import { TRANSACTION_STATE_MACHINE } from '../core/state-machines.js';
import { TransactionNotFoundError, ValidationError } from '../core/errors.js';
import { calculateCommission, reverseCommission } from '../shared/calculators/commission.js';
import { reverseTax } from '../shared/calculators/tax.js';
import { calculateSplits, calculateOrganizationPayout } from '../shared/calculators/splits.js';

export interface TransactionRepoDeps {
  events: EventTransport;
  /**
   * Optional host-owned outbox store (PACKAGE_RULES §5.5 + P8). When present,
   * every domain event is persisted via `outbox.save(event)` before the
   * in-process `events.publish(event)` so the host's relay (arc's EventOutbox,
   * a Postgres LISTEN/NOTIFY pump, Kafka Connect, …) can replay on transport
   * failure. When absent, events fire through `events.publish` only.
   */
  outbox?: OutboxStore | undefined;
  providers: ProviderRegistry;
  bridges: RevenueBridges;
  commission?: CommissionConfig;
  defaultCurrency: string;
  logger?: { error(...args: unknown[]): void } | undefined;
}

/**
 * TransactionRepository — extends mongokit Repository.
 *
 * CRUD inherited: getAll, getById, getByQuery, create, update, delete, count, exists.
 * Domain verbs: createPaymentIntent, verify, refund, handleWebhook, hold, release, split.
 *
 * All domain verbs return raw mongokit docs — no custom envelopes.
 * Composite results (refund creates a new doc) are stored in metadata on the primary doc.
 */
export class TransactionRepository extends Repository<TransactionDocument> {
  private deps!: TransactionRepoDeps;

  constructor(model: Model<TransactionDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }

  inject(deps: TransactionRepoDeps): void {
    this.deps = deps;
  }

  /**
   * Thread `ctx.organizationId` (and future ctx fields) into mongokit
   * options so the `multiTenantPlugin` can auto-scope filters, queries,
   * and inserts. Merges any caller-supplied extras. Centralizing this
   * here means every domain verb participates in scope isolation without
   * per-call boilerplate.
   */
  private optsFromCtx(
    ctx: RevenueContext,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...extra };
    if (ctx.organizationId !== undefined) out.organizationId = ctx.organizationId;
    if (ctx.session !== undefined) out.session = ctx.session;
    return out;
  }

  // ─── Dispatch helpers (PACKAGE_RULES P8 / §5.5) ───

  /**
   * Save an event to the host-owned outbox, session-bound when available.
   *
   * When `session` is passed, the outbox row commits atomically with the
   * business write (P8 true session-bound write). When absent, the save
   * happens after commit — still durable via the host's relay, but with a
   * small at-most-once window on process crash.
   *
   * Isolated try/catch: an outbox failure never throws out of this helper;
   * the caller still issues a transport.publish.
   */
  private async saveToOutbox(event: DomainEvent, session?: unknown): Promise<void> {
    if (!this.deps.outbox) return;
    try {
      await this.deps.outbox.save(event, session !== undefined ? { session } : {});
    } catch (err) {
      this.deps.logger?.error('[revenue] outbox.save failed for', event.type, err);
    }
  }

  /**
   * Publish an event to the in-process `EventTransport` after commit.
   * Transport failure is logged — the host relay will still redeliver from
   * the outbox, so in-process subscribers missing an event is recoverable.
   */
  private async publishToTransport(event: DomainEvent): Promise<void> {
    try {
      await this.deps.events.publish(event);
    } catch (err) {
      this.deps.logger?.error('[revenue] events.publish failed for', event.type, err);
    }
  }

  /**
   * Non-transactional dispatch (used by verbs that don't open their own
   * `withTransaction` block): outbox.save (session-bound when ctx provides
   * one) → transport.publish. Matches arc's EventOutbox + MemoryEventTransport
   * wiring bit-for-bit.
   */
  private async dispatch(event: DomainEvent, ctx: RevenueContext = {}): Promise<void> {
    await this.saveToOutbox(event, ctx.session);
    await this.publishToTransport(event);
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
        amount: params.amount, currency,
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
        method: transaction.method, status: TRANSACTION_STATUS.VERIFIED,
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
    const updated = await this.Model.findOneAndUpdate(
      { _id: transaction._id, 'webhook.eventId': { $ne: webhookEvent.id } },
      { $set: { webhook: nextWebhook } },
      { returnDocument: 'after' },
    ).lean<TransactionDocument>();

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
          fee: 0, tax: 0, net: releaseAmount, method: transaction.method,
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
          fee: s.gatewayFeeAmount, tax: 0, net: s.netAmount, method: transaction.method,
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
        fee: 0, tax: 0, net: orgPayout, method: transaction.method,
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
}
