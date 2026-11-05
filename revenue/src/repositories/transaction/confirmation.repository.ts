import { isDuplicateKeyError } from '@classytic/mongokit';
import { PAYMENT_EVENT_TYPE } from '@classytic/primitives/payment-events';
import { durableEventMeta } from '@classytic/primitives/durable-events';
import { money } from '@classytic/primitives/money';
import type { PaymentResult, PaymentReturnCommand } from '@classytic/primitives/payment-gateway';
import { TransactionRefundRepository } from './refund.repository.js';
import type { RevenueContext } from '../../core/context.js';
import type { TransactionDocument } from '../../models/transaction.schema.js';
import { PaymentReturnRejectedError, ConfigurationError, ConfirmationOutcomeUnknownError, TransactionNotFoundError, ValidationError } from '../../core/errors.js';
import { TRANSACTION_STATUS } from '../../enums/transaction.enums.js';
import { TRANSACTION_STATE_MACHINE } from '../../core/state-machines.js';
import { buildPaymentCommandContext, providerKeyFor } from '../../providers/command-context.js';
import { returnProofDigest } from '../../providers/return-proof.js';
import { executeProviderCommand } from '../../providers/execute-command.js';
import { createEvent } from '../../events/helpers.js';
import { canonicalSourceOf, toPaymentFailed, toPaymentSucceeded } from '../../events/canonical-payment-events.js';

const CONFIRMABLE = [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING, TRANSACTION_STATUS.REQUIRES_ACTION];
const SETTLED = [TRANSACTION_STATUS.VERIFIED, TRANSACTION_STATUS.PARTIALLY_REFUNDED, TRANSACTION_STATUS.REFUNDED];

/** Claims one execution per transaction; subsequent calls only observe the provider. */
export abstract class TransactionConfirmationRepository extends TransactionRefundRepository {
  /** Resolve scope from a durable proof, then confirm only an approved return. */
  async confirmReturn(input: PaymentReturnCommand, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    if (ctx.session) throw new ValidationError('Payment returns must run outside a caller transaction.');
    if (typeof input.provider !== 'string' || !input.provider || input.provider.length > 100
      || typeof input.paymentId !== 'string' || !input.paymentId || input.paymentId.length > 255
      || typeof input.token !== 'string' || !input.token.trim() || input.token.length > 2048
      || !['success', 'failure', 'cancel'].includes(input.status)) throw new PaymentReturnRejectedError();
    const attempts = this.deps.paymentAttempts;
    if (!attempts) throw new ConfigurationError('PaymentAttempt repository is not wired.');
    // The routing directory discovers the owner from the proof; every read and write after it is scoped.
    const routes = this.deps.returnProofRoutes;
    if (!routes) throw new ConfigurationError('Return-proof route store is not wired.');
    const digest = returnProofDigest(input.provider, input.paymentId, input.token);
    const route = await routes.find(digest);
    if (!route || (this.deps.tenantScopeEnabled && !route.organizationId)
      || (ctx.organizationId && ctx.organizationId !== route.organizationId)) throw new PaymentReturnRejectedError();
    const routed: RevenueContext = route.organizationId ? { organizationId: route.organizationId } : {};
    const attempt = await attempts.getByQuery({
      operation: 'create-intent', provider: input.provider,
      'returnProof.digest': digest,
      'returnProof.expiresAt': { $gt: new Date() },
    }, this.optsFromCtx(routed, { throwOnNotFound: false, select: '+returnProof' }));
    const proof = attempt?.returnProof;
    if (!attempt || !proof || (route.organizationId && proof.organizationId !== route.organizationId)) throw new PaymentReturnRejectedError();
    const owner: RevenueContext = {
      ...(proof.organizationId ? { organizationId: proof.organizationId } : {}),
      ...(ctx.actorId ? { actorId: ctx.actorId } : {}),
    };
    const opts = this.optsFromCtx(owner, { throwOnNotFound: false });
    // The stable creation key also recovers a crash between transaction creation and attempt linking.
    const transaction = attempt.transactionId
      ? await this.getById(String(attempt.transactionId), opts)
      : await this.getByQuery({ idempotencyKey: attempt.idempotencyKey }, opts);
    if (!transaction || transaction.kind !== 'payment_flow' || transaction.method !== input.provider
      || transaction.idempotencyKey !== attempt.idempotencyKey
      || (transaction.gateway?.sessionId ?? transaction.gateway?.paymentIntentId) !== input.paymentId
      || transaction.amount !== attempt.amount || transaction.currency !== attempt.currency) throw new PaymentReturnRejectedError();
    // Cancel/failure query strings cannot decide whether money moved or authorize execution.
    if (input.status !== 'success') return transaction;
    const transactionId = String(transaction._id);
    if (SETTLED.some(status => status === transaction.status) || transaction.status === TRANSACTION_STATUS.FAILED) return this.confirm(transactionId, owner);
    if (!CONFIRMABLE.some(status => status === transaction.status)) throw new PaymentReturnRejectedError();
    const existing = await attempts.getByQuery({ operation: 'confirm', provider: input.provider, idempotencyKey: `confirm:${transactionId}` }, opts);
    if (existing) return this.confirm(transactionId, owner);
    const provider = this.deps.providers.get(input.provider);
    const reference = transaction.gateway?.metadata?.merchantReference;
    if (typeof reference !== 'string') throw new ConfirmationOutcomeUnknownError(transactionId);
    let observation: PaymentResult;
    try { observation = await provider.getStatus(input.paymentId, buildPaymentCommandContext({
      operation: 'observe-return', subjectId: transactionId, merchantReference: reference, organizationId: owner.organizationId,
    })); }
    catch { throw new ConfirmationOutcomeUnknownError(transactionId); }
    if (typeof reference !== 'string' || observation.provider !== provider.name
      || !this.matchesConfirmation(observation, transaction, input.paymentId, reference)) throw new ConfirmationOutcomeUnknownError(transactionId);
    // Do not consume the one-shot execution claim while customer approval is incomplete.
    if (observation.status !== 'succeeded' && (!['requires_action', 'processing'].includes(observation.status) || observation.confirmationReady !== true)) return transaction;
    return this.confirm(transactionId, owner);
  }

