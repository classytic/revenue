import { describe, expect, it } from 'vitest';
import {
  PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent,
  type CreateIntentParams,
} from '../../revenue/src/providers/base.js';
import { ProviderRegistry, createProviderRegistry } from '../../revenue/src/providers/registry.js';
import { ProviderNotFoundError } from '../../revenue/src/core/errors.js';

class StubProvider extends PaymentProvider {
  public override readonly name = 'stub';
  constructor() { super({}); }
  async createIntent(params: CreateIntentParams) {
    return new PaymentIntent({ id: 's1', sessionId: 's1', paymentIntentId: 's1', provider: 'stub', status: 'pending', amount: params.amount, currency: params.currency, metadata: {} });
  }
  async verifyPayment(id: string) { return new PaymentResult({ id, provider: 'stub', status: 'succeeded', metadata: {} }); }
  async getStatus(id: string) { return this.verifyPayment(id); }
  async refund(id: string, amt?: number | null) { return new RefundResult({ id, provider: 'stub', status: 'succeeded', amount: amt ?? 0, refundedAt: new Date(), metadata: {} }); }
  async handleWebhook(payload: unknown) { return new WebhookEvent({ id: 'wh1', provider: 'stub', type: 'test', data: payload as Record<string, unknown>, createdAt: new Date() }); }
  override getCapabilities() { return { supportsWebhooks: false, supportsRefunds: true, supportsPartialRefunds: false, requiresManualVerification: true }; }
}

describe('ProviderRegistry', () => {
  it('register + get', () => {
    const reg = new ProviderRegistry();
    reg.register('stub', new StubProvider());
    expect(reg.get('stub')).toBeInstanceOf(PaymentProvider);
  });

  it('get throws ProviderNotFoundError for unknown', () => {
    const reg = new ProviderRegistry();
    expect(() => reg.get('nope')).toThrow(ProviderNotFoundError);
  });

  it('has returns true/false', () => {
    const reg = new ProviderRegistry();
    reg.register('stub', new StubProvider());
    expect(reg.has('stub')).toBe(true);
    expect(reg.has('nope')).toBe(false);
  });

  it('list returns registered names', () => {
    const reg = new ProviderRegistry();
    reg.register('a', new StubProvider());
    reg.register('b', new StubProvider());
    expect(reg.list()).toEqual(['a', 'b']);
  });

  it('setDefaultCurrency propagates to all providers', () => {
    const p = new StubProvider();
    const reg = new ProviderRegistry();
    reg.register('stub', p);
    reg.setDefaultCurrency('BDT');
    expect((p as any).defaultCurrency).toBe('BDT');
  });
});

describe('createProviderRegistry', () => {
  it('creates from config object', () => {
    const reg = createProviderRegistry({ stub: new StubProvider() }, 'EUR');
    expect(reg.has('stub')).toBe(true);
    expect(reg.list()).toEqual(['stub']);
  });

  it('creates empty registry from no args', () => {
    const reg = createProviderRegistry();
    expect(reg.list()).toEqual([]);
  });
});

describe('PaymentProvider contract', () => {
  it('createIntent returns PaymentIntent', async () => {
    const p = new StubProvider();
    const intent = await p.createIntent({ amount: 1000, currency: 'USD' });
    expect(intent).toBeInstanceOf(PaymentIntent);
    expect(intent.sessionId).toBe('s1');
  });

  it('verifyPayment returns PaymentResult', async () => {
    const result = await new StubProvider().verifyPayment('s1');
    expect(result).toBeInstanceOf(PaymentResult);
    expect(result.status).toBe('succeeded');
  });

  it('refund returns RefundResult', async () => {
    const result = await new StubProvider().refund('s1', 500);
    expect(result).toBeInstanceOf(RefundResult);
  });

  it('handleWebhook returns WebhookEvent', async () => {
    const result = await new StubProvider().handleWebhook({ type: 'test' });
    expect(result).toBeInstanceOf(WebhookEvent);
  });

  it('getCapabilities returns capability flags', () => {
    const caps = new StubProvider().getCapabilities();
    expect(caps.supportsRefunds).toBe(true);
    expect(caps.requiresManualVerification).toBe(true);
  });
});
