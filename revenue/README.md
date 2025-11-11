# @classytic/revenue

> Enterprise revenue management with subscriptions and payment processing

Thin, focused, production-ready library with smart defaults. Built for SaaS, marketplaces, and subscription businesses.

## Features

- **Subscriptions**: Create, renew, pause, cancel with lifecycle management
- **Payment Processing**: Multi-gateway support (Stripe, SSLCommerz, manual, etc.)
- **Transaction Management**: Income/expense tracking with verification and refunds
- **Provider Pattern**: Pluggable payment providers (like LangChain/Vercel AI SDK)
- **Framework Agnostic**: Works with Express, Fastify, Next.js, or standalone
- **TypeScript Ready**: Full type definitions included

## Installation

```bash
npm install @classytic/revenue
npm install @classytic/revenue-manual  # For manual payments
```

## Quick Start (30 seconds)

```javascript
import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import Transaction from './models/Transaction.js';

// 1. Configure
const revenue = createRevenue({
  models: { Transaction },
  providers: { manual: new ManualProvider() },
});

// 2. Create subscription
const { subscription, transaction } = await revenue.subscriptions.create({
  data: { organizationId, customerId },
  planKey: 'monthly',
  amount: 1500,
  gateway: 'manual',
  paymentData: { method: 'bkash', walletNumber: '01712345678' },
});

// 3. Verify payment
await revenue.payments.verify(transaction.gateway.paymentIntentId);

// 4. Refund if needed
await revenue.payments.refund(transaction._id, 500, { reason: 'Partial refund' });
```

**That's it!** Working revenue system in 3 steps.

## Transaction Model Setup

The library requires a Transaction model with specific fields and provides reusable schemas:

```javascript
import mongoose from 'mongoose';
import {
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS_VALUES,
} from '@classytic/revenue/enums';
import {
  gatewaySchema,
  paymentDetailsSchema,
} from '@classytic/revenue/schemas';

const transactionSchema = new mongoose.Schema({
  // ============ REQUIRED BY LIBRARY ============
  organizationId: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
  type: { type: String, enum: TRANSACTION_TYPE_VALUES, required: true },  // 'income' | 'expense'
  method: { type: String, required: true },  // 'manual' | 'bkash' | 'card' | etc.
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, required: true },
  category: { type: String, required: true },  // Your custom categories

  // ============ LIBRARY SCHEMAS (nested) ============
  gateway: gatewaySchema,              // Payment gateway details
  paymentDetails: paymentDetailsSchema, // Payment info (wallet, bank, etc.)

  // ============ YOUR CUSTOM FIELDS ============
  customerId: String,
  currency: { type: String, default: 'BDT' },
  verifiedAt: Date,
  verifiedBy: mongoose.Schema.Types.ObjectId,
  refundedAmount: Number,
  idempotencyKey: { type: String, unique: true, sparse: true },
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export default mongoose.model('Transaction', transactionSchema);
```

## Available Schemas

| Schema | Purpose | Key Fields |
|--------|---------|------------|
| `gatewaySchema` | Payment gateway integration | `type`, `paymentIntentId`, `sessionId` |
| `paymentDetailsSchema` | Payment method info | `walletNumber`, `trxId`, `bankName` |
| `commissionSchema` | Commission tracking | `rate`, `grossAmount`, `netAmount` |
| `currentPaymentSchema` | Latest payment (for Order/Subscription models) | `transactionId`, `status`, `verifiedAt` |
| `subscriptionInfoSchema` | Subscription details (for Order models) | `planKey`, `startDate`, `endDate` |

**Usage:** Import and use as nested objects (NOT spread):

```javascript
import { gatewaySchema } from '@classytic/revenue/schemas';

const schema = new mongoose.Schema({
  gateway: gatewaySchema,  // ✅ Correct - nested
  // ...gatewaySchema,     // ❌ Wrong - don't spread
});
```

## Core API

### Subscriptions

```javascript
// Create subscription
const { subscription, transaction, paymentIntent } = 
  await revenue.subscriptions.create({
    data: { organizationId, customerId },
    planKey: 'monthly',
    amount: 1500,
    currency: 'BDT',
    gateway: 'manual',
    paymentData: { method: 'bkash', walletNumber: '01712345678' },
  });

// Verify and activate
await revenue.payments.verify(transaction.gateway.paymentIntentId);
await revenue.subscriptions.activate(subscription._id);

// Renew subscription
await revenue.subscriptions.renew(subscription._id, {
  gateway: 'manual',
  paymentData: { method: 'nagad' },
});

// Pause/Resume
await revenue.subscriptions.pause(subscription._id, { reason: 'Customer request' });
await revenue.subscriptions.resume(subscription._id, { extendPeriod: true });

// Cancel
await revenue.subscriptions.cancel(subscription._id, { immediate: true });
```

### Payments

```javascript
// Verify payment (admin approval for manual)
const { transaction } = await revenue.payments.verify(paymentIntentId, {
  verifiedBy: adminUserId,
});

// Get payment status
const { status } = await revenue.payments.getStatus(paymentIntentId);

// Refund (creates separate EXPENSE transaction)
const { transaction, refundTransaction } = await revenue.payments.refund(
  transactionId,
  500,  // Amount or null for full refund
  { reason: 'Customer requested' }
);

// Handle webhook (for automated providers like Stripe)
const { event, transaction } = await revenue.payments.handleWebhook(
  'stripe',
  webhookPayload,
  headers
);
```

### Transactions

