# @classytic/revenue

> Enterprise revenue management with subscriptions and payment processing

Thin, focused, production-ready library with smart defaults. Built for SaaS, marketplaces, and subscription businesses.

## Features

- **Subscriptions**: Create, renew, upgrade, downgrade with smart proration
- **Payment Processing**: Multi-gateway support (Stripe, SSLCommerz, bKash, manual)
- **Transaction Management**: Complete lifecycle with verification and refunds
- **Provider Pattern**: Pluggable payment providers (like AI SDK)
- **Framework Agnostic**: Works with Fastify, Express, Nest, or standalone
- **Model Flexible**: Plain Mongoose OR @classytic/mongokit Repository
- **TypeScript Ready**: Full type definitions included
- **Zero Dependencies**: Only requires `mongoose` as peer dependency

## Installation

```bash
npm install @classytic/revenue
```

## Transaction Model Setup

Spread library enums/schemas into your Transaction model:

```javascript
import mongoose from 'mongoose';
import {
  TRANSACTION_STATUS_VALUES,
  LIBRARY_CATEGORIES,
} from '@classytic/revenue/enums';
import {
  gatewaySchema,
  currentPaymentSchema,
  paymentDetailsSchema,
} from '@classytic/revenue/schemas';

// Merge library categories with your own
const MY_CATEGORIES = {
  ...LIBRARY_CATEGORIES,  // subscription, purchase
  SALARY: 'salary',
  RENT: 'rent',
  EQUIPMENT: 'equipment',
  // Add as many as you need
};

const transactionSchema = new mongoose.Schema({
  // Required by library
  organizationId: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, required: true },
  category: { type: String, enum: Object.values(MY_CATEGORIES), required: true },

  // Spread library schemas
  gateway: gatewaySchema,
  currentPayment: currentPaymentSchema,
  paymentDetails: paymentDetailsSchema,

  // Add your fields
  notes: String,
  invoiceNumber: String,
}, { timestamps: true });

export default mongoose.model('Transaction', transactionSchema);
```

**See [`examples/transaction.model.js`](examples/transaction.model.js) for complete example with indexes.**

## Quick Start

### Minimal Setup (3 lines)

```javascript
import { createRevenue } from '@classytic/revenue';
import Transaction from './models/Transaction.js';

// Works out-of-box with built-in manual provider
const revenue = createRevenue({
  models: { Transaction },
});

// Create a subscription
const { subscription, transaction } = await revenue.subscriptions.create({
  data: { organizationId, customerId },
  planKey: 'monthly',
  amount: 99.99,
});
```

That's it! The package works immediately with sensible defaults.

## Usage Examples

### With Payment Provider

```javascript
import { createRevenue } from '@classytic/revenue';
// Future: import { stripe } from '@classytic/revenue-stripe';

const revenue = createRevenue({
  models: { Transaction },
  providers: {
    // Built-in manual provider is auto-included
    // stripe: stripe({ apiKey: process.env.STRIPE_KEY }),
  },
});

// Create subscription with payment gateway
await revenue.subscriptions.create({
  data: { organizationId, customerId },
  planKey: 'monthly',
  amount: 99.99,
  gateway: 'stripe', // or 'manual'
});
```

### With Hooks

```javascript
const revenue = createRevenue({
  models: { Transaction },
  hooks: {
    'payment.verified': async ({ transaction }) => {
      console.log('Payment verified:', transaction._id);
      // Send email, update analytics, etc.
    },
    'subscription.created': async ({ subscription, transaction }) => {
      console.log('New subscription:', subscription._id);
    },
  },
});
```

### Custom Logger

```javascript
import winston from 'winston';

const revenue = createRevenue({
  models: { Transaction },
  logger: winston.createLogger({ /* config */ }),
});
```

## Core API

### Services

The `revenue` instance provides three focused services:

#### Subscriptions

```javascript
// Create subscription
const { subscription, transaction, paymentIntent } = await revenue.subscriptions.create({
  data: { organizationId, customerId, ... },
  planKey: 'monthly',
  amount: 99.99,
  currency: 'USD',
  gateway: 'manual', // optional
  metadata: { /* ... */ }, // optional
});

// Renew subscription
await revenue.subscriptions.renew(subscriptionId, { amount: 99.99 });

// Activate subscription
await revenue.subscriptions.activate(subscriptionId);

// Cancel subscription
await revenue.subscriptions.cancel(subscriptionId, { immediate: true });

// Pause/Resume
await revenue.subscriptions.pause(subscriptionId);
await revenue.subscriptions.resume(subscriptionId);

// Get/List
await revenue.subscriptions.get(subscriptionId);
await revenue.subscriptions.list(filters, options);
```

#### Payments

```javascript
// Verify payment
const { transaction, paymentResult, status } = await revenue.payments.verify(
  paymentIntentId,
  { verifiedBy: userId }
);

// Get payment status
const { transaction, status, provider } = await revenue.payments.getStatus(paymentIntentId);

// Refund payment
const { transaction, refundResult } = await revenue.payments.refund(
  paymentId,
  amount, // optional, defaults to full refund
  { reason: 'Customer request' }
);

// Handle webhook
const { event, transaction, status } = await revenue.payments.handleWebhook(
  'stripe',
  payload,
  headers
);
```

#### Transactions

```javascript
// Get transaction
const transaction = await revenue.transactions.get(transactionId);

// List transactions
const { transactions, total, page, limit, pages } = await revenue.transactions.list(
  { organizationId, status: 'verified' },
  { limit: 50, skip: 0, sort: { createdAt: -1 } }
);

// Update transaction
await revenue.transactions.update(transactionId, { notes: 'Updated' });
```

**Note**: For analytics, exports, or complex queries, use Mongoose aggregations directly on your Transaction model. This keeps the service thin and focused.

