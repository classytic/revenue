import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { money } from '@classytic/primitives/money';
import type { DomainEvent } from '@classytic/primitives/events';
import type { OutboxStore, OutboxWriteOptions } from '@classytic/primitives/outbox';
import type { CreateIntentParams, PaymentCommandContext, PaymentProviderPort, PaymentResult, ProviderIntent, ProviderCapabilities, RefundResult, WebhookEvent } from '@classytic/primitives/payment-gateway';
import { intentRequestFingerprint } from '../../revenue/src/providers/intent-identity.js';
import { ConfirmationOutcomeUnknownError, IntentOutcomeUnknownError } from '../../revenue/src/core/errors.js';
import { bindRevenue } from '../helpers/bind-revenue.js';
import { clearCollections, connectToMongoDB, disconnectFromMongoDB } from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';

class RedirectProvider implements PaymentProviderPort {
  readonly name = 'redirect';
  creates = 0;
  executes = 0;
  queries = 0;
  lastQueryCommand: PaymentCommandContext | undefined;
  loseCreateResponse = false;
  loseExecuteResponse = false;
  wrongAmount = false;
  wrongReference = false;
  completed = false;
  ready = true;
  queryUnavailable = false;
  idempotentCreate = false;
  idempotencyWindowMs: number | null = null;
  declineExecute = false;
  afterExecute?: () => Promise<void>;
  returnToken?: string;
  private payments = new Map<string, PaymentResult>();

  async createIntent(params: CreateIntentParams, command: PaymentCommandContext): Promise<ProviderIntent> {
    this.creates++;
    if (this.loseCreateResponse) throw new Error('network timeout');
    const id = `intent-${this.creates}`;
    this.payments.set(id, { id, provider: this.name, amount: params.amount, merchantReference: command.merchantReference, status: 'requires_action' });
    return { id, sessionId: id, paymentIntentId: id, provider: this.name, amount: params.amount, status: 'requires_action',
      ...(this.returnToken ? { returnProof: { token: this.returnToken, validForMs: 86400000 } } : {}) };
  }
  async confirmPayment(id: string): Promise<PaymentResult> {
    this.executes++;
    if (this.declineExecute) throw Object.assign(new Error('declined'), { decline: { reason: 'insufficient_funds', retryable: true } });
    this.completed = true;
    await this.afterExecute?.();
    if (this.loseExecuteResponse) throw new Error('network timeout');
    return this.observation(id);
  }
  private observation(id: string): PaymentResult {
    const payment = this.payments.get(id);
    if (!payment) throw new Error('unknown payment');
    return { ...payment, confirmationReady: this.ready, status: this.completed ? 'succeeded' : 'requires_action',
      ...(this.wrongAmount ? { amount: money(100, 'BDT') } : {}),
      ...(this.wrongReference ? { merchantReference: 'other-order' } : {}) };
  }
  async getStatus(id: string, command?: PaymentCommandContext): Promise<PaymentResult> { this.lastQueryCommand = command; this.queries++; if (this.queryUnavailable) throw new Error('query timeout'); return this.observation(id); }
  async verifyPayment(id: string): Promise<PaymentResult> { return this.getStatus(id); }
  async refund(_id: string, amount?: number | null): Promise<RefundResult> {
    return { id: 'refund-1', provider: this.name, status: 'succeeded', amount: money(amount ?? 1999, 'BDT') };
  }
  async handleWebhook(): Promise<WebhookEvent> { throw new Error('not supported'); }
  verifyWebhookSignature(): boolean { return false; }
  getCapabilities(): ProviderCapabilities {
    return { supportsConfirmation: true, supportsIdempotentCreate: this.idempotentCreate, supportsWebhooks: false,
      idempotentCreateWindowMs: this.idempotencyWindowMs,
      supportsRefunds: true, supportsPartialRefunds: true, requiresManualVerification: false };
  }
}

let engine: ReturnType<typeof bindRevenue>;
let provider: RedirectProvider;
const published: DomainEvent[] = [];
const ctx = { organizationId: 'homeshop' };
let failOutcomeSave = false;
const outbox: OutboxStore = {
  transactionalSave: true,
  save: async (event: DomainEvent, options?: OutboxWriteOptions) => {
    if (event.type === 'payment.succeeded') {
      expect(options?.session).toBeTruthy();
      if (failOutcomeSave) throw new Error('simulated durable outbox failure');
    }
  },
  getPending: async () => [],
  acknowledge: async () => {},
};

beforeAll(async () => {
  expect(await connectToMongoDB(), 'Payment safety tests require a real replica set').toBe(true);
}, 30_000);