  async confirm(transactionId: string, ctx: RevenueContext = {}): Promise<TransactionDocument> {
    if (ctx.session) throw new ValidationError('Payment confirmation must run outside a caller transaction.');
    if (this.deps.tenantScopeEnabled && !ctx.organizationId) throw new ValidationError('organizationId is required for confirmation.');
    if (this.deps.outbox?.transactionalSave !== true) throw new ConfigurationError('Payment confirmation requires a transactional durable outbox.');
    const opts = this.optsFromCtx(ctx, { throwOnNotFound: false });
    const transaction = await this.getById(transactionId, opts);
    if (!transaction) throw new TransactionNotFoundError(transactionId);
    const provider = this.deps.providers.get(transaction.method);
    const confirm = provider.confirmPayment?.bind(provider);
    if (!provider.getCapabilities().supportsConfirmation || !confirm) throw new ValidationError('Provider does not support explicit confirmation.');
    if (transaction.kind !== 'payment_flow') throw new ValidationError('Only payment-flow transactions can be confirmed.');
    if (SETTLED.some(status => status === transaction.status)) return transaction;
    const attempts = this.deps.paymentAttempts;
    if (!attempts) throw new ConfigurationError('PaymentAttempt repository is not wired.');
    const key = `confirm:${String(transaction._id)}`;
    const prior = await attempts.getByQuery({ operation: 'confirm', provider: transaction.method, idempotencyKey: key }, opts);
    if (transaction.status === TRANSACTION_STATUS.FAILED && (!prior || prior.outcome === 'declined')) return transaction;
    if (!CONFIRMABLE.some(status => status === transaction.status) && !prior) throw new ValidationError('Transaction cannot be confirmed in its current state.');
    const intentId = transaction.gateway?.sessionId ?? transaction.gateway?.paymentIntentId;
    const merchantReference = transaction.gateway?.metadata?.merchantReference;
    if (typeof intentId !== 'string' || typeof merchantReference !== 'string') throw new ValidationError('Payment confirmation correlation is missing.');
    const command = buildPaymentCommandContext({
      operation: 'confirm', subjectId: String(transaction._id), merchantReference,
      idempotencyKey: providerKeyFor(key, ctx.organizationId, this.deps.tenantScopeEnabled === true),
      organizationId: ctx.organizationId,
    });
    let first = true;
    try {
      await attempts.create({
        transactionId: transaction._id, operation: 'confirm', provider: transaction.method,
        idempotencyKey: key, providerKey: command.idempotencyKey,
        amount: transaction.amount, currency: transaction.currency, outcome: 'pending',
        providerReference: intentId,
      }, this.optsFromCtx(ctx));
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      first = false;
    }
    const attempt = await attempts.getByQuery({ operation: 'confirm', provider: transaction.method, idempotencyKey: key }, opts);
    if (!attempt || String(attempt.transactionId) !== String(transaction._id)) throw new ConfigurationError('Confirmation attempt correlation is missing.');
    // Never re-execute: a crash or a concurrent return may have left the first call in flight.
    const result = await executeProviderCommand(
      () => first ? confirm(intentId, command) : provider.getStatus(intentId, command),
      { command, providerReference: intentId },
    );
    const observed: PaymentResult | undefined = result.outcome === 'confirmed' ? result.value
      : first && result.outcome === 'declined' ? {
        id: intentId, provider: provider.name, merchantReference, amount: money(transaction.amount, transaction.currency), status: 'failed',
      } : undefined;
    if (!observed || observed.provider !== provider.name || !this.matchesConfirmation(observed, transaction, intentId, merchantReference)
      || (observed.status !== 'succeeded' && observed.status !== 'failed')) {
      await attempts.claim(String(attempt._id), { field: 'outcome', from: ['pending', 'unknown'], to: 'unknown' }, {
        causeCode: result.outcome === 'unknown' ? result.causeCode : 'status_unavailable',
      }, this.optsFromCtx(ctx));
      const current = await this.getById(transactionId, opts);
      if (current && SETTLED.some(status => status === current.status)) return current;
      throw new ConfirmationOutcomeUnknownError(transactionId);
    }
    return this.transactionWithEvents(async (session, emit) => {
      const writeOpts = this.optsFromCtx(ctx, { session });
      const current = await this.getById(transactionId, writeOpts);
      if (!current) throw new TransactionNotFoundError(transactionId);
      if (SETTLED.some(status => status === current.status)) return current;
      if (!CONFIRMABLE.some(status => status === current.status)) throw new ConfirmationOutcomeUnknownError(transactionId);
      const target = observed.status === 'succeeded' ? TRANSACTION_STATUS.VERIFIED : TRANSACTION_STATUS.FAILED;
      TRANSACTION_STATE_MACHINE.assertTransition(transactionId, current.status, target);
      const updated = await this.claim(transactionId, {
        field: 'status', from: current.status, to: target,
        where: { kind: 'payment_flow' },
      }, observed.status === 'succeeded' ? { verifiedAt: new Date() } : { failedAt: new Date(), failureReason: 'provider reports payment failed' }, writeOpts);
      if (!updated) throw new ValidationError('Payment state changed during confirmation.');
      await attempts.claim(String(attempt._id), { field: 'outcome', from: ['pending', 'unknown'], to: observed.status === 'succeeded' ? 'confirmed' : 'declined' }, {}, writeOpts);
      const source = canonicalSourceOf(updated);
      const eventType = observed.status === 'succeeded' ? PAYMENT_EVENT_TYPE.SUCCEEDED : PAYMENT_EVENT_TYPE.FAILED;
      await emit(createEvent(
        eventType,
        observed.status === 'succeeded' ? toPaymentSucceeded(source, new Date()) : toPaymentFailed(source, 'provider reports payment failed', new Date()),
        ctx, { ...durableEventMeta(eventType, 1, String(updated._id)), resource: 'transaction', resourceId: updated.publicId },
      ));
      return updated;
    });
  }

