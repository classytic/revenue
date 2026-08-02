/**
 * The provider registry's duplicate rule.
 *
 * `register()` was a bare `Map.set`, so registering two providers under one name silently
 * replaced the first. Nothing threw, nothing logged, and a payment path pointed somewhere
 * its author never intended — the worst failure shape available on a money seam, because
 * the system keeps working and simply routes money differently.
 *
 * Composition order decided the winner, which meant the bug was also non-deterministic
 * across hosts.
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../src/providers/registry.js';
import { PaymentProvider } from '../src/providers/base.js';

class Stub extends PaymentProvider {
  constructor(public readonly tag: string) {
    super();
  }
  async createIntent(): Promise<never> {
    throw new Error('not used');
  }
  async verifyPayment(): Promise<never> {
    throw new Error('not used');
  }
  async getStatus(): Promise<never> {
    throw new Error('not used');
  }
  async refund(): Promise<never> {
    throw new Error('not used');
  }
  async handleWebhook(): Promise<never> {
    throw new Error('not used');
  }
}

describe('ProviderRegistry.register', () => {
  it('registers and resolves a provider', () => {
    const registry = new ProviderRegistry();
    const provider = new Stub('a');
    registry.register('bkash', provider);

    expect(registry.get('bkash')).toBe(provider);
    expect(registry.has('bkash')).toBe(true);
  });

  it('THROWS on a duplicate name rather than silently replacing', () => {
    const registry = new ProviderRegistry();
    const first = new Stub('first');
    registry.register('bkash', first);

    expect(() => registry.register('bkash', new Stub('second'))).toThrow(/already registered/);
    // …and the original is still the one that serves payments.
    expect((registry.get('bkash') as Stub).tag).toBe('first');
  });

  it('allows a DELIBERATE override with { replace: true }', () => {
    // A host superseding a default — a test double, or a country pack replacing a generic
    // entry. Legitimate; just never accidental.
    const registry = new ProviderRegistry();
    registry.register('bkash', new Stub('default'));
    registry.register('bkash', new Stub('override'), { replace: true });

    expect((registry.get('bkash') as Stub).tag).toBe('override');
  });

  it('names the collision in the error, so the fix is obvious from the message', () => {
    const registry = new ProviderRegistry();
    registry.register('nagad', new Stub('a'));

    expect(() => registry.register('nagad', new Stub('b'))).toThrow(/"nagad"/);
  });
});
