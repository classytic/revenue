# @classytic/revenue Documentation

Enterprise-grade revenue management system for subscriptions and payments.

## 📦 Packages

### [@classytic/revenue](../revenue/README.md)
Core library providing subscription management, payment processing, and transaction tracking.

**Install:** `npm install @classytic/revenue`

### [@classytic/revenue-manual](../revenue-manual/README.md)
Manual payment provider for cash, bank transfers, mobile money without API.

**Install:** `npm install @classytic/revenue-manual`

## 🚀 Quick Start

```javascript
import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = createRevenue({
  models: { Transaction },
  providers: { manual: new ManualProvider() },
});

// Create subscription
const { subscription, transaction } = await revenue.subscriptions.create({
  data: { organizationId, customerId },
  planKey: 'monthly',
  amount: 1500,
  gateway: 'manual',
});

// Verify payment
await revenue.payments.verify(transaction.gateway.paymentIntentId);
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

**Perfect for:** Community developers building payment integrations or teams implementing custom gateways.

## 📖 Examples

Located in [`revenue/examples/`](../revenue/examples/):

| Example | Description |
|---------|-------------|
| [`basic-usage.js`](../revenue/examples/basic-usage.js) | Simple setup with subscriptions |
| [`transaction.model.js`](../revenue/examples/transaction.model.js) | Complete model setup with schemas |
| [`transaction-type-mapping.js`](../revenue/examples/transaction-type-mapping.js) | Income/expense configuration |
| [`complete-flow.js`](../revenue/examples/complete-flow.js) | Full lifecycle with state guards |
| [`multivendor-platform.js`](../revenue/examples/multivendor-platform.js) | Multi-tenant SaaS setup |

## 🏗️ Architecture

### Core Package (`@classytic/revenue`)
- Subscription management (create, renew, cancel, pause)
- Payment processing (verify, refund, webhooks)
- Transaction tracking (income/expense)
- Hook system for extensibility
- Provider abstraction layer

### Provider Packages
Payment gateway implementations as separate packages:
- `@classytic/revenue-manual` - Manual payment verification (built-in)
- Community: `@yourorg/revenue-stripe`, `@yourorg/revenue-paypal`, etc.

### Design Principles
- **Framework agnostic** - Works with Express, Fastify, Next.js
- **Database flexible** - Uses your existing Mongoose models
- **Region neutral** - Define your own payment methods/categories
- **Provider pluggable** - Mix multiple payment providers
- **DI-based** - Fully testable with dependency injection

## 📋 Package Structure

```
@classytic/revenue (monorepo)
├── docs/                         # Documentation (this folder)
├── revenue/                      # Core package (@classytic/revenue)
│   ├── core/                     # DI container, builder, errors
│   ├── services/                 # Subscription, payment, transaction
│   ├── providers/                # Provider base classes
│   ├── enums/                    # Enums for types/statuses
│   ├── schemas/                  # Reusable Mongoose schemas
│   ├── examples/                 # Usage examples
│   └── package.json
└── revenue-manual/               # Manual provider package
    ├── index.js
    └── package.json
```

## 🔑 Key Concepts

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
4. Library triggers application hooks
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
