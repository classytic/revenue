# @classytic/revenue

> Modern, Type-safe Revenue Management for Node.js

Enterprise-grade payment processing with subscriptions, escrow, splits, and multi-provider support - core package + pluggable providers.

## Features

- **Fluent Builder API** - Chain configuration with IntelliSense
- **Type-safe Events** - Strongly typed pub/sub system
- **Result Type** - Rust-inspired error handling (no throws)
- **Money Utility** - Integer-safe currency calculations
- **Idempotency** - Built-in duplicate request protection
- **Retry + Circuit Breaker** - Resilient operations
- **Plugin System** - Composable middleware (logging, audit, metrics)
- **Zod Validation** - Runtime schema validation
- **ESM + TypeScript** - Modern stack, full type definitions

---

## Quick Start

```bash
npm install @classytic/revenue @classytic/revenue-manual mongoose
```

```typescript
import { Revenue, Money, gatewaySchema, commissionSchema } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import { Transaction } from './models/transaction';

// Build with fluent API - only Transaction model is required!
const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('manual', new ManualProvider())
  .withCommission(10, 2.9) // 10% platform, 2.9% gateway fee
  .withCategoryMappings({
    PlatformSubscription: 'platform_subscription',
    ProductOrder: 'product_order',
  })
  .build();

// Create subscription payment
const { transaction } = await revenue.monetization.create({
  data: {
    customerId: user._id,
    organizationId: org._id,
    referenceId: subscriptionId,
    referenceModel: 'Subscription',
  },
  planKey: 'monthly',
  monetizationType: 'subscription',
  entity: 'PlatformSubscription',
  amount: 2999,
  gateway: 'manual',
});

// Verify payment
await revenue.payments.verify(transaction._id);

// Listen to events
revenue.on('payment.succeeded', (event) => {
  console.log('Payment verified:', event.transactionId);
});
```

### One Model, Many Use Cases

The Transaction model is your **universal financial ledger**:

| Use Case | Category | Type |
|----------|----------|------|
| Subscriptions | `platform_subscription` | `income` |
| One-time purchases | `product_order` | `income` |
| Course enrollments | `course_enrollment` | `income` |
| Refunds | `refund` | `expense` |
| Operational expenses | `rent`, `salary`, etc. | `expense` |

---

## Package Structure

```
@classytic/revenue          # Core library
@classytic/revenue-manual   # Manual payment provider (cash, bank transfer)
```

---

## Documentation

| Resource | Description |
|----------|-------------|
| [Core Package](./revenue/README.md) | Full API reference & examples |
| [Manual Provider](./revenue-manual/README.md) | Manual payment verification |
| [Provider Guide](./docs/guides/PROVIDER_GUIDE.md) | Build custom providers |
| [Escrow Features](./docs/guides/ESCROW_FEATURES.md) | Hold/release & splits |

---

## Architecture

```
Revenue.create()
    ├── Models (Transaction, Subscription)
    ├── Providers (manual, stripe, etc.)
    ├── Plugins (logging, audit, metrics)
    └── Services
        ├── monetization  → create, activate, renew, cancel
        ├── payments      → verify, refund, webhook
        ├── transactions  → get, list, update
        └── escrow        → hold, release, split
```

---

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests (75 tests including integration)
npm test

# Type check
npm run typecheck
```

---

## Publishing

```bash
npm run publish:revenue        # Publish core
npm run publish:revenue-manual # Publish manual provider
npm run publish:all            # Publish both
```

---

## Links

- **GitHub**: https://github.com/classytic/revenue
- **npm**: https://npmjs.com/package/@classytic/revenue
- **Issues**: https://github.com/classytic/revenue/issues

---

**Built with ❤️ by Classytic**