### Providers

```javascript
// Get specific provider
const stripeProvider = revenue.getProvider('stripe');

// Check capabilities
const capabilities = stripeProvider.getCapabilities();
// {
//   supportsWebhooks: true,
//   supportsRefunds: true,
//   supportsPartialRefunds: true,
//   requiresManualVerification: false
// }
```

## Error Handling

All errors are typed with codes for easy handling:

```javascript
import {
  TransactionNotFoundError,
  ProviderNotFoundError,
  RefundNotSupportedError
} from '@classytic/revenue';

try {
  await revenue.payments.verify(intentId);
} catch (error) {
  if (error instanceof TransactionNotFoundError) {
    console.log('Transaction not found:', error.metadata.transactionId);
  }

  if (error.code === 'TRANSACTION_NOT_FOUND') {
    // Handle specific error
  }

  if (error.retryable) {
    // Retry the operation
  }
}
```

### Error Classes

- `RevenueError` - Base error class
- `ConfigurationError` - Configuration issues
- `ModelNotRegisteredError` - Model not provided
- `ProviderError` - Provider-related errors
- `ProviderNotFoundError` - Provider doesn't exist
- `PaymentIntentCreationError` - Failed to create payment intent
- `PaymentVerificationError` - Verification failed
- `NotFoundError` - Resource not found
- `TransactionNotFoundError` - Transaction not found
- `SubscriptionNotFoundError` - Subscription not found
- `ValidationError` - Validation failed
- `InvalidAmountError` - Invalid amount
- `MissingRequiredFieldError` - Required field missing
- `StateError` - Invalid state
- `AlreadyVerifiedError` - Already verified
- `InvalidStateTransitionError` - Invalid state change
- `RefundNotSupportedError` - Provider doesn't support refunds
- `RefundError` - Refund failed

## Enums & Schemas

```javascript
import {
  TRANSACTION_STATUS,
  PAYMENT_GATEWAY_TYPE,
  SUBSCRIPTION_STATUS,
  PLAN_KEYS,
  currentPaymentSchema,
  subscriptionInfoSchema,
} from '@classytic/revenue';

// Use in your models
const organizationSchema = new Schema({
  currentPayment: currentPaymentSchema,
  subscription: subscriptionInfoSchema,
});
```

## TypeScript

Full TypeScript support included:

```typescript
import { createRevenue, Revenue, RevenueOptions } from '@classytic/revenue';

const options: RevenueOptions = {
  models: { Transaction: TransactionModel },
};

const revenue: Revenue = createRevenue(options);
```

## Advanced Usage

### Custom Providers

```javascript
import { PaymentProvider } from '@classytic/revenue';

class MyCustomProvider extends PaymentProvider {
  name = 'my-gateway';

  async createIntent(params) {
    // Implementation
  }

  async verifyPayment(intentId) {
    // Implementation
  }

  getCapabilities() {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: false,
      requiresManualVerification: false,
    };
  }
}

const revenue = createRevenue({
  models: { Transaction },
  providers: {
    'my-gateway': new MyCustomProvider(),
  },
});
```

### DI Container Access

```javascript
const revenue = createRevenue({ models: { Transaction } });

// Access container
const models = revenue.container.get('models');
const providers = revenue.container.get('providers');
```

## Hook Events

Available hook events:

- `payment.verified` - Payment verified
- `payment.failed` - Payment failed
- `subscription.created` - Subscription created
- `subscription.renewed` - Subscription renewed
- `subscription.activated` - Subscription activated
- `subscription.cancelled` - Subscription cancelled
- `subscription.paused` - Subscription paused
- `subscription.resumed` - Subscription resumed
- `transaction.created` - Transaction created
- `transaction.updated` - Transaction updated

Hooks are fire-and-forget - they never break the main flow. Errors are logged but don't throw.

## Architecture

```
@classytic/revenue (core package)
├── Builder (createRevenue)
├── DI Container
├── Services (focused on lifecycle)
│   ├── SubscriptionService
│   ├── PaymentService
│   └── TransactionService
├── Providers
│   ├── base.js (interface)
│   └── manual.js (built-in)
├── Error classes
└── Schemas & Enums

@classytic/revenue-stripe (future)
@classytic/revenue-sslcommerz (future)
@classytic/revenue-fastify (framework adapter, future)
```

## Design Principles

- **KISS**: Keep It Simple, Stupid
- **DRY**: Don't Repeat Yourself
- **SOLID**: Single responsibility, focused services
- **Immutable**: Revenue instance is deeply frozen
- **Thin Core**: Core operations only, users extend as needed
- **Smart Defaults**: Works out-of-box with minimal config

## Migration from Legacy API

If you're using the old `initializeRevenue()` API:

```javascript
// ❌ Old (legacy API - removed)
import { initializeRevenue, monetization, payment } from '@classytic/revenue';
initializeRevenue({ TransactionModel, transactionService });
await monetization.createSubscription(params);

// ✅ New (DI-based API)
import { createRevenue } from '@classytic/revenue';
const revenue = createRevenue({ models: { Transaction } });
await revenue.subscriptions.create(params);
```

## Documentation

- **[Building Payment Providers](../docs/guides/PROVIDER_GUIDE.md)** - Create custom payment integrations
- **[Examples](../docs/examples/)** - Complete usage examples
- **[Full Documentation](../docs/README.md)** - Comprehensive guides

## Support

- **GitHub**: https://github.com/classytic/revenue
- **Issues**: https://github.com/classytic/revenue/issues
- **npm**: https://npmjs.com/package/@classytic/revenue

## License

MIT © Classytic (Classytic)

---

**Built with ❤️ following SOLID principles and industry best practices**
