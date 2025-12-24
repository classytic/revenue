# @classytic/revenue

> Modern, Type-safe Revenue Management for Node.js

Enterprise-grade library for subscriptions, payments, escrow, and multi-party splits. Built with TypeScript, Zod validation, and resilience patterns.

## Installation

```bash
npm install @classytic/revenue @classytic/revenue-manual
```

## Quick Start

### Fluent Builder API (Recommended)

```typescript
import { Revenue, Money, loggingPlugin } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction, Subscription })
  .withProvider('manual', new ManualProvider())
  .withProvider('stripe', new StripeProvider({ apiKey: '...' }))
  .withPlugin(loggingPlugin())
  .withRetry({ maxAttempts: 3, baseDelay: 1000 })
  .withCircuitBreaker()
  .withCommission(10, 2.5) // 10% platform, 2.5% gateway fee
  .forEnvironment('production')
  .build();

// Access services
await revenue.monetization.create({ ... });
await revenue.payments.verify(transactionId);
await revenue.escrow.hold(transactionId);
```

### Shorthand Factory

```typescript
import { createRevenue } from '@classytic/revenue';

const revenue = createRevenue({
  models: { Transaction, Subscription },
  providers: { manual: new ManualProvider() },
  options: { defaultCurrency: 'USD' },
});
```

---

## Core Concepts

### Money (Integer-Safe Currency)

```typescript
import { Money } from '@classytic/revenue';

// Create from cents (safe)
const price = Money.usd(1999);        // $19.99
const price2 = Money.of(19.99, 'USD'); // Auto-converts to 1999 cents

// Arithmetic
const discounted = price.multiply(0.9);  // 10% off
const withTax = price.add(Money.usd(200));
const perPerson = price.divide(3);

// Format
console.log(price.format());      // "$19.99"
console.log(price.toUnit());      // 19.99
console.log(price.amount);        // 1999 (integer cents)

// Split fairly (handles rounding)
const [a, b, c] = Money.usd(100).allocate([1, 1, 1]); // [34, 33, 33] cents
```

### Result Type (No Throws)

```typescript
import { Result, ok, err, match } from '@classytic/revenue';

// Execute with Result
const result = await revenue.execute(
  () => riskyOperation(),
  { idempotencyKey: 'order_123' }
);

// Pattern matching
match(result, {
  ok: (value) => console.log('Success:', value),
  err: (error) => console.log('Error:', error.message),
});

// Or simple check
if (result.ok) {
  console.log(result.value);
} else {
  console.log(result.error);
}
```

### Type-Safe Events

```typescript
// Subscribe to events
revenue.on('payment.succeeded', (event) => {
  console.log('Transaction:', event.transactionId);
  console.log('Amount:', event.transaction.amount);
});

revenue.on('subscription.renewed', (event) => {
  sendEmail(event.subscription.customerId, 'Renewed!');
});

revenue.on('escrow.released', (event) => {
  console.log('Released:', event.releasedAmount);
});

// Wildcard - catch all events
revenue.on('*', (event) => {
  analytics.track(event.type, event);
});
```

### Validation (Zod v4)

```typescript
import {
  CreatePaymentSchema,
  PaymentEntrySchema,
  CurrentPaymentInputSchema,
  validate,
  safeValidate,
  validateSplitPayments,
} from '@classytic/revenue';

// Validate input (throws on error)
const payment = validate(CreatePaymentSchema, userInput);

// Safe validation (returns result)
const result = safeValidate(CreatePaymentSchema, userInput);
if (!result.success) {
  console.log(result.error.issues);
}

// Split payment validation
const splitResult = safeValidate(CurrentPaymentInputSchema, {
  amount: 50000,
  method: 'split',
  payments: [
    { method: 'cash', amount: 25000 },
    { method: 'bkash', amount: 25000 },
  ],
});
```

---

## Services

### Monetization (Purchases & Subscriptions)

