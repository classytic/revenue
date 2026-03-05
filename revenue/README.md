# @classytic/revenue

> **Universal financial ledger for SaaS & marketplaces**

Track subscriptions, purchases, refunds, escrow, and commission splits in **ONE Transaction model**. Built for enterprise with state machines, automatic retry logic, and multi-gateway support.

[![npm version](https://badge.fury.io/js/@classytic%2Frevenue.svg)](https://www.npmjs.com/package/@classytic/revenue)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What Is This?

A TypeScript library that handles **all financial transactions** in one unified model:

```typescript
// Subscription payment
{ type: 'subscription', flow: 'inflow', amount: 2999 }

// Product purchase
{ type: 'product_order', flow: 'inflow', amount: 1500 }

// Refund
{ type: 'refund', flow: 'outflow', amount: 1500 }

// Operational expense
{ type: 'rent', flow: 'outflow', amount: 50000 }
```

**One table. Query by type. Calculate P&L. Track cash flow.**

---
## Unified Cashflow Model (Shared Types)

`@classytic/revenue` re-exports the unified transaction types from `@classytic/shared-types`. If you want a single Transaction model across revenue + payroll, define your schema using the shared types. The shared types are an interface only — you own the schema, enums, and indexes. There is no required “common schema”.

Type safety is provided by `ITransaction` only. Transaction categories (`type`) are app-defined; `flow` (`inflow`/`outflow`) is the only shared enum.

```typescript
import type { ITransaction } from '@classytic/shared-types';
// or: import type { ITransaction } from '@classytic/revenue';
```


## Why Use This?

**Instead of:**
- Separate tables for subscriptions, orders, refunds, invoices
- Scattered payment logic across your codebase
- Manual state management and validation
- Building payment provider integrations from scratch

**You get:**
- ✅ **ONE Transaction model** = Simpler schema, easier queries
- ✅ **State machines** = Prevents invalid transitions (can't refund a pending payment)
- ✅ **Provider abstraction** = Swap Stripe/PayPal/SSLCommerz without code changes
- ✅ **Production-ready** = Retry, circuit breaker, idempotency built-in
- ✅ **Plugins** = Optional tax, logging, audit trails
- ✅ **Type-safe** = Full TypeScript + Zod v4 validation
- ✅ **Integer money** = No floating-point errors

---

## When to Use This

| Use Case | Example |
|----------|---------|
| **SaaS billing** | Monthly/annual subscriptions with auto-renewal |
| **Marketplace payouts** | Creator platforms, affiliate commissions |
| **E-commerce** | Product purchases with refunds |
| **Escrow** | Hold funds until delivery/conditions met |
| **Multi-party splits** | Revenue sharing (70% creator, 20% affiliate, 10% platform) |
| **Financial reporting** | P&L statements, cash flow tracking |

---

## Installation

```bash
npm install @classytic/revenue @classytic/shared-types mongoose zod
```

**Peer Dependencies:**
- `@classytic/shared-types` ^1.0.0
- `mongoose` ^8.0.0 || ^9.0.0
- `zod` ^4.0.0

**Provider Packages** (install as needed):
```bash
npm install @classytic/revenue-manual  # For cash/bank transfers
# Coming soon: @classytic/revenue-stripe, @classytic/revenue-sslcommerz
```

---

## Quick Start

### 1. Define Your Transaction Model

Copy the complete model from [examples/05-transaction-model.ts](./examples/05-transaction-model.ts):

```typescript
import mongoose, { Schema } from 'mongoose';
import type { ITransaction } from '@classytic/shared-types';
import {
  TRANSACTION_FLOW_VALUES,
  TRANSACTION_STATUS_VALUES,
  gatewaySchema,
  commissionSchema,
} from '@classytic/revenue';

// Your business categories
const CATEGORIES = {
  PLATFORM_SUBSCRIPTION: 'platform_subscription',
  COURSE_ENROLLMENT: 'course_enrollment',
  PRODUCT_ORDER: 'product_order',
  REFUND: 'refund',
  RENT: 'rent',
  SALARY: 'salary',
};

const transactionSchema = new Schema<ITransaction>({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  sourceId: { type: Schema.Types.ObjectId },
  sourceModel: { type: String }, // your app’s model name
  type: { type: String, enum: Object.values(CATEGORIES), required: true }, // category
  flow: { type: String, enum: TRANSACTION_FLOW_VALUES, required: true },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, default: 'pending' },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  method: { type: String, required: true },
  gateway: gatewaySchema,
  commission: commissionSchema,
  // ... see full model in examples
}, { timestamps: true });

export const Transaction = mongoose.model('Transaction', transactionSchema);
```

When you call `monetization.create`, you can optionally pass `sourceId`/`sourceModel` in the input; revenue stores those as `sourceId`/`sourceModel` on the transaction for unified cashflow queries. If you create transactions yourself, set `sourceId`/`sourceModel` directly.

### 2. Initialize Revenue

```typescript
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = Revenue.create({
  defaultCurrency: 'USD',
  commissionRate: 0.10,      // 10% platform fee
  gatewayFeeRate: 0.029,     // 2.9% payment processor
})
  .withModels({ Transaction })
  .withProvider('manual', new ManualProvider())
  .build();
```

### 3. Create a Payment

```typescript
// Create subscription payment
const { transaction, subscription } = await revenue.monetization.create({
  data: {
    organizationId: 'org_123',
    customerId: 'user_456',
  },
  planKey: 'monthly',
  monetizationType: 'subscription',
  amount: 2999,  // $29.99 in cents
  gateway: 'manual',
});

console.log(transaction.status);  // 'pending'
```

### 4. Verify Payment

```typescript
await revenue.payments.verify(transaction._id);

// Transaction: 'pending' → 'verified'
// Subscription: 'pending' → 'active'
```

### 5. Handle Refunds

```typescript
// Full refund
await revenue.payments.refund(transaction._id);

// Partial refund: $10.00
await revenue.payments.refund(transaction._id, 1000, {
  reason: 'customer_request',
});
```

---

## Core Concepts

### 1. Transaction Model (Required)

**The universal ledger.** Every financial event becomes a transaction:

```typescript
// Query subscriptions
const subscriptions = await Transaction.find({
  type: 'platform_subscription',
  status: 'verified'
});

// Calculate revenue
const income = await Transaction.aggregate([
  { $match: { flow: 'inflow', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const expenses = await Transaction.aggregate([
  { $match: { flow: 'outflow', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);

const netRevenue = income[0].total - expenses[0].total;
```

### 2. Payment Providers (Required)

**How money flows in.** Providers are swappable:

```typescript
import { ManualProvider } from '@classytic/revenue-manual';
// import { StripeProvider } from '@classytic/revenue-stripe'; // Coming soon

revenue
  .withProvider('manual', new ManualProvider())
  .withProvider('stripe', new StripeProvider({ apiKey: '...' }));

// Use any provider
await revenue.monetization.create({
  gateway: 'manual',  // or 'stripe'
  // ...
});
```

### 3. Plugins (Optional)

**Extend behavior.** Plugins add features without coupling:

```typescript
import { loggingPlugin, createTaxPlugin } from '@classytic/revenue/plugins';

revenue
  .withPlugin(loggingPlugin({ level: 'info' }))
  .withPlugin(createTaxPlugin({
    getTaxConfig: async (orgId) => ({
      isRegistered: true,
      defaultRate: 0.15,  // 15% tax
      pricesIncludeTax: false,
    }),
  }));
```

---

## Common Operations

### Create Subscription

```typescript
const { subscription, transaction } = await revenue.monetization.create({
  data: {
    organizationId: 'org_123',
    customerId: 'user_456',
  },
  planKey: 'monthly_premium',
  monetizationType: 'subscription',
  amount: 2999,  // $29.99/month
  gateway: 'manual',
});

// Later: Renew
await revenue.monetization.renew(subscription._id);

// Cancel
await revenue.monetization.cancel(subscription._id, {
  reason: 'customer_requested',
});
```

### Create One-Time Purchase

```typescript
const { transaction } = await revenue.monetization.create({
  data: {
    organizationId: 'org_123',
    customerId: 'user_456',
    sourceId: order._id,     // optional: stored as sourceId
    sourceModel: 'Order',    // optional: stored as sourceModel
  },
  planKey: 'one_time',
  monetizationType: 'purchase',
  amount: 10000,  // $100.00
  gateway: 'manual',
});
```

### Query Transactions

```typescript
// By type (category)
const subscriptions = await Transaction.find({
  type: 'platform_subscription',
  status: 'verified',
});

// By source (sourceId/sourceModel on the transaction)
const orderPayments = await Transaction.find({
  sourceModel: 'Order',
  sourceId: orderId,
});

// By customer
const customerTransactions = await Transaction.find({
  customerId: userId,
  flow: 'inflow',
}).sort({ createdAt: -1 });
```

---

## Advanced Features

### State Machines (Data Integrity)

Prevent invalid transitions automatically:

```typescript
import { TRANSACTION_STATE_MACHINE } from '@classytic/revenue';

// ✅ Valid
await revenue.payments.verify(transaction._id);  // pending → verified

// ❌ Invalid (throws InvalidStateTransitionError)
await revenue.payments.verify(completedTransaction._id);  // completed → verified

// Check if transition is valid
const canRefund = TRANSACTION_STATE_MACHINE.canTransition(
  transaction.status,
  'refunded'
);

// Get allowed next states
const allowed = TRANSACTION_STATE_MACHINE.getAllowedTransitions('verified');
// ['completed', 'refunded', 'partially_refunded', 'cancelled']

// Check if state is terminal
const isDone = TRANSACTION_STATE_MACHINE.isTerminalState('refunded');  // true
```

**Available State Machines:**
- `TRANSACTION_STATE_MACHINE` - Payment lifecycle
- `SUBSCRIPTION_STATE_MACHINE` - Subscription states
- `SETTLEMENT_STATE_MACHINE` - Payout tracking
- `HOLD_STATE_MACHINE` - Escrow holds
- `SPLIT_STATE_MACHINE` - Revenue splits

### Audit Trail (Track State Changes)

Every state transition is automatically logged:

```typescript
import { getAuditTrail } from '@classytic/revenue';

const transaction = await Transaction.findById(txId);
const history = getAuditTrail(transaction);

console.log(history);
// [
//   {
//     resourceType: 'transaction',
//     fromState: 'pending',
//     toState: 'verified',
//     changedAt: 2025-01-15T10:30:00.000Z,
//     changedBy: 'admin_123',
//     reason: 'Payment verified'
//   }
// ]
```

### Escrow (Marketplaces)

Hold funds until conditions met:

```typescript
// Create & verify transaction
const { transaction } = await revenue.monetization.create({ amount: 10000, ... });
await revenue.payments.verify(transaction._id);

// Hold in escrow
await revenue.escrow.hold(transaction._id, {
  reason: 'pending_delivery',
  holdUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
});

// Release to seller after delivery confirmed
await revenue.escrow.release(transaction._id, {
  recipientId: 'seller_123',
  recipientType: 'organization',
  reason: 'delivery_confirmed',
});
```

### Commission Splits (Affiliates)

Split revenue between multiple parties:

```typescript
await revenue.escrow.split(transaction._id, {
  splits: [
    { recipientId: 'creator_123', recipientType: 'user', percentage: 70 },
    { recipientId: 'affiliate_456', recipientType: 'user', percentage: 10 },
  ],
  organizationPercentage: 20,  // Platform keeps 20%
});

// Creates 3 transactions:
// - Creator: $70.00
// - Affiliate: $10.00
// - Platform: $20.00
```

### Events (React to Changes)

```typescript
import { EventBus } from '@classytic/revenue/events';

revenue.events.on('payment.verified', async (event) => {
  // Grant access
  await grantAccess(event.transaction.customerId);

  // Send email
  await sendEmail(event.transaction.customerId, 'Payment received!');
});

revenue.events.on('subscription.cancelled', async (event) => {
  await removeAccess(event.subscription.customerId);
});

// Other events:
// - monetization.created, payment.failed, payment.refunded
// - subscription.activated, subscription.renewed
// - escrow.held, escrow.released, settlement.completed
```

### Tax Plugin (Optional)

Automatically calculate and track tax:

```typescript
import { createTaxPlugin } from '@classytic/revenue/plugins';

const revenue = Revenue.create()
  .withModels({ Transaction })
  .withProvider('manual', new ManualProvider())
  .withPlugin(createTaxPlugin({
    getTaxConfig: async (organizationId) => ({
      isRegistered: true,
      defaultRate: 0.15,          // 15% tax
      pricesIncludeTax: false,    // Tax-exclusive pricing
      exemptCategories: ['education', 'donation'],
    }),
  }))
  .build();

// Tax calculated automatically
const { transaction } = await revenue.monetization.create({
  amount: 10000,  // $100.00
  // ...
});

console.log(transaction.tax);
// {
//   rate: 0.15,
//   baseAmount: 10000,
//   taxAmount: 1500,     // $15.00
//   totalAmount: 11500,  // $115.00
// }

// Tax automatically reversed on refunds
await revenue.payments.refund(transaction._id);
```

### Custom Plugins

```typescript
import { definePlugin } from '@classytic/revenue/plugins';

const notificationPlugin = definePlugin({
  name: 'notifications',
  version: '1.0.0',
  hooks: {
    'payment.verify.after': async (ctx, input, next) => {
      const result = await next();

      // Send notification
      await sendPushNotification({
        userId: result.transaction.customerId,
        message: 'Payment verified!',
      });

      return result;
    },
  },
});

revenue.withPlugin(notificationPlugin);
```

### Resilience Patterns

Built-in retry, circuit breaker, and idempotency:

```typescript
// Automatic retry on provider failures
await revenue.payments.verify(transaction._id);
// Retries 3x with exponential backoff

// Manual idempotency
import { IdempotencyManager } from '@classytic/revenue';

const idem = new IdempotencyManager();

const result = await idem.execute(
  'charge_user_123',
  { amount: 2999 },
  () => revenue.monetization.create({ ... })
);

// Second call returns cached result (no duplicate charge)
```

### Money Utilities

No floating-point errors. All amounts in smallest currency unit (cents):

```typescript
import { Money, toSmallestUnit, fromSmallestUnit } from '@classytic/revenue';

// Create Money instances
const price = Money.usd(1999);           // $19.99
const euro = Money.of(2999, 'EUR');      // €29.99

// Conversions
toSmallestUnit(19.99, 'USD');   // 1999 cents
fromSmallestUnit(1999, 'USD');  // 19.99

// Arithmetic (immutable)
const total = price.add(Money.usd(500));      // $24.99
const discounted = price.multiply(0.9);       // $17.99

// Fair allocation (handles rounding)
const [a, b, c] = Money.usd(100).allocate([1, 1, 1]);
// [34, 33, 33] cents - total = 100 ✓

// Formatting
price.format();  // "$19.99"
```

---

## When to Use What

| Feature | Use Case |
|---------|----------|
| `monetization.create()` | New payment (subscription, purchase, free item) |
| `payments.verify()` | Mark payment successful after gateway confirmation |
| `payments.refund()` | Return money to customer (full or partial) |
| `escrow.hold()` | Marketplace - hold funds until delivery confirmed |
| `escrow.split()` | Affiliate/creator revenue sharing |
| Plugins | Tax calculation, logging, audit trails, metrics |
| Events | Send emails, grant/revoke access, analytics |
| State machines | Validate transitions, get allowed next actions |

---

## Real-World Example

**Course marketplace with affiliates:**

```typescript
// 1. Student buys course ($99)
const { transaction } = await revenue.monetization.create({
  data: {
    organizationId: 'org_123',
    customerId: 'student_456',
    sourceId: enrollmentId,
    sourceModel: 'Enrollment',
  },
  planKey: 'one_time',
  monetizationType: 'purchase',
  entity: 'CourseEnrollment',
  amount: 9900,
  gateway: 'stripe',
});

// 2. Payment verified → Grant course access
await revenue.payments.verify(transaction._id);

// 3. Hold in escrow (30-day refund window)
await revenue.escrow.hold(transaction._id);

// 4. After 30 days, split revenue
await revenue.escrow.split(transaction._id, {
  splits: [
    { recipientId: 'creator_123', percentage: 70 },    // $69.30
    { recipientId: 'affiliate_456', percentage: 10 },  // $9.90
  ],
  organizationPercentage: 20,  // $19.80 (platform)
});

// 5. Calculate P&L
const income = await Transaction.aggregate([
  { $match: { flow: 'inflow', status: 'verified' } },
  { $group: { _id: null, total: { $sum: '$amount' } } },
]);
```

---

## Submodule Imports

Tree-shakable imports for smaller bundles:

```typescript
// Plugins
import { loggingPlugin, auditPlugin, createTaxPlugin } from '@classytic/revenue/plugins';

// Enums
import { TRANSACTION_STATUS, PAYMENT_STATUS } from '@classytic/revenue/enums';

// Events
import { EventBus } from '@classytic/revenue/events';

// Schemas (Mongoose)
import { transactionSchema, subscriptionSchema } from '@classytic/revenue/schemas';

// Validation (Zod)
import { CreatePaymentSchema } from '@classytic/revenue/schemas/validation';

// Utilities
import { retry, calculateCommission } from '@classytic/revenue/utils';

// Reconciliation
import { reconcileSettlement } from '@classytic/revenue/reconciliation';

// Services (advanced)
import { MonetizationService } from '@classytic/revenue/services';
```

---

## API Reference

### Services

| Service | Methods |
|---------|---------|
| `revenue.monetization` | `create()`, `renew()`, `cancel()`, `pause()`, `resume()` |
| `revenue.payments` | `verify()`, `refund()`, `getStatus()`, `handleWebhook()` |
| `revenue.transactions` | `get()`, `list()`, `update()` |
| `revenue.escrow` | `hold()`, `release()`, `cancel()`, `split()`, `getStatus()` |
| `revenue.settlement` | `createFromSplits()`, `processPending()`, `complete()`, `fail()`, `getSummary()` |

### State Machines

All state machines provide:
- `canTransition(from, to)` - Check if transition is valid
- `validate(from, to, id)` - Validate or throw error
- `getAllowedTransitions(state)` - Get next allowed states
- `isTerminalState(state)` - Check if state is final

### Utilities

| Function | Purpose |
|----------|---------|
| `calculateCommission(amount, rate, gatewayFee)` | Calculate platform commission |
| `calculateCommissionWithSplits(...)` | Commission with affiliate support |
| `reverseTax(originalTax, refundAmount)` | Proportional tax reversal |
| `retry(fn, options)` | Retry with exponential backoff |
| `reconcileSettlement(gatewayData, dbData)` | Gateway reconciliation |

---

## Error Handling

```typescript
import {
  PaymentIntentCreationError,
  InvalidStateTransitionError,
  InvalidAmountError,
  RefundError,
} from '@classytic/revenue';

try {
  await revenue.monetization.create({ amount: -100 });  // Invalid
} catch (error) {
  if (error instanceof InvalidAmountError) {
    console.error('Amount must be positive');
  } else if (error instanceof PaymentIntentCreationError) {
    console.error('Payment gateway failed:', error.message);
  }
}

// Or use Result type (no exceptions)
import { Result } from '@classytic/revenue';

const result = await revenue.execute(
  () => revenue.payments.verify(txId),
  { idempotencyKey: 'verify_123' }
);

if (result.ok) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

---

## TypeScript Support

Full type safety with auto-completion:

```typescript
import type {
  TransactionDocument,
  SubscriptionDocument,
  CommissionInfo,
  RevenueConfig,
} from '@classytic/revenue';

const transaction: TransactionDocument = await revenue.transactions.get(txId);
const commission: CommissionInfo = transaction.commission;
```

---

## Examples

- [Quick Start](./examples/01-quick-start.ts) - Basic setup and first payment
- [Subscriptions](./examples/02-subscriptions.ts) - Recurring billing
- [Escrow & Splits](./examples/03-escrow-splits.ts) - Marketplace payouts
- [Events & Plugins](./examples/04-events-plugins.ts) - Extend functionality
- [Transaction Model](./examples/05-transaction-model.ts) - Complete model setup
- [Resilience Patterns](./examples/06-resilience.ts) - Retry, circuit breaker

---

## Built-in Plugins

```typescript
import {
  loggingPlugin,
  auditPlugin,
  metricsPlugin,
  createTaxPlugin
} from '@classytic/revenue/plugins';

revenue
  .withPlugin(loggingPlugin({ level: 'info' }))
  .withPlugin(auditPlugin({
    store: async (entry) => {
      await AuditLog.create(entry);
    },
  }))
  .withPlugin(metricsPlugin({
    onMetric: (metric) => {
      statsd.timing(metric.name, metric.duration);
    },
  }))
  .withPlugin(createTaxPlugin({ ... }));
```

---

## Contributing

Contributions welcome! Open an issue or submit a pull request on [GitHub](https://github.com/classytic/revenue).

---

## License

MIT © [Classytic](https://github.com/classytic)

---

## Support

- 📖 [Documentation](https://github.com/classytic/revenue#readme)
- 🐛 [Issues](https://github.com/classytic/revenue/issues)
- 💬 [Discussions](https://github.com/classytic/revenue/discussions)