```javascript
// Get transaction by ID
const transaction = await revenue.transactions.get(transactionId);

// List with filters
const { transactions, total } = await revenue.transactions.list(
  { type: 'income', status: 'verified' },
  { limit: 50, sort: { createdAt: -1 } }
);

// Calculate net revenue
const income = await revenue.transactions.list({ type: 'income' });
const expense = await revenue.transactions.list({ type: 'expense' });
const netRevenue = income.total - expense.total;
```

## Transaction Types (Income vs Expense)

The library uses **double-entry accounting**:

- **INCOME** (`'income'`): Money coming in - payments, subscriptions
- **EXPENSE** (`'expense'`): Money going out - refunds, payouts

```javascript
const revenue = createRevenue({
  models: { Transaction },
  config: {
    transactionTypeMapping: {
      subscription: 'income',
      purchase: 'income',
      refund: 'expense',  // Refunds create separate expense transactions
    },
  },
});
```

**Refund Pattern:**
- Refund creates NEW transaction with `type: 'expense'`
- Original transaction status becomes `'refunded'` or `'partially_refunded'`
- Both linked via metadata for audit trail
- Calculate net: `SUM(income) - SUM(expense)`

## Custom Categories

Map logical entities to transaction categories:

```javascript
const revenue = createRevenue({
  models: { Transaction },
  config: {
    categoryMappings: {
      Order: 'order_subscription',
      PlatformSubscription: 'platform_subscription',
      Membership: 'gym_membership',
      Enrollment: 'course_enrollment',
    },
  },
});

// Usage
await revenue.subscriptions.create({
  entity: 'Order',  // Maps to 'order_subscription' category
  monetizationType: 'subscription',
  // ...
});
```

**Note:** `entity` is a logical identifier (not a database model name) for organizing your business logic.

## Hooks

```javascript
const revenue = createRevenue({
  models: { Transaction },
  hooks: {
    'subscription.created': async ({ subscription, transaction }) => {
      console.log('New subscription:', subscription._id);
    },
    'payment.verified': async ({ transaction }) => {
      // Send confirmation email
    },
    'payment.refunded': async ({ refundTransaction }) => {
      // Process refund notification
    },
  },
});
```

**Available hooks:**
- `subscription.created`, `subscription.activated`, `subscription.renewed`
- `subscription.paused`, `subscription.resumed`, `subscription.cancelled`
- `payment.verified`, `payment.refunded`
- `payment.webhook.{type}` (for webhook events)

## Building Payment Providers

Create custom providers for Stripe, PayPal, etc.:

```javascript
import { PaymentProvider, PaymentIntent, PaymentResult } from '@classytic/revenue';

export class StripeProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'stripe';
    this.stripe = new Stripe(config.apiKey);
  }

  async createIntent(params) {
    const intent = await this.stripe.paymentIntents.create({
      amount: params.amount,
      currency: params.currency,
    });

    return new PaymentIntent({
      id: intent.id,
      provider: 'stripe',
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      clientSecret: intent.client_secret,
      raw: intent,
    });
  }

  async verifyPayment(intentId) {
    const intent = await this.stripe.paymentIntents.retrieve(intentId);
    return new PaymentResult({
      id: intent.id,
      provider: 'stripe',
      status: intent.status === 'succeeded' ? 'succeeded' : 'failed',
      paidAt: new Date(),
      raw: intent,
    });
  }

  // Implement: getStatus(), refund(), handleWebhook()
}
```

**See:** [`docs/guides/PROVIDER_GUIDE.md`](../docs/guides/PROVIDER_GUIDE.md) for complete guide.

## TypeScript

Full TypeScript support included:

```typescript
import { createRevenue, Revenue, PaymentService } from '@classytic/revenue';
import { TRANSACTION_TYPE, TRANSACTION_STATUS } from '@classytic/revenue/enums';

const revenue: Revenue = createRevenue({
  models: { Transaction },
});

// All services are fully typed
const payment = await revenue.payments.verify(id);
const subscription = await revenue.subscriptions.create({ ... });
```

## Examples

- [`examples/basic-usage.js`](examples/basic-usage.js) - Quick start guide
- [`examples/transaction.model.js`](examples/transaction.model.js) - Complete model setup
- [`examples/transaction-type-mapping.js`](examples/transaction-type-mapping.js) - Income/expense configuration
- [`examples/complete-flow.js`](examples/complete-flow.js) - Full lifecycle with state management
- [`examples/multivendor-platform.js`](examples/multivendor-platform.js) - Multi-tenant setup

## Error Handling

```javascript
import { 
  TransactionNotFoundError,
  ProviderNotFoundError,
  AlreadyVerifiedError,
  RefundError,
} from '@classytic/revenue';

try {
  await revenue.payments.verify(id);
} catch (error) {
  if (error instanceof AlreadyVerifiedError) {
    console.log('Already verified');
  } else if (error instanceof TransactionNotFoundError) {
    console.log('Transaction not found');
  }
}
```

## Documentation

- **[Provider Guide](../docs/guides/PROVIDER_GUIDE.md)** - Build custom payment providers
- **[Architecture](../docs/README.md#architecture)** - System design and patterns
- **[API Reference](../docs/README.md)** - Complete API documentation

## Support

- **GitHub**: [classytic/revenue](https://github.com/classytic/revenue)
- **Issues**: [Report bugs](https://github.com/classytic/revenue/issues)
- **NPM**: [@classytic/revenue](https://www.npmjs.com/package/@classytic/revenue)

## License

MIT © [Classytic](https://github.com/classytic)
