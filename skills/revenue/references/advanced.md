# Advanced Features

## Escrow & Splits

Hold funds, release to recipients, split across multiple parties (marketplace, affiliate).

### Hold Funds

```typescript
// Hold funds in escrow after payment
await revenue.escrow.hold(transactionId, {
  reason: 'payment_verification', // or 'fraud_check', 'manual_review', 'dispute', 'compliance'
  holdUntil: new Date('2025-02-01'),
});

// Get escrow status
const status = await revenue.escrow.getStatus(transactionId);

// Release from escrow
const release = await revenue.escrow.release(transactionId, {
  recipientId: 'vendor_123',
  recipientType: 'vendor',
  notes: 'Order fulfilled',
});

// Cancel hold
await revenue.escrow.cancel(transactionId);
```

### Split Funds

```typescript
// Split payment to multiple recipients
const split = await revenue.escrow.split(transactionId, [
  { recipientId: 'platform', recipientType: 'platform', percentage: 0.10, role: 'platform_commission' },
  { recipientId: 'vendor_1', recipientType: 'vendor', percentage: 0.85, role: 'vendor_payout' },
  { recipientId: 'affiliate_1', recipientType: 'affiliate', percentage: 0.05, role: 'affiliate_commission' },
]);
// split.splits: individual split records with amounts
```

### Split Enums

```typescript
SPLIT_TYPE = {
  PLATFORM_COMMISSION: 'platform_commission',
  AFFILIATE_COMMISSION: 'affiliate_commission',
  REFERRAL_COMMISSION: 'referral_commission',
  PARTNER_COMMISSION: 'partner_commission',
  CUSTOM: 'custom',
}

SPLIT_STATUS = {
  PENDING: 'pending',
  DUE: 'due',
  PAID: 'paid',
  WAIVED: 'waived',
  CANCELLED: 'cancelled',
}

HOLD_STATUS = {
  PENDING: 'pending',
  HELD: 'held',
  RELEASED: 'released',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PARTIALLY_RELEASED: 'partially_released',
}
```

## Settlement / Payouts

Track payouts from platform to vendors, affiliates, and partners.

```typescript
// Auto-create settlements from transaction splits
const settlements = await revenue.settlement.createFromSplits(transactionId);

// Schedule a manual payout
const payout = await revenue.settlement.schedule({
  recipientId: 'vendor_123',
  recipientType: 'vendor',
  amount: 5000,
  currency: 'USD',
  payoutMethod: 'bank_transfer',
  scheduledFor: new Date('2025-02-15'),
});

// Process pending settlements
const processed = await revenue.settlement.process();

// Mark settlement as completed
await revenue.settlement.complete(settlementId, {
  reference: 'WIRE-12345',
  paidAt: new Date(),
});

// Query settlements
const summary = await revenue.settlement.getSummary({
  recipientId: 'vendor_123',
});
```

### Payout Methods

```typescript
PAYOUT_METHOD = {
  BANK_TRANSFER: 'bank_transfer',
  MOBILE_WALLET: 'mobile_wallet',
  PLATFORM_BALANCE: 'platform_balance',
  CRYPTO: 'crypto',
  CHECK: 'check',
  MANUAL: 'manual',
}

SETTLEMENT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}
```

## Plugin System

Middleware-based extensibility with before/after hooks.

### Creating Plugins

```typescript
import { definePlugin } from '@classytic/revenue/plugins';
import type { RevenuePlugin, PluginContext } from '@classytic/revenue/plugins';

const myPlugin = definePlugin({
  name: 'my-plugin',
  version: '1.0.0',
  dependencies: ['audit'],  // optional: require other plugins

  hooks: {
    'payment.verify.before': async (ctx, input, next) => {
      ctx.logger.info('About to verify payment', { id: input.id });
      const result = await next();
      return result;
    },
    'payment.verify.after': async (ctx, input, next) => {
      const result = await next();
      ctx.logger.info('Payment verified', { status: result.status });
      return result;
    },
    'monetization.create.before': async (ctx, input, next) => {
      // Modify input, validate, rate-limit, etc.
      return next();
    },
  },

  events: {
    'payment.verified': async (event) => {
      // React to events
      await notifySlack(`Payment ${event.transaction._id} verified`);
    },
  },

  async init(ctx: PluginContext) {
    ctx.logger.info('Plugin initialized');
  },

  async destroy() {
    // Cleanup
  },
});
```

### Available Hook Points

All hooks follow the pattern `operation.action.before` / `operation.action.after`:

- `monetization.create.before/after`
- `payment.create.before/after`
- `payment.verify.before/after`
- `payment.refund.before/after`
- `subscription.create/activate/cancel/pause/resume.before/after`
- `transaction.create/update.before/after`
- `escrow.hold/release.before/after`

### Hook Function Signature

```typescript
type HookFn<TInput, TOutput> = (
  ctx: PluginContext,
  input: TInput,
  next: () => Promise<TOutput>,
) => Promise<TOutput>;

interface PluginContext {
  events: EventBus;
  logger: PluginLogger;
  storage: Map<string, unknown>;  // Share data between hooks
  meta: {
    idempotencyKey?: string;
    requestId: string;
    timestamp: Date;
  };
}
```

### Built-in Plugins