```typescript
// One-time purchase
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: {
    customerId: user._id,
    organizationId: org._id,
    referenceId: order._id,
    referenceModel: 'Order',
  },
  planKey: 'one_time',
  monetizationType: 'purchase',
  amount: 1500,
  gateway: 'manual',
  paymentData: { method: 'card' },
});

// Recurring subscription
const { subscription, transaction } = await revenue.monetization.create({
  data: { customerId: user._id },
  planKey: 'monthly',
  monetizationType: 'subscription',
  amount: 2999,
  gateway: 'stripe',
});

// Lifecycle management
await revenue.monetization.activate(subscription._id);
await revenue.monetization.renew(subscription._id, { gateway: 'stripe' });
await revenue.monetization.pause(subscription._id, { reason: 'Vacation' });
await revenue.monetization.resume(subscription._id);
await revenue.monetization.cancel(subscription._id, { immediate: true });
```

### Payments

```typescript
// Verify payment
const { transaction, paymentResult } = await revenue.payments.verify(
  transactionId,
  { verifiedBy: adminId }
);

// Get status
const { status, provider } = await revenue.payments.getStatus(transactionId);

// Full refund
const { refundTransaction } = await revenue.payments.refund(transactionId);

// Partial refund
const { refundTransaction } = await revenue.payments.refund(
  transactionId,
  500, // Amount in cents
  { reason: 'Partial return' }
);

// Handle webhook
const { event, transaction } = await revenue.payments.handleWebhook(
  'stripe',
  payload,
  headers
);
```

### Escrow (Hold/Release)

```typescript
// Hold funds in escrow
await revenue.escrow.hold(transactionId, {
  holdUntil: new Date('2024-12-31'),
  reason: 'Awaiting delivery confirmation',
});

// Release to recipient
await revenue.escrow.release(transactionId, {
  recipientId: vendorId,
  recipientType: 'organization',
  amount: 800, // Partial release
});

// Multi-party split
await revenue.escrow.split(transactionId, [
  { type: 'platform_commission', recipientId: 'platform', rate: 0.10 },
  { type: 'affiliate_commission', recipientId: 'aff_123', rate: 0.05 },
]);

// Cancel hold
await revenue.escrow.cancelHold(transactionId, { reason: 'Order cancelled' });
```

---

## Plugins

```typescript
import { loggingPlugin, auditPlugin, metricsPlugin, definePlugin } from '@classytic/revenue';

// Built-in plugins
const revenue = Revenue
  .create()
  .withPlugin(loggingPlugin({ level: 'info' }))
  .withPlugin(auditPlugin({ store: saveToDatabase }))
  .withPlugin(metricsPlugin({ onMetric: sendToDatadog }))
  .build();

// Custom plugin
const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  hooks: {
    'payment.create.before': async (ctx, input, next) => {
      if (await isRateLimited(input.customerId)) {
        throw new Error('Rate limited');
      }
      return next();
    },
  },
});
```

---

## Resilience

### Retry with Exponential Backoff

```typescript
import { retry, retryWithResult, isRetryableError } from '@classytic/revenue';

// Simple retry
const data = await retry(
  () => fetchPaymentStatus(id),
  {
    maxAttempts: 5,
    baseDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    jitter: 0.1,
  }
);

// Retry with Result (no throws)
const result = await retryWithResult(() => processPayment());
if (!result.ok) {
  console.log('All retries failed:', result.error.errors);
}
```

### Circuit Breaker

```typescript
import { CircuitBreaker, createCircuitBreaker } from '@classytic/revenue';

const breaker = createCircuitBreaker({
  failureThreshold: 5,
  resetTimeout: 30000,
});

const result = await breaker.execute(() => callExternalAPI());

// Check state
console.log(breaker.getState()); // 'closed' | 'open' | 'half-open'
```

### Idempotency

```typescript
import { IdempotencyManager } from '@classytic/revenue';

const idempotency = new IdempotencyManager({ ttl: 86400000 }); // 24h

const result = await idempotency.execute(
  'payment_order_123',
  { amount: 1999, customerId: 'cust_1' },
  () => chargeCard()
);

// Same key + same params = cached result
// Same key + different params = error
```

---

## Transaction Model Setup

**ONE Transaction model = Universal Financial Ledger**

The Transaction model is the ONLY required model. Use it for subscriptions, purchases, refunds, and operational expenses. The Subscription model is **optional** (only for tracking subscription state).