  private matchesConfirmation(result: PaymentResult, transaction: TransactionDocument, intentId: string, merchantReference: string): boolean {
    return result.id === intentId && result.merchantReference === merchantReference
      && result.amount?.amount === transaction.amount && result.amount.currency === transaction.currency;
  }

  override async reconcileAttempt(attemptId: string, ctx: RevenueContext = {}) {
    const attempt = await this.deps.paymentAttempts?.getById(attemptId, this.optsFromCtx(ctx, { throwOnNotFound: false }));
    if (attempt?.operation !== 'confirm') return super.reconcileAttempt(attemptId, ctx);
    if (!attempt.transactionId) throw new ValidationError('Confirmation transaction is missing.');
    try {
      await this.confirm(String(attempt.transactionId), ctx);
      const current = await this.deps.paymentAttempts?.getById(attemptId, this.optsFromCtx(ctx, { throwOnNotFound: false }));
      if (current?.outcome === 'confirmed' || current?.outcome === 'declined') {
        return { attemptId, previousOutcome: attempt.outcome, resolved: true, resolvedOutcome: current.outcome };
      }
      return { attemptId, previousOutcome: attempt.outcome, resolved: false, note: 'confirmation attempt still requires reconciliation' };
    } catch (error) {
      if (!(error instanceof ConfirmationOutcomeUnknownError)) throw error;
      return { attemptId, previousOutcome: attempt.outcome, resolved: false, note: 'confirmation remains unresolved' };
    }
  }
}