```typescript
import { loggingPlugin, auditPlugin, metricsPlugin, createTaxPlugin } from '@classytic/revenue/plugins';

// Logging — logs all operations
revenue.withPlugin(loggingPlugin({ level: 'info' }));

// Audit — track all state changes
revenue.withPlugin(auditPlugin({
  store: async (entry) => await AuditLog.create(entry),
}));

// Metrics — collect operation metrics
revenue.withPlugin(metricsPlugin({
  onMetric: (metric) => statsd.gauge(metric.name, metric.value),
}));

// Tax — automatic tax calculation
revenue.withPlugin(createTaxPlugin({
  getTaxConfig: async (orgId) => ({
    rate: 0.15,
    inclusive: false,
    jurisdiction: 'US-CA',
  }),
  incomeCategories: ['subscription', 'purchase'],
}));
```

## Retry & Circuit Breaker

All provider calls are automatically wrapped with resilience patterns.

### Retry Configuration

```typescript
Revenue.create({
  retry: {
    maxAttempts: 3,           // default: 1 (no retry)
    baseDelay: 1000,          // initial delay ms
    maxDelay: 30000,          // max delay cap ms
    backoffMultiplier: 2,     // exponential: delay * 2^(attempt-1)
    jitter: 0.1,              // 10% random jitter
    onRetry: (error, attempt, delay) => {
      console.warn(`Retry ${attempt} in ${delay}ms:`, error.message);
    },
  },
});
```

### Circuit Breaker

```typescript
Revenue.create({
  circuitBreaker: {
    failureThreshold: 5,      // open after 5 consecutive failures
    resetTimeout: 60000,      // try half-open after 60s
    successThreshold: 2,      // close after 2 successes in half-open
  },
});
// Or simply: circuitBreaker: true (uses defaults)
```

### Manual Resilience

```typescript
// Wrap any operation with retry + circuit breaker
const result = await revenue.execute(
  () => someExternalCall(),
  {
    idempotencyKey: 'unique-key',
    useRetry: true,
    useCircuitBreaker: true,
  },
);
// result: Result<T, Error> — use match() to handle

// Direct utility usage
import { retry, createCircuitBreaker } from '@classytic/revenue/utils';

const data = await retry(() => fetch(url), { maxAttempts: 3, baseDelay: 500 });

const breaker = createCircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 });
const result = await breaker.execute(() => riskyCall());
```

## Money Utility

Integer-based money calculations (avoids floating-point errors).

```typescript
import { Money } from '@classytic/revenue';

const price = Money.usd(2999);            // $29.99 (amount in cents)
price.format();                           // "$29.99"
price.multiply(0.9).format();             // "$26.99"
price.split(3);                           // Split evenly, handles remainder

// Calculators
import { calculateCommission, calculateTax, calculateSplits } from '@classytic/revenue/utils';

calculateCommission(10000, 0.10);         // 10% of $100
calculateTax(10000, 0.15, false);         // 15% tax, not inclusive
calculateSplits(10000, [
  { type: 'affiliate', rate: 0.05 },
  { type: 'partner', rate: 0.10 },
]);
```

## Result Type

Rust-inspired `Result<T, E>` for explicit error handling.

```typescript
import { ok, err, match, isOk, isErr } from '@classytic/revenue';

const result = await revenue.execute(() => someOperation());

match(result, {
  ok: (value) => console.log('Success:', value),
  err: (error) => console.error('Error:', error.message),
});

if (isOk(result)) {
  console.log(result.value);
}
```

## Error Classes

```typescript
import {
  RevenueError,                  // Base error
  ConfigurationError,            // Missing models/providers
  ProviderError,                 // Provider failure
  ProviderNotFoundError,         // Unknown provider name
  PaymentVerificationError,      // Verification failed
  TransactionNotFoundError,      // Transaction not found
  SubscriptionNotFoundError,     // Subscription not found
  AlreadyVerifiedError,          // Double verification attempt
  InvalidStateTransitionError,   // Invalid state machine transition
  ValidationError,               // Input validation failed
  RefundError,                   // Refund failed
  RefundNotSupportedError,       // Provider doesn't support refunds
  isRetryable,                   // Check if error is retryable
  isRevenueError,                // Type guard
  ERROR_CODES,                   // All error code constants
} from '@classytic/revenue';

// All errors include: code (string), retryable (boolean), metadata (object)
```

## Validation Schemas (Zod v4)

```typescript
import {
  CreatePaymentSchema,           // amount, currency, customerId, provider, ...
  VerifyPaymentSchema,           // id, provider?, data?
  RefundSchema,                  // transactionId, amount?, reason?
  CreateSubscriptionSchema,      // customerId, planKey, amount, interval, provider, ...
  CreateMonetizationSchema,      // unified: type, amount, provider, planKey?, ...
  CommissionConfigSchema,        // platformRate, gatewayFeeRate, splits?
  CreateHoldSchema,              // transactionId, amount?, reason?
  ReleaseHoldSchema,             // transactionId, recipientId, amount?, notes?
  ObjectIdSchema,                // MongoDB ObjectId
  CurrencySchema,                // ISO 4217 (3 chars)
  MoneyAmountSchema,             // Non-negative integer
} from '@classytic/revenue/schemas/validation';
```

## State Machines

All entities use centralized state machines preventing invalid transitions.

**Transaction**: `pending` → `payment_initiated` → `processing` → `verified` → `completed`. Can fail at any stage. Terminal: `failed`, `refunded`, `cancelled`, `expired`.

**Subscription**: `pending` → `active` ↔ `paused`. Terminal: `cancelled`, `expired`.

**Settlement**: `pending` → `processing` → `completed`. Can fail and retry.

**Hold**: `pending` → `held` → `released` (or `partially_released`). Terminal: `cancelled`, `expired`.

**Split**: `pending` → `due` → `paid`. Terminal: `waived`, `cancelled`.