```typescript
import mongoose from 'mongoose';
import {
  // Enums
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS_VALUES,
  // Mongoose schemas (compose into your model)
  gatewaySchema,
  paymentDetailsSchema,
  commissionSchema,
  holdSchema,
  splitSchema,
} from '@classytic/revenue';

// Your app-specific categories
const CATEGORIES = [
  'platform_subscription',
  'course_enrollment',
  'product_order',
  'refund',
  'rent',
  'salary',
  'utilities',
];

const transactionSchema = new mongoose.Schema({
  // Core fields
  organizationId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, index: true },
  type: { type: String, enum: TRANSACTION_TYPE_VALUES, required: true }, // income | expense
  category: { type: String, enum: CATEGORIES, index: true },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, default: 'pending' },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD' },
  method: { type: String, required: true },

  // Library schemas (compose, don't spread)
  gateway: gatewaySchema,
  commission: commissionSchema,
  paymentDetails: paymentDetailsSchema,
  hold: holdSchema,
  splits: [splitSchema],

  // Polymorphic reference (link to any entity)
  referenceId: { type: mongoose.Schema.Types.ObjectId, refPath: 'referenceModel' },
  referenceModel: { type: String, enum: ['Subscription', 'Order', 'Enrollment'] },

  // Idempotency & verification
  idempotencyKey: { type: String, unique: true, sparse: true },
  verifiedAt: Date,
  verifiedBy: mongoose.Schema.Types.Mixed, // ObjectId or 'system'
  
  // Refunds
  refundedAmount: Number,
  refundedAt: Date,

  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

export const Transaction = mongoose.model('Transaction', transactionSchema);
```

### Available Schemas

| Schema | Purpose | Usage |
|--------|---------|-------|
| `gatewaySchema` | Payment gateway details | `gateway: gatewaySchema` |
| `commissionSchema` | Platform commission | `commission: commissionSchema` |
| `paymentDetailsSchema` | Manual payment info | `paymentDetails: paymentDetailsSchema` |
| `holdSchema` | Escrow hold/release | `hold: holdSchema` |
| `splitSchema` | Multi-party splits | `splits: [splitSchema]` |
| `currentPaymentSchema` | For Order/Subscription models | `currentPayment: currentPaymentSchema` |
| `paymentEntrySchema` | Individual payment in split payments | Used within `currentPaymentSchema.payments` |

**Usage:** Import and use as nested objects (NOT spread):

```typescript
import { gatewaySchema, commissionSchema } from '@classytic/revenue';

const schema = new mongoose.Schema({
  gateway: gatewaySchema,     // ✅ Correct - nested
  commission: commissionSchema,
  // ...gatewaySchema,        // ❌ Wrong - don't spread
});
```

---

## Group Payments (Split Pay)

Multiple payers can contribute to one purchase using `referenceId`:

```typescript
// Order total: $100 (10000 cents)
const orderId = new mongoose.Types.ObjectId();
const orderTotal = 10000;

// Friend 1 pays $40
await revenue.monetization.create({
  data: {
    customerId: friend1,
    organizationId: restaurantId,
    referenceId: orderId,
    referenceModel: 'Order',
  },
  planKey: 'split_payment',
  monetizationType: 'purchase',
  amount: 4000,
  gateway: 'stripe',
  metadata: { splitGroup: 'dinner_dec_10' },
});

// Friend 2 pays $35
await revenue.monetization.create({
  data: {
    customerId: friend2,
    organizationId: restaurantId,
    referenceId: orderId,
    referenceModel: 'Order',
  },
  planKey: 'split_payment',
  monetizationType: 'purchase',
  amount: 3500,
  gateway: 'stripe',
  metadata: { splitGroup: 'dinner_dec_10' },
});

// Friend 3 pays $25
await revenue.monetization.create({
  data: {
    customerId: friend3,
    organizationId: restaurantId,
    referenceId: orderId,
    referenceModel: 'Order',
  },
  planKey: 'split_payment',
  monetizationType: 'purchase',
  amount: 2500,
  gateway: 'stripe',
  metadata: { splitGroup: 'dinner_dec_10' },
});
```

### Check Payment Status

