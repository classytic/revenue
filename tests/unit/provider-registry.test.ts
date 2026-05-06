import { describe, expect, it } from 'vitest';
import { PaymentProvider } from '../../revenue/src/providers/base.js';
import type {
  CreateIntentParams,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';
import { ProviderRegistry, createProviderRegistry } from '../../revenue/src/providers/registry.js';
import { ProviderNotFoundError } from '../../revenue/src/core/errors.js';

class StubProvider extends PaymentProvider {
  public override readonly name = 'stub';
  constructor() { super({}); }
  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? 'USD';
    return { id: 's1', sessionId: 's1', paymentIntentId: 's1', provider: 'stub', status: 'pending', amount: { amount, currency }, metadata: {} };
  }
  async verifyPayment(id: string): Promise<PaymentResult> { return { id, provider: 'stub', status: 'succeeded', metadata: {} }; }
  async getStatus(id: string): Promise<PaymentResult> { return this.verifyPayment(id); }
  async refund(id: string, amt?: number | null): Promise<RefundResult> { return { id, provider: 'stub', status: 'succeeded', amount: { amount: amt ?? 0, currency: 'USD' }, refundedAt: new Date(), metadata: {} }; }
  async handleWebhook(payload: unknown): Promise<WebhookEvent> { return { id: 'wh1', provider: 'stub', type: 'test', data: payload as Record<string, unknown>, createdAt: new Date() }; }
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
  it('createIntent returns a PaymentIntent shape', async () => {
    const p = new StubProvider();
    const intent = await p.createIntent({ amount: { amount: 1000, currency: 'USD' } });
    expect(intent.sessionId).toBe('s1');
    expect(intent.amount).toEqual({ amount: 1000, currency: 'USD' });
  });

  it('verifyPayment returns a PaymentResult shape', async () => {
    const result = await new StubProvider().verifyPayment('s1');
    expect(result.status).toBe('succeeded');
    expect(result.id).toBe('s1');
  });

  it('refund returns a RefundResult shape', async () => {
    const result = await new StubProvider().refund('s1', 500);
    expect(result.status).toBe('succeeded');
    expect(result.amount).toEqual({ amount: 500, currency: 'USD' });
  });

  it('handleWebhook returns a WebhookEvent shape', async () => {
    const result = await new StubProvider().handleWebhook({ type: 'test' });
    expect(result.id).toBe('wh1');
    expect(result.type).toBe('test');
  });

  it('getCapabilities returns capability flags', () => {
    const caps = new StubProvider().getCapabilities();
    expect(caps.supportsRefunds).toBe(true);
    expect(caps.requiresManualVerification).toBe(true);
  });
});
