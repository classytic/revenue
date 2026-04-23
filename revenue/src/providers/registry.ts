import { PaymentProvider } from './base.js';
import { ProviderNotFoundError } from '../core/errors.js';

export class ProviderRegistry {
  private providers = new Map<string, PaymentProvider>();

  register(name: string, provider: PaymentProvider): void {
    this.providers.set(name, provider);
  }

  get(name: string): PaymentProvider {
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

  setDefaultCurrency(currency: string): void {
    for (const provider of this.providers.values()) {
      provider.setDefaultCurrency(currency);
    }
  }
}

export function createProviderRegistry(
  providers: Record<string, PaymentProvider> = {},
  defaultCurrency?: string,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const [name, provider] of Object.entries(providers)) {
    if (defaultCurrency) provider.setDefaultCurrency(defaultCurrency);
    registry.register(name, provider);
  }
  return registry;
}