```typescript
// Get all contributions for an order
const contributions = await Transaction.find({
  referenceId: orderId,
  referenceModel: 'Order',
});

// Calculate totals
const verified = contributions.filter(t => t.status === 'verified');
const totalPaid = verified.reduce((sum, t) => sum + t.amount, 0);
const remaining = orderTotal - totalPaid;
const isFullyPaid = totalPaid >= orderTotal;

console.log({
  totalPaid,      // 10000
  remaining,      // 0
  isFullyPaid,    // true
  payers: verified.map(t => ({
    customerId: t.customerId,
    amount: t.amount,
    paidAt: t.verifiedAt,
  })),
});
```

### Query by Split Group

```typescript
// Find all payments in a split group
const groupPayments = await Transaction.find({
  'metadata.splitGroup': 'dinner_dec_10',
});

// Pending payers
const pending = await Transaction.find({
  referenceId: orderId,
  status: 'pending',
});
```

---

## Multi-Payment Method Support (POS)

For POS scenarios where customers pay using multiple methods (e.g., cash + bank + mobile wallet):

### Schema Structure

```typescript
import { currentPaymentSchema, paymentEntrySchema } from '@classytic/revenue';

// currentPaymentSchema now supports a `payments` array for split payments
const orderSchema = new mongoose.Schema({
  currentPayment: currentPaymentSchema,
  // ...
});
```

### Single Payment (Backward Compatible)

```typescript
// Traditional single-method payment
currentPayment: {
  amount: 50000,  // 500 BDT in paisa
  method: 'cash',
  status: 'verified',
  verifiedAt: new Date(),
  verifiedBy: cashierId,
}
```

### Split Payment (Multiple Methods)

```typescript
// Customer pays 500 BDT using: 100 cash + 100 bank + 300 bKash
currentPayment: {
  amount: 50000,  // Total: 500 BDT
  method: 'split',
  status: 'verified',
  payments: [
    { method: 'cash', amount: 10000 },                                    // 100 BDT
    { method: 'bank_transfer', amount: 10000, reference: 'TRF123' },      // 100 BDT
    { method: 'bkash', amount: 30000, reference: 'TRX456', details: { walletNumber: '01712345678' } }, // 300 BDT
  ],
  verifiedAt: new Date(),
  verifiedBy: cashierId,
}
```

### Validation

```typescript
import {
  CurrentPaymentInputSchema,
  PaymentEntrySchema,
  validateSplitPayments,
  safeValidate,
} from '@classytic/revenue';

// Zod validation (automatically validates totals match)
const result = safeValidate(CurrentPaymentInputSchema, paymentInput);
if (!result.success) {
  console.log(result.error.issues); // "Split payments total must equal the transaction amount"
}

// Helper function for runtime validation
const isValid = validateSplitPayments({
  amount: 50000,
  payments: [
    { amount: 10000 },
    { amount: 10000 },
    { amount: 30000 },
  ],
}); // true - totals match
```

### TypeScript Types

```typescript
import type { PaymentEntry, CurrentPayment } from '@classytic/revenue';

const entry: PaymentEntry = {
  method: 'bkash',
  amount: 30000,
  reference: 'TRX456',
  details: { walletNumber: '01712345678' },
};

const payment: CurrentPayment = {
  amount: 50000,
  method: 'split',
  status: 'verified',
  payments: [entry],
};
```

---

## Building Custom Providers

```typescript
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue';
import type { CreateIntentParams, ProviderCapabilities } from '@classytic/revenue';

export class StripeProvider extends PaymentProvider {
  public override readonly name = 'stripe';
  private stripe: Stripe;

  constructor(config: { apiKey: string }) {
    super(config);
    this.stripe = new Stripe(config.apiKey);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const intent = await this.stripe.paymentIntents.create({
      amount: params.amount,
      currency: params.currency ?? 'usd',
      metadata: params.metadata,
    });

    return new PaymentIntent({
      id: intent.id,
      paymentIntentId: intent.id,
      sessionId: null,
      provider: this.name,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      clientSecret: intent.client_secret!,
      metadata: params.metadata ?? {},
    });
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const intent = await this.stripe.paymentIntents.retrieve(intentId);
    return new PaymentResult({
      id: intent.id,
      provider: this.name,
      status: intent.status === 'succeeded' ? 'succeeded' : 'failed',
      amount: intent.amount,
      currency: intent.currency,
      paidAt: intent.status === 'succeeded' ? new Date() : undefined,
      metadata: {},
    });
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create({
      payment_intent: paymentId,
      amount: amount ?? undefined,
    });

    return new RefundResult({
      id: refund.id,
      provider: this.name,
      status: refund.status === 'succeeded' ? 'succeeded' : 'failed',
      amount: refund.amount,
      currency: refund.currency,
      refundedAt: new Date(),
      metadata: {},
    });
  }

  async handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<WebhookEvent> {
    const sig = headers?.['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      payload as string,
      sig!,
      this.config.webhookSecret as string
    );

    return new WebhookEvent({
      id: event.id,
      provider: this.name,
      type: event.type,
      data: event.data.object as any,
      createdAt: new Date(event.created * 1000),
    });
  }

  override getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }
}
```