beforeEach(async () => {
  if (engine) await engine.close();
  published.length = 0;
  failOutcomeSave = false;
  provider = new RedirectProvider();
  engine = bindRevenue({
    connection: mongoose.connection, defaultCurrency: 'BDT', providers: { redirect: provider },
    modules: { subscription: false, escrow: false, settlement: false },
    scope: { enabled: true, fieldType: 'string' }, forceRecreate: true,
    outbox,
    eventTransport: { name: 'confirmation-test', publish: async event => { published.push(event); }, subscribe: async () => () => {} },
  });
  await warmModels(engine);
  await engine.models.PaymentAttempt.init();
  await clearCollections();
});

afterAll(async () => { if (engine) await engine.close(); await disconnectFromMongoDB(); });

async function payment() {
  return engine.repositories.transaction.createPaymentIntent({ amount: 1999, gateway: 'redirect', methodKind: 'mobile_money', idempotencyKey: 'order-1' }, ctx);
}

describe('durable money-moving confirmation', () => {
  it('confirms once and replays without another execute or success event', async () => {
    const transaction = await payment();
    const repo = engine.repositories.transaction;
    expect((await repo.confirm(String(transaction._id), ctx)).status).toBe('verified');
    expect((await repo.confirm(String(transaction._id), ctx)).status).toBe('verified');
    expect(provider.executes).toBe(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(1);
    expect(published.find(event => event.type === 'payment.succeeded')?.meta.id).toBe(`payment.succeeded:v1:${String(transaction._id)}`);
    const attempt = await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, ctx);
    expect(attempt?.outcome).toBe('confirmed');
  });

  it('recovers a timeout after execution by querying, without re-executing', async () => {
    const transaction = await payment();
    provider.loseExecuteResponse = true;
    await expect(engine.repositories.transaction.confirm(String(transaction._id), ctx)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(0);
    expect((await engine.repositories.transaction.confirm(String(transaction._id), ctx)).status).toBe('verified');
    expect(provider.executes).toBe(1);
    expect(provider.queries).toBe(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(1);
  });

  it('concurrent callbacks converge on one execution and one payment outcome', async () => {
    const transaction = await payment();
    const id = String(transaction._id);
    await Promise.allSettled([engine.repositories.transaction.confirm(id, ctx), engine.repositories.transaction.confirm(id, ctx)]);
    expect((await engine.repositories.transaction.confirm(id, ctx)).status).toBe('verified');
    expect(provider.executes).toBe(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(1);
  });

  it.each(['amount', 'reference'])('does not settle an execution with a mismatched %s', async field => {
    const transaction = await payment();
    provider.wrongAmount = field === 'amount';
    provider.wrongReference = field === 'reference';
    await expect(engine.repositories.transaction.confirm(String(transaction._id), ctx)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    expect((await engine.repositories.transaction.getById(String(transaction._id), ctx))?.status).toBe('pending');
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(0);
  });

  it('refuses another organization and a missing organization before provider I/O', async () => {
    const transaction = await payment();
    await expect(engine.repositories.transaction.confirm(String(transaction._id), { organizationId: 'other' })).rejects.toThrow();
    await expect(engine.repositories.transaction.confirm(String(transaction._id))).rejects.toThrow('organizationId');
    expect(provider.executes).toBe(0);
    expect(provider.queries).toBe(0);
  });

  it('keeps a crashed pending execution unresolved when the provider has no outcome', async () => {
    const transaction = await payment();
    await engine.repositories.paymentAttempt.create({ transactionId: transaction._id, provider: 'redirect', operation: 'confirm',
      idempotencyKey: `confirm:${String(transaction._id)}`, amount: transaction.amount, currency: transaction.currency, outcome: 'pending' }, ctx);
    await expect(engine.repositories.transaction.confirm(String(transaction._id), ctx)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    expect(provider.executes).toBe(0);
    expect(provider.queries).toBe(1);
  });

  it('routes confirmation maintenance through query/finalization rather than create reconciliation', async () => {
    const transaction = await payment();
    provider.loseExecuteResponse = true;
    await expect(engine.repositories.transaction.confirm(String(transaction._id), ctx)).rejects.toThrow();
    const attempt = await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, ctx);
    expect(attempt).toBeTruthy();
    if (!attempt) throw new Error('confirmation attempt missing');
    expect(await engine.repositories.transaction.reconcileAttempt(String(attempt._id), ctx)).toMatchObject({ resolved: true });
    expect(provider.executes).toBe(1);
  });

  it('blocks same-key create redrive when the gateway has no idempotency guarantee', async () => {
    provider.loseCreateResponse = true;
    await expect(payment()).rejects.toBeInstanceOf(IntentOutcomeUnknownError);
    await expect(payment()).rejects.toBeInstanceOf(IntentOutcomeUnknownError);
    expect(provider.creates).toBe(1);
  });

  it('rolls payment/attempt finalization back when durable event persistence fails, then recovers by query', async () => {
    const transaction = await payment();
    failOutcomeSave = true;
    await expect(engine.repositories.transaction.confirm(String(transaction._id), ctx)).rejects.toThrow('outbox failure');
    expect((await engine.repositories.transaction.getById(String(transaction._id), ctx))?.status).toBe('pending');
    expect((await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, ctx))?.outcome).toBe('pending');
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(0);
    failOutcomeSave = false;
    expect((await engine.repositories.transaction.confirm(String(transaction._id), ctx)).status).toBe('verified');
    expect(provider.executes).toBe(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(1);
  });

  it('does not let the old verification path bypass confirmation validation', async () => {
    const transaction = await payment();
    provider.completed = true;
    await expect(engine.repositories.transaction.verify(String(transaction._id), {}, ctx)).rejects.toThrow('durable confirm');
    expect(provider.executes).toBe(0);
    expect(provider.queries).toBe(0);
  });

  it('refuses execution without a transactional outbox', async () => {
    await engine.close();
    engine = bindRevenue({ connection: mongoose.connection, defaultCurrency: 'BDT', providers: { redirect: provider },
      scope: { enabled: true, fieldType: 'string' }, forceRecreate: true,
      modules: { subscription: false, escrow: false, settlement: false } });
    await expect(engine.repositories.transaction.confirm('not-read-before-preflight', ctx)).rejects.toThrow('transactional durable outbox');
    expect(provider.executes).toBe(0);
  });

  it('records a definitive execution decline without treating it as uncertain or executing again', async () => {
    const transaction = await payment();
    provider.declineExecute = true;
    expect((await engine.repositories.transaction.confirm(String(transaction._id), ctx)).status).toBe('failed');
    expect((await engine.repositories.transaction.confirm(String(transaction._id), ctx)).status).toBe('failed');
    expect((await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, ctx))?.outcome).toBe('declined');
    expect(provider.executes).toBe(1);
    expect(published.filter(event => event.type === 'payment.failed')).toHaveLength(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(0);
  });

  it('refuses manual rejection/void for a provider-owned outcome', async () => {
    const transaction = await payment();
    const repo = engine.repositories.transaction;
    await expect(repo.fail(String(transaction._id), { reason: 'operator rejection' }, ctx)).rejects.toThrow('belongs to the provider');
    await expect(repo.cancel(String(transaction._id), { reason: 'operator void' }, ctx)).rejects.toThrow('no operator void');
    expect(provider.executes).toBe(0);
  });

  it('retains unresolved execution when another writer changes the payment state', async () => {
    const transaction = await payment();
    provider.afterExecute = async () => {
      await engine.repositories.transaction.update(String(transaction._id), { status: 'failed' }, ctx);
    };
    await expect(engine.repositories.transaction.confirm(String(transaction._id), ctx)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    await expect(engine.repositories.transaction.confirm(String(transaction._id), ctx)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    expect((await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, ctx))?.outcome).not.toBe('declined');
    expect(provider.executes).toBe(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(0);
  });

  it('replays a later callback after refund without charging or regressing the refund state', async () => {
    const transaction = await payment();
    const repo = engine.repositories.transaction;
    await repo.confirm(String(transaction._id), ctx);
    await repo.refund(String(transaction._id), 1999, { idempotencyKey: 'refund-1' }, ctx);
    expect((await repo.confirm(String(transaction._id), ctx)).status).toBe('refunded');
    expect(provider.executes).toBe(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(1);
  });

  it('does not redrive a create after the gateway deduplication window expires', async () => {
    provider.idempotentCreate = true;
    provider.idempotencyWindowMs = 86_400_000;
    await engine.repositories.paymentAttempt.create({ operation: 'create-intent', provider: 'redirect', idempotencyKey: 'order-1', providerKey: 'order-1',
      amount: 1999, currency: 'BDT', methodKind: 'mobile_money', requestFingerprint: intentRequestFingerprint({ amount: 1999, gateway: 'redirect', methodKind: 'mobile_money', idempotencyKey: 'order-1' }, 'BDT'), outcome: 'unknown', createdAt: new Date(Date.now() - 2 * 86_400_000) }, ctx);
    await expect(payment()).rejects.toBeInstanceOf(IntentOutcomeUnknownError);
    expect(provider.creates).toBe(0);
  });

  it('permits create redrive within an explicitly declared deduplication window', async () => {
    provider.idempotentCreate = true;
    provider.idempotencyWindowMs = 86_400_000;
    await engine.repositories.paymentAttempt.create({ operation: 'create-intent', provider: 'redirect', idempotencyKey: 'order-1', providerKey: 'order-1',
      amount: 1999, currency: 'BDT', methodKind: 'mobile_money', requestFingerprint: intentRequestFingerprint({ amount: 1999, gateway: 'redirect', methodKind: 'mobile_money', idempotencyKey: 'order-1' }, 'BDT'), outcome: 'unknown', createdAt: new Date() }, ctx);
    expect(await payment()).toMatchObject({ amount: 1999, status: 'pending' });
    expect(provider.creates).toBe(1);
  });
});


describe('private payment return authorization', () => {
  const token = 'server-only-test-return-token';
  const input = { provider: 'redirect', paymentId: 'intent-1', token, status: 'success' as const };
  beforeEach(() => { provider.returnToken = token; });

  it('persists only a digest, excludes it from normal reads/history/events and resolves owner scope', async () => {
    const transaction = await payment();
    const attempts = engine.repositories.paymentAttempt;
    const ordinary = await attempts.getByQuery({ operation: 'create-intent' }, ctx);
    expect(ordinary?.returnProof).toBeUndefined();
    const internal = await attempts.getByQuery({ operation: 'create-intent' }, { ...ctx, select: '+returnProof' });
    expect(internal?.returnProof).toMatchObject({ organizationId: ctx.organizationId });
    expect(internal?.returnProof?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(internal)).not.toContain(token);
    expect(JSON.stringify(transaction)).not.toMatch(/returnProof|server-only-test-return-token/);
    expect(JSON.stringify(await engine.repositories.transaction.listAttempts(String(transaction._id), ctx))).not.toMatch(/returnProof|server-only-test-return-token/);
    expect((await engine.repositories.transaction.confirmReturn(input)).status).toBe('verified');
    expect(provider.lastQueryCommand).toMatchObject({ organizationId: ctx.organizationId,
      merchantReference: transaction.gateway?.metadata?.merchantReference });
    expect(JSON.stringify(published)).not.toMatch(/returnProof|server-only-test-return-token/);
    expect(published.find(event => event.type === 'payment.succeeded')?.meta.organizationId).toBe(ctx.organizationId);
    expect(provider.executes).toBe(1);
  });

  it.each(['token', 'paymentId', 'provider', 'organization'])('rejects forged %s without contacting the provider', async field => {
    await payment();
    const forged = { ...input, ...(field === 'organization' ? {} : { [field]: 'forged' }) };
    await expect(engine.repositories.transaction.confirmReturn(forged, field === 'organization' ? { organizationId: 'other' } : {})).rejects.toMatchObject({ code: 'PAYMENT_RETURN_REJECTED' });
    expect(provider.executes).toBe(0);
    expect(provider.queries).toBe(0);
  });

  it('rejects expired proofs even when the transaction is already paid', async () => {
    await payment();
    await engine.repositories.transaction.confirmReturn(input);
    const attempt = await engine.repositories.paymentAttempt.getByQuery({ operation: 'create-intent' }, ctx);
    if (!attempt) throw new Error('missing create attempt');
    await engine.repositories.paymentAttempt.update(String(attempt._id), { 'returnProof.expiresAt': new Date(0) }, ctx);
    await expect(engine.repositories.transaction.confirmReturn(input)).rejects.toMatchObject({ code: 'PAYMENT_RETURN_REJECTED' });
    expect(provider.executes).toBe(1);
  });

  it.each(['failure', 'cancel'] as const)('does not execute or fail a payment on a signed %s return', async status => {
    await payment();
    expect((await engine.repositories.transaction.confirmReturn({ ...input, status })).status).toBe('pending');
    expect(provider.executes).toBe(0);
    expect(provider.queries).toBe(0);
  });

  it('blocks approval without a creation-time proof', async () => {
    provider.returnToken = undefined;
    await payment();
    await expect(engine.repositories.transaction.confirmReturn(input)).rejects.toMatchObject({ code: 'PAYMENT_RETURN_REJECTED' });
    expect(provider.executes).toBe(0);
  });

  it('deduplicates concurrent returns and queries after an ambiguous execution', async () => {
    await payment();
    provider.loseExecuteResponse = true;
    await expect(engine.repositories.transaction.confirmReturn(input)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    const results = await Promise.all([engine.repositories.transaction.confirmReturn(input), engine.repositories.transaction.confirmReturn(input)]);
    expect(results.every(result => result.status === 'verified')).toBe(true);
    expect(provider.executes).toBe(1);
    expect(published.filter(event => event.type === 'payment.succeeded')).toHaveLength(1);
  });

  it('recovers a missing attempt link from the same scoped creation key', async () => {
    const transaction = await payment();
    const attempt = await engine.repositories.paymentAttempt.getByQuery({ operation: 'create-intent' }, ctx);
    if (!attempt) throw new Error('missing create attempt');
    await engine.repositories.paymentAttempt.update(String(attempt._id), { transactionId: null }, ctx);
    expect((await engine.repositories.transaction.confirmReturn(input))._id).toEqual(transaction._id);
    expect(provider.executes).toBe(1);
  });

  it('leaves a forged premature success unclaimed, then permits genuinely ready execution', async () => {
    const transaction = await payment();
    provider.ready = false;
    expect((await engine.repositories.transaction.confirmReturn(input)).status).toBe('pending');
    expect(await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, { ...ctx, throwOnNotFound: false })).toBeNull();
    expect(provider.executes).toBe(0);
    provider.ready = true;
    expect((await engine.repositories.transaction.confirmReturn(input)).status).toBe('verified');
    expect(provider.executes).toBe(1);
    expect((await engine.repositories.transaction.getById(String(transaction._id), ctx))?.status).toBe('verified');
  });

  it('does not claim execution after a readiness-query outage', async () => {
    await payment();
    provider.queryUnavailable = true;
    await expect(engine.repositories.transaction.confirmReturn(input)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    expect(provider.executes).toBe(0);
    expect(await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, { ...ctx, throwOnNotFound: false })).toBeNull();
    provider.queryUnavailable = false;
    expect((await engine.repositories.transaction.confirmReturn(input)).status).toBe('verified');
    expect(provider.executes).toBe(1);
  });

  it.each(['amount', 'reference'])('does not execute after mismatched readiness %s', async field => {
    await payment();
    provider.wrongAmount = field === 'amount'; provider.wrongReference = field === 'reference';
    await expect(engine.repositories.transaction.confirmReturn(input)).rejects.toBeInstanceOf(ConfirmationOutcomeUnknownError);
    expect(provider.executes).toBe(0);
    expect(await engine.repositories.paymentAttempt.getByQuery({ operation: 'confirm' }, { ...ctx, throwOnNotFound: false })).toBeNull();
  });

  it('rejects a link to another obligation even if its gateway block was copied', async () => {
    const original = await payment();
    const other = await engine.repositories.transaction.createPaymentIntent({ amount: 1999, gateway: 'redirect', methodKind: 'mobile_money', idempotencyKey: 'other-order' }, ctx);
    await engine.repositories.transaction.update(String(other._id), { gateway: original.gateway }, ctx);
    const attempt = await engine.repositories.paymentAttempt.getByQuery({ idempotencyKey: 'order-1' }, ctx);
    if (!attempt) throw new Error('missing creation attempt');
    await engine.repositories.paymentAttempt.update(String(attempt._id), { transactionId: other._id }, ctx);
    await expect(engine.repositories.transaction.confirmReturn(input)).rejects.toMatchObject({ code: 'PAYMENT_RETURN_REJECTED' });
    expect(provider.executes).toBe(0);
  });

  it('cannot bind the same provider return to another tenant', async () => {
    await payment();
    const internal = await engine.repositories.paymentAttempt.getByQuery({ operation: 'create-intent' }, { ...ctx, select: '+returnProof' });
    if (!internal?.returnProof) throw new Error('missing private proof');
    await expect(engine.repositories.paymentAttempt.create({
      provider: 'redirect', operation: 'create-intent', idempotencyKey: 'other-order',
      amount: 1999, currency: 'BDT', outcome: 'pending', returnProof: internal.returnProof,
    }, { organizationId: 'other' })).rejects.toThrow();
    expect((await engine.repositories.transaction.confirmReturn(input)).status).toBe('verified');
  });

  it('refuses to hand out a checkout when private proof persistence fails', async () => {
    const spy = vi.spyOn(engine.repositories.paymentAttempt, 'update').mockRejectedValueOnce(new Error('simulated storage failure'));
    try {
      await expect(payment()).rejects.toBeInstanceOf(IntentOutcomeUnknownError);
      await expect(payment()).rejects.toBeInstanceOf(IntentOutcomeUnknownError);
      expect(provider.creates).toBe(1);
      expect(await engine.repositories.transaction.getByQuery({ idempotencyKey: 'order-1' }, { ...ctx, throwOnNotFound: false })).toBeNull();
    } finally { spy.mockRestore(); }
  });
});
