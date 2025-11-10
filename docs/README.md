# @classytic/revenue Documentation

Complete documentation for the @classytic/revenue monorepo - an enterprise-grade revenue management system combining monetization (subscriptions, purchases) and payment processing.

## Quick Links

- [Main README](../README.md) - Package overview and quick start
- [Core Package (@classytic/revenue)](../revenue/README.md) - Core library documentation
- [Manual Provider (@classytic/revenue-manual)](../revenue-manual/README.md) - Manual payment provider

## 📚 Guides

### [Building Payment Providers](./guides/PROVIDER_GUIDE.md)
Complete guide for building custom payment provider packages (Stripe, PayPal, SSLCommerz, etc.)

**Topics covered:**
- Minimal provider implementation (5 required methods)
- Creating payment intents
- Verifying payments
- Handling refunds
- Webhook integration
- Complete working examples (Stripe, SSLCommerz)
- Publishing your provider to npm

**Perfect for:**
- Community developers building payment integrations
- Teams implementing custom payment gateways
- Anyone extending the revenue system

## 📖 Examples

### [Basic Usage](./examples/basic-usage.js)
Shows how to set up the revenue system with subscriptions and payment processing.

### [Transaction Model](./examples/transaction.model.js)
Complete example showing how to:
- Merge library enums with your own custom categories
- Define payment methods for your region/business
- Set up proper Mongoose schemas
- Use library-provided schema components

## 🏗️ Architecture

The @classytic/revenue monorepo consists of:

### Core Package (`@classytic/revenue`)
The main library providing:
- Subscription management (create, renew, cancel, prorate)
- Payment processing (verify, refund, webhooks)
- Transaction tracking
- Hook system for extensibility
- Provider abstraction layer

### Provider Packages
Payment gateway implementations as separate packages:
- `@classytic/revenue-manual` - Manual payment verification (included)
- Community providers: `@yourorg/revenue-stripe`, `@yourorg/revenue-paypal`, etc.

## 🔧 Configuration

The system is designed to be:
- **Framework agnostic** - Works with Express, Fastify, Next.js, etc.
- **Database flexible** - Uses your existing Mongoose models
- **Region neutral** - Define your own payment methods and categories
- **Provider pluggable** - Mix multiple payment providers

Example configuration:

```javascript
import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = createRevenue({
  models: {
    Transaction: YourTransactionModel,
    Subscription: YourSubscriptionModel,
  },
  providers: {
    manual: new ManualProvider(),
    // Add more providers as needed
  },
  hooks: {
    'subscription.created': async (data) => {
      // Your logic
    },
  },
});
```

## 📦 Publishing Packages

This monorepo uses npm workspaces. To publish:

```bash
# Publish core package
npm run publish:revenue

# Publish manual provider
npm run publish:revenue-manual

# Publish both
npm run publish:all
```

## 🤝 Contributing

When contributing:
1. Keep the core package **generic and region-neutral**
2. Don't hardcode payment methods or business-specific categories
3. Provider packages should be standalone and publishable
4. Follow the patterns in PROVIDER_GUIDE.md for new providers

## 📋 Package Structure

```
@classytic/revenue (monorepo)
├── docs/                         # All documentation
│   ├── README.md                 # This file
│   ├── guides/
│   │   └── PROVIDER_GUIDE.md     # Building payment providers
│   └── examples/
│       ├── basic-usage.js
│       └── transaction.model.js
├── revenue/                      # Core package
│   └── package.json             # @classytic/revenue
├── revenue-manual/               # Manual provider
│   └── package.json             # @classytic/revenue-manual
└── package.json                  # Workspace root
```

## 🔍 Key Concepts

### Library-Managed vs User-Defined

**The library manages:**
- Transaction statuses (pending, completed, failed, etc.)
- Core categories (subscription, purchase)
- Provider interface and webhook handling

**Users define:**
- Custom transaction categories (salary, rent, equipment, etc.)
- Payment methods (bkash, card, bank, cash, etc.)
- Business-specific models and fields

### Provider System

Providers are pluggable packages that implement payment gateway integrations. Each provider:
- Extends the `PaymentProvider` base class
- Implements 5 required methods
- Returns standardized response types
- Can be published independently

### Webhook Flow

1. Provider validates signature and parses event
2. Provider returns standardized `WebhookEvent`
3. Library automatically updates transaction status
4. Library triggers application hooks
5. Idempotency prevents duplicate processing

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/classytic/revenue/issues)
- **Core Repository**: https://github.com/classytic/revenue
- **Provider Template**: Use `@classytic/revenue-manual` as reference

## 📄 License

MIT License - See LICENSE file in each package
