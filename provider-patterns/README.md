# Payment Provider Patterns

> **Note:** Individual provider implementations have been consolidated into the [Provider Guide](../docs/guides/PROVIDER_GUIDE.md) which has complete TypeScript examples.

## Quick Reference

### Single-Tenant (One Business)

```typescript
import { Revenue } from '@classytic/revenue';
import { StripeProvider } from './providers/stripe';

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('stripe', new StripeProvider({ apiKey: '...' }))
  .build();
```

### Multi-Tenant Marketplace

```typescript
const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('stripe', new StripeConnectProvider({ 
    platformKey: '...',
    clientId: '...',
  }))
  .withCommission(10, 2.9) // 10% platform, 2.9% gateway
  .build();
```

## Building Providers

See **[Provider Guide](../docs/guides/PROVIDER_GUIDE.md)** for:

- Complete TypeScript implementation
- All 5 required methods
- Webhook handling
- Publishing to npm
- Testing strategies

## Decision Guide

| Scenario | Approach |
|----------|----------|
| Single business | Simple provider (Stripe Checkout, SSLCommerz) |
| Marketplace (vendors have Stripe) | Stripe Connect Standard |
| Marketplace (you collect all) | Platform collects + manual payout |
| Manual payments | Use `@classytic/revenue-manual` |

## Resources

- [Provider Guide](../docs/guides/PROVIDER_GUIDE.md) - Build custom providers
- [Manual Provider](../revenue-manual/README.md) - Reference implementation
- [Examples](../revenue/examples/) - Working code