---

## Error Handling

```typescript
import {
  RevenueError,
  TransactionNotFoundError,
  AlreadyVerifiedError,
  RefundError,
  ProviderNotFoundError,
  ValidationError,
  isRevenueError,
  isRetryable,
} from '@classytic/revenue';

try {
  await revenue.payments.verify(id);
} catch (error) {
  if (error instanceof AlreadyVerifiedError) {
    console.log('Already verified:', error.metadata.transactionId);
  } else if (error instanceof TransactionNotFoundError) {
    console.log('Not found');
  } else if (isRevenueError(error) && isRetryable(error)) {
    // Retry the operation
  }
}
```

---

## TypeScript

Full TypeScript support with exported types:

```typescript
import type {
  Revenue,
  TransactionDocument,
  SubscriptionDocument,
  PaymentProviderInterface,
  CreateIntentParams,
  ProviderCapabilities,
  RevenueEvents,
  MonetizationCreateParams,
  // Multi-payment types
  PaymentEntry,
  CurrentPayment,
  PaymentEntryInput,
  CurrentPaymentInput,
} from '@classytic/revenue';
```

### Type Guards

Runtime type checking for all enum values:

```typescript
import {
  isTransactionType,
  isTransactionStatus,
  isPaymentStatus,
  isSubscriptionStatus,
  isMonetizationType,
  isHoldStatus,
  isSplitType,
} from '@classytic/revenue';

// Validate and narrow types at runtime
if (isTransactionStatus(userInput)) {
  // userInput is narrowed to TransactionStatusValue
  console.log('Valid status:', userInput);
}

// Useful for API input validation
function processPayment(status: unknown) {
  if (!isPaymentStatus(status)) {
    throw new Error('Invalid payment status');
  }
  // status is now typed as PaymentStatusValue
}
```

**Available type guards:**

| Guard | Validates |
|-------|-----------|
| `isTransactionType` | `'income'` \| `'expense'` |
| `isTransactionStatus` | `'pending'` \| `'verified'` \| `'completed'` \| ... |
| `isLibraryCategory` | `'subscription'` \| `'purchase'` |
| `isPaymentStatus` | `'pending'` \| `'succeeded'` \| `'failed'` \| ... |
| `isPaymentGatewayType` | `'manual'` \| `'automatic'` |
| `isGatewayType` | `'redirect'` \| `'direct'` \| `'webhook'` |
| `isSubscriptionStatus` | `'active'` \| `'paused'` \| `'cancelled'` \| ... |
| `isPlanKey` | `'monthly'` \| `'yearly'` \| `'one_time'` \| ... |
| `isMonetizationType` | `'subscription'` \| `'purchase'` |
| `isHoldStatus` | `'held'` \| `'released'` \| `'partially_released'` \| ... |
| `isReleaseReason` | `'completed'` \| `'cancelled'` \| `'refunded'` \| ... |
| `isHoldReason` | `'escrow'` \| `'dispute'` \| `'verification'` \| ... |
| `isSplitType` | `'platform_commission'` \| `'affiliate_commission'` \| ... |
| `isSplitStatus` | `'pending'` \| `'processed'` \| `'failed'` |
| `isPayoutMethod` | `'bank_transfer'` \| `'wallet'` \| `'manual'` |

---

## Testing

```bash
# Run all tests (196 tests)
npm test

# Run integration tests (requires MongoDB)
npm test -- tests/integration/

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

---

## License

MIT © [Classytic](https://github.com/classytic)
