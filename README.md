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
import type { ITransaction } from '@classytic/shared-types';
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
    sourceId: subscriptionId,     // optional: stored as sourceId
    sourceModel: 'Subscription',  // optional: stored as sourceModel
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
revenue.on('payment.verified', (event) => {
  console.log('Payment verified:', event.transaction._id);
});
```

Shared types are interfaces only. Define your own Transaction schema using `ITransaction` from `@classytic/shared-types` (no required common schema).

### One Model, Many Use Cases

The Transaction model is your **universal financial ledger**:

| Use Case | Category | Flow |
|----------|----------|------|
| Subscriptions | `platform_subscription` | `inflow` |
| One-time purchases | `product_order` | `inflow` |
| Course enrollments | `course_enrollment` | `inflow` |
| Refunds | `refund` | `outflow` |
| Operational expenses | `rent`, `salary`, etc. | `outflow` |

---

## Resilience Features

Production-ready payment systems require robust error handling. Revenue includes built-in retry logic and circuit breakers for all provider calls.

### Basic Configuration

```typescript
const revenue = Revenue
  .create({
    defaultCurrency: 'USD',
    // Retry configuration (optional)
    retry: {
      maxAttempts: 3,
      baseDelay: 1000,        // Initial delay: 1s
      maxDelay: 30000,        // Max delay: 30s
      backoffMultiplier: 2,   // Exponential backoff
      jitter: 0.1,            // 10% random jitter
    },
    // Circuit breaker configuration (optional)
    circuitBreaker: {
      failureThreshold: 5,    // Open after 5 failures
      resetTimeout: 30000,    // Try again after 30s
      successThreshold: 3,    // Close after 3 successes
    },
  })
  .withModels({ Transaction })
  .withProvider('stripe', stripeProvider)
  .build();
```

### How It Works

**Retry Logic**:
- Automatically retries failed provider calls (network errors, 5xx errors, rate limits)
- Uses exponential backoff with jitter to prevent thundering herd
- Configurable retry conditions via `retryIf` callback

**Circuit Breaker**:
- Prevents cascading failures by failing fast when provider is down
- Three states: `closed` (normal), `open` (failing fast), `half-open` (testing recovery)
- Automatically attempts recovery after `resetTimeout`

### What Gets Protected

All provider calls are automatically wrapped with resilience:

```typescript
// Payment verification - retries on transient failures
await revenue.payments.verify(transactionId);

// Refunds - fails fast if circuit is open
await revenue.payments.refund(transactionId, amount);

// Payment creation - retries with exponential backoff
await revenue.monetization.create({ ... });

// Status checks - protected by circuit breaker
await revenue.payments.getStatus(transactionId);
```

### Advanced: Custom Retry Logic

```typescript
const revenue = Revenue
  .create({
    retry: {
      maxAttempts: 5,
      retryIf: (error) => {
        // Custom retry logic
        if (error.message.includes('insufficient_funds')) {
          return false; // Don't retry business errors
        }
        return true; // Retry network/server errors
      },
      onRetry: (error, attempt, delay) => {
        console.log(`Retry ${attempt} after ${delay}ms:`, error.message);
      },
    },
  })
  .build();
```

### Monitoring Circuit Breaker

```typescript
import { createCircuitBreaker } from '@classytic/revenue/resilience';

const breaker = createCircuitBreaker({
  failureThreshold: 3,
  resetTimeout: 10000,
});

// Check circuit state
console.log(breaker.getState()); // 'closed' | 'open' | 'half-open'

// Use in Revenue
const revenue = Revenue
  .create({
    circuitBreaker: breaker, // Use shared instance
  })
  .build();
```

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

# Run tests (84 tests including integration)
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
