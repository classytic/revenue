# @classytic/revenue Documentation

Modern, type-safe revenue management system for subscriptions and payments.

## 📦 Packages

### [@classytic/revenue](../revenue/README.md)
Core library providing subscription management, payment processing, and transaction tracking.

**Install:** `npm install @classytic/revenue`

### [@classytic/revenue-manual](../revenue-manual/README.md)
Manual payment provider for cash, bank transfers, mobile money without API.

**Install:** `npm install @classytic/revenue-manual`

## 🚀 Quick Start

```typescript
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

// ONE Transaction model = Universal Financial Ledger
const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('manual', new ManualProvider())
  .withCommission(10, 2.9)
  .build();

// Create subscription payment
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: {
    customerId,
    organizationId,
    sourceId: subscriptionId,
    sourceModel: 'Subscription',
  },
  planKey: 'monthly',
  monetizationType: 'subscription',
  amount: 2999,
  gateway: 'manual',
});

// Verify payment
await revenue.payments.verify(paymentIntent.paymentIntentId);

// Listen to events
revenue.on('payment.verified', (event) => {
  console.log('Verified:', event.transaction._id);
});
```

## 📚 Guides

### [Building Payment Providers](./guides/PROVIDER_GUIDE.md)
Complete guide for building custom payment provider packages (Stripe, PayPal, SSLCommerz, etc.).

**Topics:**
- Minimal provider implementation (5 required methods)
- Creating payment intents
- Verifying payments and handling refunds
- Webhook integration
- Complete working examples
- Publishing to npm

### [Escrow Features](./guides/ESCROW_FEATURES.md)
Platform-as-intermediary payment flow for marketplaces.

**Topics:**
- Hold/release patterns
- Multi-party splits
- Affiliate commissions

## 📖 Examples

Located in [`revenue/examples/`](../revenue/examples/):

| Example | Description |
|---------|-------------|
| [`01-quick-start.ts`](../revenue/examples/01-quick-start.ts) | Basic setup with fluent API |
| [`02-subscriptions.ts`](../revenue/examples/02-subscriptions.ts) | Subscription lifecycle patterns |
| [`03-escrow-splits.ts`](../revenue/examples/03-escrow-splits.ts) | Escrow & multi-party splits |
| [`04-events-plugins.ts`](../revenue/examples/04-events-plugins.ts) | Events & plugin system |
| [`05-transaction-model.ts`](../revenue/examples/05-transaction-model.ts) | Complete model setup |
| [`06-resilience.ts`](../revenue/examples/06-resilience.ts) | Retry, circuit breaker, idempotency |

## 🏗️ Architecture

### Core Package (`@classytic/revenue`)
- **Fluent Builder API** - Chain configuration with IntelliSense
- **Type-safe Events** - Strongly typed pub/sub system
- **Result Type** - Rust-inspired error handling
- **Money Utility** - Integer-safe currency calculations
- **Plugin System** - Composable middleware
- **Resilience** - Retry, circuit breaker, idempotency

### Single Transaction Model
ONE Transaction model handles everything:

| Use Case | Category | Type |
|----------|----------|------|
| Subscriptions | `platform_subscription` | `income` |
| One-time purchases | `product_order` | `income` |
| Course enrollments | `course_enrollment` | `income` |
| Refunds | `refund` | `expense` |
| Operational expenses | `rent`, `salary` | `expense` |

### Provider Packages
Payment gateway implementations as separate packages:
- `@classytic/revenue-manual` - Manual payment verification (built-in)
- Community: `@yourorg/revenue-stripe`, `@yourorg/revenue-paypal`, etc.

### Design Principles
- **Framework agnostic** - Works with Express, Fastify, Next.js
- **Database flexible** - Uses your existing Mongoose models
- **Region neutral** - Define your own payment methods/categories
- **Provider pluggable** - Mix multiple payment providers
- **Type-safe** - Full TypeScript support

## 📋 Package Structure

```
@classytic/revenue (monorepo)
├── docs/                         # Documentation (this folder)
├── provider-patterns/            # Reference implementations
├── revenue/                      # Core package (@classytic/revenue)
│   ├── src/
│   │   ├── core/                 # Revenue builder, events, plugins
│   │   ├── services/             # Monetization, payment, escrow
│   │   ├── providers/            # Provider base classes
│   │   ├── enums/                # Enums for types/statuses
│   │   ├── schemas/              # Reusable Mongoose schemas
│   │   └── utils/                # Money, retry, idempotency
│   ├── examples/                 # Usage examples
│   └── package.json
├── revenue-manual/               # Manual provider package
│   ├── src/
│   │   └── index.ts
│   └── package.json
└── tests/                        # Integration & unit tests
```

## 🔑 Key Concepts

### Fluent Builder API
```typescript
const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('stripe', new StripeProvider())
  .withProvider('manual', new ManualProvider())
  .withPlugin(loggingPlugin())
  .withCommission(10, 2.9)
  .withCategoryMappings({ ProductOrder: 'product_order' })
  .withRetry({ maxAttempts: 3 })
  .withCircuitBreaker()
  .build();
```

### Transaction Types (Double-Entry Accounting)
- **Income**: Money coming in (payments, subscriptions)
- **Expense**: Money going out (refunds, payouts)
- Net Revenue = `SUM(income) - SUM(expense)`

### Provider System
Providers are pluggable packages implementing payment gateway integrations:
- Extend `PaymentProvider` base class
- Implement 5 required methods
- Return standardized response types
- Publishable independently

### State Management
- Transactions start as `'pending'`
- Admin/gateway verifies → `'verified'`
- Refunds blocked until verified (state guard)
- Refunds create separate expense transactions

### Webhook Flow
1. Provider validates signature and parses event
2. Provider returns standardized `WebhookEvent`
3. Library automatically updates transaction status
4. Library triggers application events
5. Idempotency prevents duplicate processing

## 🤝 Contributing Providers

When building providers:
1. Use [`@classytic/revenue-manual`](../revenue-manual/) as reference
2. Follow patterns in [PROVIDER_GUIDE.md](./guides/PROVIDER_GUIDE.md)
3. Publish as separate npm package: `@yourorg/revenue-{provider}`
4. Keep providers standalone and well-tested

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/classytic/revenue/issues)
- **Repository**: https://github.com/classytic/revenue
- **NPM**: [@classytic/revenue](https://www.npmjs.com/package/@classytic/revenue)

## 📄 License

MIT License - See LICENSE file in each package
