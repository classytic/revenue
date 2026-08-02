/**
 * Adapter-local base for the Stripe providers.
 *
 * Replaces `extends PaymentProvider` from `@classytic/revenue`. That import was a RUNTIME
 * dependency on the engine — a class, not a type — so this package could not be versioned
 * or installed independently of it, and the dependency pointed adapter → engine while the
 * engine also registers adapters.
 *
 * The contract now comes from `@classytic/primitives/payment-gateway`. All the base ever
 * supplied was config capture and a default-currency holder, which is nine lines, so a
 * local copy is cheaper than the coupling. `setDefaultCurrency` is kept as an OPT-IN
 * convenience (`DefaultCurrencyAware`) — the registry feature-detects it and the port does
 * not require it.
 */
import type {
  DefaultCurrencyAware,
  PaymentProviderPort,
} from '@classytic/primitives/payment-gateway';

export abstract class StripeProviderBase implements DefaultCurrencyAware {
  public readonly config: Record<string, unknown>;
  public abstract readonly name: string;
  private _defaultCurrency = 'USD';

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
    if (typeof config.defaultCurrency === 'string') {
      this._defaultCurrency = config.defaultCurrency;
    }
  }

  get defaultCurrency(): string {
    return this._defaultCurrency;
  }

  setDefaultCurrency(currency: string): void {
    this._defaultCurrency = currency;
  }

  /**
   * Default: reject nothing. Overridden by every provider here with real HMAC verification —
   * this exists only so a subclass that genuinely has no webhook transport need not declare it.
   */
  verifyWebhookSignature(_payload: unknown, _signature: string): boolean {
    return true;
  }
}

/** Compile-time proof a concrete subclass satisfies the port. */
export type AssertStripeProvider<T extends PaymentProviderPort> = T;
