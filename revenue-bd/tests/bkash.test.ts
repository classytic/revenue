import { describe, expect, it, vi } from 'vitest';
import { money } from '@classytic/primitives/money';
import type { PaymentCommandContext, PaymentProviderPort } from '@classytic/primitives/payment-gateway';
import { BkashProvider, BkashResponseError, createBkashTokenSource } from '../src/bkash/index.js';
import type { BkashTokenRecord, BkashTokenStore } from '../src/bkash/index.js';

const command: PaymentCommandContext = { idempotencyKey: 'payment-command-1', requestId: 'request-1', merchantReference: 'order-123' };
const completed = { paymentId: 'payment-1', transactionStatus: 'Completed', amount: '19.99', currency: 'BDT',
  merchantInvoiceNumber: 'order-123', trxId: 'charge-1', intent: 'sale', maxRefundableAmount: '19.99' };
const initiated = { ...completed, signature: 'test-return-signature', transactionStatus: 'Initiated', bkashURL: 'https://sandbox.payment.bkash.com/?paymentId=payment-1' };
const ready = { ...initiated, verificationStatus: 'Complete' };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function setup(rows: unknown[] = []) {
  const requests: { url: string; body: Record<string, unknown>; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), init });
    return response(rows.shift());
  });
  const provider = new BkashProvider({ appKey: 'test-app-key', tokens: { getAccessToken: async () => 'test-token' }, callbackUrl: 'http://localhost:5140/return', fetch: fetcher });
  const port: PaymentProviderPort = provider;
  return { provider, port, requests, fetcher };
}

