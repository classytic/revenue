import type { PaymentProviderPort } from '@classytic/primitives/payment-gateway';
import { ProviderNotFoundError } from '../core/errors.js';

/**
 * The registry stores the PORT, not this package's `PaymentProvider` class.
 *
 * That distinction is the whole point of moving the contract to primitives: an adapter can
 * be written against `@classytic/primitives/payment-gateway` alone and still register here.
 * While this file named the class, the boundary was declared but not enforced — every
 * adapter still had to import a runtime value from the engine.
 *
 * `PaymentProvider` still satisfies this, because it `implements PaymentProviderPort`.
 */

export class ProviderRegistry {
  private providers = new Map<string, PaymentProviderPort>();

  /**
   * Register a provider under `name`.
   *
   * A duplicate name THROWS. It used to be a bare `Map.set`, so registering twice silently
   * replaced a live provider — and the loser was whichever composition ran first, with no
   * error, no log, and a payment path quietly pointing somewhere else. On a money seam that
   * is the worst possible failure shape.
   *
   * Replacement must be asked for explicitly. `{ replace: true }` is for a host deliberately
   * overriding a default (a test double, a country pack superseding a generic entry) — which
   * is a legitimate need, just never an accidental one.
   */
  register(name: string, provider: PaymentProviderPort, options?: { replace?: boolean }): void {
    if (this.providers.has(name) && options?.replace !== true) {
      throw new Error(
        `[revenue] a payment provider named "${name}" is already registered. ` +
          'Two providers under one name means one of them silently never runs. ' +
          'Use a distinct name, or pass { replace: true } if the override is deliberate.',
      );
    }
    this.providers.set(name, provider);
  }

  get(name: string): PaymentProviderPort {
    const provider = this.providers.get(name);
    if (!provider) throw new ProviderNotFoundError(name);
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Push the engine's default currency into providers that accept one.
   *
   * Feature-detected rather than required: `setDefaultCurrency` is NOT part of
   * `PaymentProviderPort`. A default currency is engine configuration, and requiring a
   * mutator for it would make every adapter stateful and awkward to share across accounts.
   * Adapters that want the convenience expose it; the rest read the currency off the `Money`
   * they are handed, which carries it already.
   */
  setDefaultCurrency(currency: string): void {
    for (const provider of this.providers.values()) {
      (provider as { setDefaultCurrency?: (c: string) => void }).setDefaultCurrency?.(currency);
    }
  }
}

export function createProviderRegistry(
  providers: Record<string, PaymentProviderPort> = {},
  defaultCurrency?: string,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const [name, provider] of Object.entries(providers)) {
    if (defaultCurrency) {
      (provider as { setDefaultCurrency?: (c: string) => void }).setDefaultCurrency?.(
        defaultCurrency,
      );
    }
    /**
     * `replace: true` — a Record cannot hold duplicate keys, so nothing here can collide.
     * The guard exists for repeated `register()` calls across composition, which is where
     * the silent-overwrite bug lived. Aliases pointing several names at ONE provider
     * instance (a country pack's manual methods) are legitimate and must keep working.
     */
    registry.register(name, provider, { replace: true });
  }
  return registry;
}
