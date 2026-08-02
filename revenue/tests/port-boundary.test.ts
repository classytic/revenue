/**
 * ARCHITECTURE TEST: an adapter that depends ONLY on primitives can register with Revenue.
 *
 * This is the property phase 1 claimed and did not initially have. The port lived in
 * primitives, but the registry's signature still named this package's `PaymentProvider`
 * class — so every adapter had to import a runtime value from the engine, and the boundary
 * was decorative.
 *
 * The provider below imports NOTHING from `@classytic/revenue`. If someone re-narrows the
 * registry to the class, this file stops compiling — which is the only durable way to keep
 * a dependency boundary honest.
 */
import { describe, expect, it } from 'vitest';
import type {
  CreateIntentParams,
  PaymentCommandContext,
  PaymentProviderPort,
  PaymentResult,
  ProviderCapabilities,
  ProviderIntent,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';
import { ProviderRegistry } from '../src/providers/registry.js';

/** A complete provider written against the PORT alone — no engine import anywhere. */
class PrimitivesOnlyProvider implements PaymentProviderPort {
  readonly name = 'primitives-only';

  async createIntent(
    params: CreateIntentParams,
    _command: PaymentCommandContext,
  ): Promise<ProviderIntent> {
    return {
      id: 'intent-1',
      provider: this.name,
      status: 'requires_confirmation',
      amount: params.amount,
    };
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    return { id: intentId, provider: this.name, status: 'succeeded' };
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return { id: intentId, provider: this.name, status: 'processing' };
  }

  async refund(
    _paymentId: string,
    _amount: number | null | undefined,
    _command: PaymentCommandContext,
    _options?: { reason?: string },
  ): Promise<RefundResult> {
    return { id: 'refund-1', provider: this.name, status: 'succeeded' };
  }

  async handleWebhook(): Promise<WebhookEvent> {
    return { id: 'evt-1', provider: this.name, type: 'unknown', raw: {} };
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: false,
      requiresManualVerification: false,
    };
  }
}

describe('provider port boundary', () => {
  it('registers an adapter that imports nothing from the engine', () => {
    const registry = new ProviderRegistry();
    const provider = new PrimitivesOnlyProvider();

    registry.register('primitives-only', provider);

    expect(registry.get('primitives-only')).toBe(provider);
  });

  it('does NOT require setDefaultCurrency — that is engine config, not the contract', () => {
    // The provider above has no such method. `setDefaultCurrency` must feature-detect, or a
    // conforming adapter crashes the moment the engine sets its default currency.
    const registry = new ProviderRegistry();
    registry.register('primitives-only', new PrimitivesOnlyProvider());

    expect(() => registry.setDefaultCurrency('BDT')).not.toThrow();
  });

  it('still accepts an adapter that DOES expose setDefaultCurrency', () => {
    const calls: string[] = [];
    const provider = Object.assign(new PrimitivesOnlyProvider(), {
      setDefaultCurrency: (c: string) => calls.push(c),
    });

    const registry = new ProviderRegistry();
    registry.register('legacy-style', provider);
    registry.setDefaultCurrency('BDT');

    expect(calls).toEqual(['BDT']);
  });
});