describe('bKash v2 contract and money safety', () => {
  it('creates a BDT hosted checkout with an exact decimal and explicit correlation', async () => {
    const { provider, requests } = setup([initiated]);
    const intent = await provider.createIntent({ amount: money(1999, 'BDT') }, command);
    expect(intent).toMatchObject({ id: 'payment-1', amount: money(1999, 'BDT'), status: 'requires_action' });
    expect(intent.returnProof).toEqual({ token: 'test-return-signature', validForMs: 86400000 });
    expect(intent.metadata).toBeUndefined();
    expect(intent.raw).toBeUndefined();
    expect(requests[0]?.body).toMatchObject({ amount: '19.99', merchantInvoiceNumber: 'order-123', intent: 'sale' });
    expect(requests[0]?.init?.redirect).toBe('error');
    expect(provider.getCapabilities()).toMatchObject({ supportsConfirmation: true, supportsIdempotentCreate: false, supportsWebhooks: false });
  });

  it('does not lose a paisa near the safe-integer limit', async () => {
    const { provider, requests } = setup([{ ...initiated, amount: '90071992547409.91' }]);
    await provider.createIntent({ amount: money(Number.MAX_SAFE_INTEGER, 'BDT') }, command);
    expect(requests[0]?.body.amount).toBe('90071992547409.91');
  });

  it.each([0, -100, 1.2, Number.NaN])('rejects invalid charge %s before network I/O', async amount => {
    const { provider, requests } = setup();
    await expect(provider.createIntent({ amount: { amount, currency: money(1, 'BDT').currency } }, command)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('rejects unsupported currency before I/O', async () => {
    const { provider, requests } = setup();
    await expect(provider.createIntent({ amount: money(1999, 'USD') }, command)).rejects.toThrow('BDT');
    expect(requests).toHaveLength(0);
  });

  it.each([
    { ...initiated, merchantInvoiceNumber: 'other-order' },
    { ...initiated, amount: '20.00' },
    { ...initiated, bkashURL: 'https://attacker.invalid/pay' },
    { ...initiated, currency: 'USD' },
    { ...initiated, signature: '' },
    { ...initiated, signature: undefined },
  ])('rejects mismatched checkout responses', async row => {
    const { provider } = setup([row]);
    await expect(provider.createIntent({ amount: money(1999, 'BDT') }, command)).rejects.toThrow();
  });

  it('keeps verify and status read-only; only confirm executes', async () => {
    const { provider, requests } = setup([completed, initiated, ready, completed]);
    expect((await provider.verifyPayment('payment-1')).status).toBe('succeeded');
    expect((await provider.getStatus('payment-1')).status).toBe('requires_action');
    await provider.confirmPayment('payment-1', command);
    expect(requests.map(item => new URL(item.url).pathname)).toEqual([
      '/v2/tokenized-checkout/query/payment', '/v2/tokenized-checkout/query/payment', '/v2/tokenized-checkout/query/payment', '/v2/tokenized-checkout/payment/execute',
    ]);
  });

  it('does not retry execute after a lost response or expose vendor errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(ready)).mockRejectedValue(new Error('network token=SECRET payer=PRIVATE'));
    const provider = new BkashProvider({ appKey: 'key', tokens: { getAccessToken: async () => 'SECRET' }, callbackUrl: 'https://shop.invalid/return', fetch: fetcher });
    const error = await provider.confirmPayment('payment-1', command).catch(value => value);
    expect(error).toBeInstanceOf(BkashResponseError);
    expect(String(error)).not.toMatch(/SECRET|PRIVATE/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves aborts rather than turning them into a declined payment', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher: typeof fetch = vi.fn(async (_url, init) => { init?.signal?.throwIfAborted(); return response(completed); });
    const provider = new BkashProvider({ appKey: 'key', tokens: { getAccessToken: async () => 'token' }, callbackUrl: 'https://shop.invalid/return', fetch: fetcher });
    await expect(provider.confirmPayment('payment-1', { ...command, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('redacts token-store failures and caller-provided abort reasons', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new BkashProvider({ appKey: 'key', tokens: { getAccessToken: async () => { throw new Error('password=SECRET'); } }, callbackUrl: 'https://shop.invalid/return', fetch: fetcher });
    const error = await provider.confirmPayment('payment-1', command).catch(value => value);
    expect(String(error)).not.toContain('SECRET');
    const controller = new AbortController();
    controller.abort(new Error('password=SECRET'));
    const abort = await provider.confirmPayment('payment-1', { ...command, signal: controller.signal }).catch(value => value);
    expect(abort).toMatchObject({ name: 'AbortError' });
    expect(String(abort)).not.toContain('SECRET');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies documented insufficient funds only on execution, not on status queries', async () => {
    const { provider } = setup([ready, { externalCode: '2023', errorMessageEn: 'SECRET' }, { externalCode: '2023', errorMessageEn: 'SECRET' }]);
    await expect(provider.confirmPayment('payment-1', command)).rejects.toMatchObject({ decline: { reason: 'insufficient_funds' } });
    const queryError = await provider.getStatus('payment-1').catch(value => value);
    expect(queryError).toBeInstanceOf(BkashResponseError);
    expect(queryError).not.toHaveProperty('decline');
    expect(String(queryError)).not.toContain('SECRET');
  });

  it('does not execute before the provider confirms approval', async () => {
    const { provider, requests } = setup([{ ...initiated, verificationStatus: 'Incomplete' }]);
    await expect(provider.confirmPayment('payment-1', command)).rejects.toMatchObject({ name: 'ProviderStatusUnavailableError' });
    expect(requests.map(request => request.url)).toEqual([expect.stringContaining('/query/payment')]);
  });

  it('observes an already completed payment without executing again', async () => {
    const { provider, requests } = setup([completed]);
    expect((await provider.confirmPayment('payment-1', command)).status).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/query/payment');
  });

  it('does not mistake a readiness-query error for an execution decline', async () => {
    const { provider, requests } = setup([{ externalCode: '2023', errorMessageEn: 'PRIVATE' }]);
    const error = await provider.confirmPayment('payment-1', command).catch(value => value);
    expect(error).not.toHaveProperty('decline');
    expect(requests).toHaveLength(1);
  });

  it('refunds only within the provider-reported coupon-adjusted limit', async () => {
    const { provider, requests } = setup([{ ...completed, maxRefundableAmount: '15.00' }]);
    await expect(provider.refund('payment-1', 1600, command)).rejects.toThrow('refundable');
    expect(requests).toHaveLength(1);
  });

  it('correlates refund results with the original charge and exact amount', async () => {
    const { provider, requests } = setup([completed, { originalTrxId: 'charge-1', refundTrxId: 'refund-1', refundTransactionStatus: 'Completed', refundAmount: '4.50', currency: 'BDT' }]);
    expect(await provider.refund('payment-1', 450, command)).toMatchObject({ id: 'refund-1', amount: money(450, 'BDT') });
    expect(requests[1]?.body).toMatchObject({ paymentId: 'payment-1', trxId: 'charge-1', refundAmount: '4.50' });
  });

  it('refuses to guess which refund succeeded when no refund reference survived', async () => {
    const { provider, requests } = setup();
    await expect(provider.getRefundStatus({ paymentId: 'payment-1', idempotencyKey: 'refund-command' })).rejects.toMatchObject({ name: 'ProviderStatusUnavailableError' });
    expect(requests).toHaveLength(0);
  });

  it('resolves only the exact refund reference from the refund history', async () => {
    const { provider } = setup([completed, { originalTrxId: 'charge-1', refundTransactions: [
      { refundTrxId: 'other-refund', refundTransactionStatus: 'Completed', refundAmount: '1.00' },
      { refundTrxId: 'refund-1', refundTransactionStatus: 'Completed', refundAmount: '4.50' },
    ] }]);
    expect(await provider.getRefundStatus({ paymentId: 'payment-1', idempotencyKey: 'cmd', refundRef: 'refund-1' })).toMatchObject({ id: 'refund-1', amount: money(450, 'BDT'), status: 'succeeded' });
  });

  it('does not accept arbitrary webhook payloads', async () => {
    const { provider } = setup();
    expect(provider.verifyWebhookSignature()).toBe(false);
    await expect(provider.handleWebhook()).rejects.toThrow('browser return');
  });

  it('rejects credential-bearing or non-v2 API destinations', () => {
    expect(() => new BkashProvider({ appKey: 'key', tokens: { getAccessToken: async () => 'x' }, callbackUrl: 'https://shop.invalid', baseUrl: 'https://attacker.invalid/v2/tokenized-checkout' })).toThrow();
  });
});

describe('bKash token lifecycle', () => {
  it('coordinates grants and refreshes through the supplied token store', async () => {
    let value: BkashTokenRecord | null = null;
    let queue = Promise.resolve();
    let now = 1_000_000;
    const store: BkashTokenStore = {
      get: async () => value,
      set: async next => { value = next; },
      exclusive: async run => {
        const previous = queue;
        let release = () => {};
        queue = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await run(); } finally { release(); }
      },
    };
    const urls: string[] = [];
    const fetcher: typeof fetch = vi.fn(async url => {
      urls.push(String(url));
      return response({ statusCode: '0000', id_token: `token-${urls.length}`, refresh_token: 'refresh-1', expires_in: 3600 });
    });
    const source = createBkashTokenSource({ username: 'user', password: 'password', appKey: 'app', appSecret: 'secret', store, fetch: fetcher, now: () => now });
    expect(await Promise.all([source.getAccessToken(), source.getAccessToken()])).toEqual(['token-1', 'token-1']);
    expect(urls).toHaveLength(1);
    now += 3_400_000;
    expect(await source.getAccessToken()).toBe('token-2');
    expect(urls[1]).toContain('/auth/refresh-token');
  });
});
