import { createHash } from 'node:crypto';
import { ProviderStatusUnavailableError } from '@classytic/primitives/payment-gateway';
import type {
  PaymentProviderPort, PaymentCommandContext, CreateIntentParams, ProviderIntent, PaymentResult,
  RefundResult, RefundStatusQuery, WebhookEvent, ProviderCapabilities,
  PaymentDecline,
} from '@classytic/primitives/payment-gateway';
import { ENDPOINTS, BKASH_CAPABILITIES } from './constants.js';
import { baseUrl, BkashResponseError, interrupted, object, post, signalFor, text } from './client.js';
import { amountOf, decimalOf, paymentOf } from './status.js';
import type { BkashProviderConfig } from './types.js';

function reference(value: string): string {
  if (!value.trim() || value.length > 255 || /[<>&\r\n]/.test(value)) throw new Error('Invalid bKash merchant reference.');
  return value;
}

class BkashPaymentDeclinedError extends Error {
  readonly decline: PaymentDecline = { reason: 'insufficient_funds', providerCode: '2023', retryable: true };
  constructor() { super('bKash declined the payment: insufficient funds.'); this.name = 'BkashPaymentDeclinedError'; }
}

/** Tokenized checkout v2 without agreement. Execution is a command; verification only queries. */
export class BkashProvider implements PaymentProviderPort {
  readonly name = 'bkash';
  private readonly endpoint: string;
  private readonly callback: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: BkashProviderConfig) {
    this.endpoint = baseUrl(config.baseUrl);
    this.fetcher = config.fetch ?? fetch;
    const callback = new URL(config.callbackUrl);
    if (callback.username || callback.password || callback.hash || (callback.protocol !== 'https:'
      && !(this.endpoint.includes('.sandbox.') && callback.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(callback.hostname)))) throw new Error('Invalid bKash callback URL.');
    if (!config.appKey.trim()) throw new Error('bKash app key is required.');
    this.callback = callback.toString();
  }

  private async request(path: string, body: Record<string, unknown>, command?: PaymentCommandContext) {
    const signal = signalFor(this.config.timeoutMs, command?.signal);
    let token: string;
    try { token = await this.config.tokens.getAccessToken(signal); } catch {
      if (signal.aborted) throw interrupted(signal);
      throw new BkashResponseError('http_error');
    }
    if (!token.trim()) throw new Error('bKash token is unavailable.');
    return post(this.fetcher, this.endpoint + path, body, { Authorization: token, 'X-App-Key': this.config.appKey }, signal);
  }

  async createIntent(params: CreateIntentParams, command: PaymentCommandContext): Promise<ProviderIntent> {
    if (params.amount.currency !== 'BDT') throw new Error('bKash checkout accepts BDT only.');
    const amount = decimalOf(params.amount.amount);
    const invoice = reference(command.merchantReference);
    const row = await this.request(ENDPOINTS.create, {
      payerReference: invoice, callbackURL: this.callback, amount, currency: 'BDT', intent: 'sale', merchantInvoiceNumber: invoice,
    }, command);
    const id = text(row, 'paymentId');
    const result = paymentOf(row, id);
    if (result.merchantReference !== invoice || result.amount?.amount !== params.amount.amount || row.intent !== 'sale') throw new BkashResponseError('correlation_mismatch');
    const redirect = new URL(text(row, 'bkashURL'));
    const host = this.endpoint.includes('.sandbox.') ? 'sandbox.payment.bkash.com' : 'payment.bkash.com';
    if (redirect.protocol !== 'https:' || redirect.hostname !== host || redirect.port || redirect.username || redirect.password) throw new BkashResponseError('invalid_response');
    return {
      id, provider: this.name, sessionId: id, paymentIntentId: id,
      status: 'requires_action', amount: params.amount, paymentUrl: redirect.toString(), methodKind: 'mobile_money',
      returnProof: { token: text(row, 'signature'), validForMs: 24 * 60 * 60 * 1000 },
    };
  }

  async confirmPayment(id: string, command: PaymentCommandContext): Promise<PaymentResult> {
    // The shared callback token does not authenticate its success/cancel status string.
    const observation = await this.getStatus(id, command);
    if (observation.merchantReference !== command.merchantReference) throw new BkashResponseError('correlation_mismatch');
    if (observation.status === 'succeeded') return observation;
    if (observation.confirmationReady !== true) throw new ProviderStatusUnavailableError(this.name);
    try {
      const result = paymentOf(await this.request(ENDPOINTS.execute, { paymentId: reference(id) }, command), id);
      if (result.merchantReference !== command.merchantReference) throw new BkashResponseError('correlation_mismatch');
      return result;
    } catch (error) {
      // Map only a documented execution decision. Query/auth/ambiguous errors cannot prove a decline.
      if (error instanceof BkashResponseError && error.providerCode === '2023') throw new BkashPaymentDeclinedError();
      throw error;
    }
  }

  async verifyPayment(id: string, command?: PaymentCommandContext): Promise<PaymentResult> {
    return this.getStatus(id, command);
  }

  async getStatus(id: string, command?: PaymentCommandContext): Promise<PaymentResult> {
    return paymentOf(await this.request(ENDPOINTS.query, { paymentId: reference(id) }, command), id);
  }

  async refund(id: string, amount: number | null | undefined, command: PaymentCommandContext, options?: { reason?: string }): Promise<RefundResult> {
    // Inspect the original payment and coupon-adjusted limit; never infer a reversal from payment success.
    const payment = await this.request(ENDPOINTS.query, { paymentId: reference(id) }, command);
    if (paymentOf(payment, id).status !== 'succeeded') throw new Error('bKash payment is not completed.');
    const maximum = amountOf(payment, 'maxRefundableAmount');
    const refundAmount = amount ?? maximum.amount;
    const decimal = decimalOf(refundAmount);
    if (refundAmount > maximum.amount) throw new Error('bKash refund exceeds the refundable amount.');
    const original = text(payment, 'trxId');
    const row = await this.request(ENDPOINTS.refund, {
      paymentId: id, trxId: original, refundAmount: decimal,
      sku: createHash('sha256').update(command.idempotencyKey).digest('hex'),
      reason: reference(options?.reason ?? 'Customer refund'),
    }, command);
    if (text(row, 'originalTrxId') !== original || amountOf(row, 'refundAmount').amount !== refundAmount || row.refundTransactionStatus !== 'Completed') throw new BkashResponseError('correlation_mismatch');
    return { id: text(row, 'refundTrxId'), provider: this.name, status: 'succeeded', amount: amountOf(row, 'refundAmount') };
  }

  async getRefundStatus(query: RefundStatusQuery, command?: PaymentCommandContext): Promise<PaymentResult> {
    // The v2 status list has no documented command/SKU correlation. Amount/time matching is unsafe.
    if (!query.refundRef) throw new ProviderStatusUnavailableError(this.name);
    const payment = await this.request(ENDPOINTS.query, { paymentId: reference(query.paymentId) }, command);
    if (paymentOf(payment, query.paymentId).status !== 'succeeded') throw new ProviderStatusUnavailableError(this.name);
    const row = await this.request(ENDPOINTS.refundStatus, { paymentId: query.paymentId, trxId: text(payment, 'trxId') }, command);
    if (row.originalTrxId !== payment.trxId || !Array.isArray(row.refundTransactions)) throw new BkashResponseError('invalid_response');
    const match = row.refundTransactions.map(object).find(item => item.refundTrxId === query.refundRef);
    if (!match || match.refundTransactionStatus !== 'Completed') throw new ProviderStatusUnavailableError(this.name);
    return { id: query.refundRef, provider: this.name, status: 'succeeded', amount: amountOf({ ...match, currency: 'BDT' }, 'refundAmount') };
  }

  async handleWebhook(): Promise<WebhookEvent> { throw new Error('bKash checkout v2 uses a browser return, not this webhook transport.'); }
  verifyWebhookSignature(): boolean { return false; }
  getCapabilities(): ProviderCapabilities {
    return { ...BKASH_CAPABILITIES };
  }
}
