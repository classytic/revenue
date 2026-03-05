---
name: revenue
description: |
  @classytic/revenue — Enterprise revenue management for Node.js/TypeScript.
  Use when building payments, subscriptions, escrow, splits, settlements, refunds,
  webhooks, or multi-provider payment integrations with Mongoose/MongoDB.
  Triggers: revenue, payment, subscription, billing, monetization, escrow, hold,
  release, split, commission, affiliate, marketplace, refund, payout, settlement,
  stripe provider, bkash provider, sslcommerz provider, payment gateway, webhook,
  transaction ledger, recurring billing, proration, revenue management.
version: "1.1.3"
license: MIT
metadata:
  author: Classytic
tags:
  - revenue
  - payments
  - subscriptions
  - escrow
  - splits
  - settlements
  - monetization
  - providers
  - webhooks
  - typescript
  - mongoose
progressive_disclosure:
  entry_point:
    summary: "Payments, subscriptions, escrow, splits, settlements — pluggable providers, type-safe events, builder API."
    when_to_use: "Building payment flows, subscriptions, marketplace payouts, or custom payment provider integrations"
    quick_start: "1. npm install @classytic/revenue 2. Revenue.create().withModels({Transaction}).withProvider('stripe', stripeProvider).build() 3. revenue.monetization.create({...})"
  context_limit: 700
---

# @classytic/revenue

Enterprise revenue management with pluggable providers, subscriptions, escrow, splits, and settlements. Type-safe events, builder pattern, plugin middleware, resilience (retry + circuit breaker).

**Requires:** Node.js `>=18`, Mongoose `8.x || 9.x`, Zod `4.x`

## Installation

```bash
npm install @classytic/revenue

# Peer dependencies
npm install mongoose zod

# Optional: manual payment provider
npm install @classytic/revenue-manual
```

## Quick Start

```typescript
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import { Transaction } from './models/transaction'; // Your Mongoose model

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('manual', new ManualProvider())
  .withCommission(0.10, 0.029) // 10% platform, 2.9% gateway fee
  .build();

// Create a purchase
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: {
    organizationId: 'org_123',
    customerId: 'cust_456',
    sourceId: 'order_789',
    sourceModel: 'Order',
  },
  monetizationType: 'purchase',
  amount: 2999,
  gateway: 'manual',
});

// Verify payment (admin confirms receipt)
const result = await revenue.payments.verify(paymentIntent.id);

// Listen to events
revenue.on('payment.verified', (event) => {
  console.log('Paid:', event.transaction._id);
});
```

## RevenueBuilder API

```typescript
const revenue = Revenue
  .create(options?: RevenueOptions)
  .withModels({ Transaction, Subscription? })     // Mongoose models
  .withModel('Transaction', TransactionModel)      // Single model
  .withProvider('stripe', stripeProvider)           // Register provider
  .withProviders({ stripe, manual })               // Register multiple
  .withPlugin(loggingPlugin())                     // Add plugin
  .withPlugins([auditPlugin(), metricsPlugin()])   // Add multiple
  .withRetry({ maxAttempts: 3, baseDelay: 1000 })  // Retry config
  .withCircuitBreaker(true)                        // Circuit breaker
  .withLogger(customLogger)                        // Pluggable logger
  .forEnvironment('production')                    // dev/staging/production
  .withDebug(false)                                // Debug logging
  .withCommission(0.10, 0.029)                     // Platform + gateway rates
  .withCategoryMappings({                          // Map entity → category
    PlatformSubscription: 'platform_subscription',
    CourseEnrollment: 'course_enrollment',
  })
  .withTransactionTypeMapping({                    // Map category → flow
    platform_subscription: 'inflow',
    refund: 'outflow',
  })
  .build();
```

### RevenueOptions

```typescript
interface RevenueOptions {
  defaultCurrency?: string;          // ISO 4217 (default: 'USD')
  environment?: 'development' | 'staging' | 'production';
  debug?: boolean;
  retry?: Partial<RetryConfig>;
  idempotencyTtl?: number;           // ms (default: 86400000 = 24h)
  circuitBreaker?: Partial<CircuitBreakerConfig> | boolean;
  logger?: PluginLogger;
  commissionRate?: number;           // 0-1 decimal (0.10 = 10%)
  gatewayFeeRate?: number;           // 0-1 decimal (0.029 = 2.9%)
}
```

## Revenue Instance API

| Property / Method | Description |
|---|---|
| `monetization` | MonetizationService — create purchases, subscriptions |
| `payments` | PaymentService — verify, refund, webhooks |
| `transactions` | TransactionService — query, update transactions |
| `escrow` | EscrowService — hold, release, split funds |
| `settlement` | SettlementService — payout tracking |
| `on(event, handler)` | Subscribe to events (returns unsubscribe fn) |
| `once(event, handler)` | Subscribe once |
| `execute(operation, opts?)` | Run with retry + circuit breaker → `Result<T>` |
| `destroy()` | Cleanup resources |

## MonetizationService

Create purchases, subscriptions, and free items.

```typescript
// One-time purchase
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: {
    organizationId: 'org_123',
    customerId: 'cust_456',
    sourceId: 'order_789',
    sourceModel: 'Order',
  },
  monetizationType: 'purchase',  // 'purchase' | 'subscription' | 'free'
  amount: 4999,
  currency: 'USD',               // optional, uses defaultCurrency
  gateway: 'stripe',
  entity: 'ProductOrder',        // maps to category via categoryMappings
  idempotencyKey: 'purchase-order789',
});

// Subscription
const sub = await revenue.monetization.create({
  data: {
    organizationId: 'org_123',
    customerId: 'cust_456',
    sourceId: subscriptionId,
    sourceModel: 'Subscription',
  },
  monetizationType: 'subscription',
  planKey: 'monthly',            // 'monthly' | 'quarterly' | 'yearly'
  amount: 2999,
  gateway: 'stripe',
});

// Free item (no payment intent created)
const free = await revenue.monetization.create({
  data: { organizationId: 'org_123', customerId: 'cust_456',
          sourceId: 'trial_1', sourceModel: 'Trial' },
  monetizationType: 'free',
  amount: 0,
  gateway: 'manual',
});
```

### Subscription Lifecycle

```typescript
await revenue.monetization.activate(subscriptionId);
await revenue.monetization.renew(subscriptionId);
await revenue.monetization.pause(subscriptionId);
await revenue.monetization.resume(subscriptionId);
await revenue.monetization.cancel(subscriptionId, { immediate: true, reason: 'user_request' });
```

## PaymentService

Verify payments, process refunds, handle webhooks.

```typescript
// Verify payment (after customer pays)
const result = await revenue.payments.verify(paymentIntentId);
// result.status: 'verified' | 'failed' | 'processing' | 'requires_action'

// Check payment status
const status = await revenue.payments.getStatus(paymentIntentId);

// Full refund
const refund = await revenue.payments.refund(paymentIntentId);
// refund.transaction.status === 'refunded'
// refund.refundTransaction.flow === 'outflow'

// Partial refund
const partial = await revenue.payments.refund(paymentIntentId, 1000, {
  reason: 'customer_request',
});
// partial.transaction.status === 'partially_refunded'
```

### Webhook Handling

```typescript
// Express/Fastify route handler
app.post('/webhooks/stripe', async (req, res) => {
  const result = await revenue.payments.handleWebhook(
    'stripe',                    // provider name
    req.body,                    // raw payload
    req.headers,                 // for signature verification
  );
  // result.event.type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded'
  // result.transaction: updated transaction document
  res.sendStatus(200);
});
```

## TransactionService

```typescript
const tx = await revenue.transactions.getById(transactionId);
const txs = await revenue.transactions.find({ organizationId: 'org_123', status: 'verified' });
const list = await revenue.transactions.list({ page: 1, limit: 20 });
const sum = await revenue.transactions.sumByFilter({ organizationId: 'org_123', flow: 'inflow' });
```

## Events

Type-safe pub/sub for all revenue operations.

```typescript
// Payment events
revenue.on('payment.verified', (e) => { /* e.transaction, e.paymentResult */ });
revenue.on('payment.failed', (e) => { /* e.transaction, e.error, e.provider */ });
revenue.on('payment.refunded', (e) => { /* e.transaction */ });
revenue.on('payment.processing', (e) => { /* ... */ });
revenue.on('payment.requires_action', (e) => { /* ... */ });

// Monetization events
revenue.on('monetization.created', (e) => { /* e.transaction */ });
revenue.on('purchase.created', (e) => { /* ... */ });
revenue.on('free.created', (e) => { /* ... */ });

// Subscription events
revenue.on('subscription.created', (e) => { /* ... */ });
revenue.on('subscription.activated', (e) => { /* ... */ });
revenue.on('subscription.renewed', (e) => { /* ... */ });
revenue.on('subscription.cancelled', (e) => { /* ... */ });
revenue.on('subscription.paused', (e) => { /* ... */ });
revenue.on('subscription.resumed', (e) => { /* ... */ });

// Escrow events
revenue.on('escrow.held', (e) => { /* ... */ });
revenue.on('escrow.released', (e) => { /* ... */ });
revenue.on('escrow.split', (e) => { /* ... */ });

// Settlement events
revenue.on('settlement.completed', (e) => { /* ... */ });

// Webhook events
revenue.on('webhook.processed', (e) => { /* e.event, e.transaction */ });

// Wildcard — catch all
revenue.on('*', (e) => { /* e.type, e.timestamp */ });
```

All events auto-inject `type` (string) and `timestamp` (Date).

## Building Custom Providers

Extend `PaymentProvider` — implement 5 methods:

```typescript
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue/providers';
import type { CreateIntentParams, ProviderCapabilities } from '@classytic/revenue/providers';

class StripeProvider extends PaymentProvider {
  private stripe: Stripe;

  constructor(config: { apiKey: string; webhookSecret: string }) {
    super(config);
    this.name = 'stripe';
    this.stripe = new Stripe(config.apiKey);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const intent = await this.stripe.paymentIntents.create({
      amount: params.amount,
      currency: params.currency ?? this.defaultCurrency,
    });
    return new PaymentIntent({
      id: intent.id,
      paymentIntentId: intent.id,
      sessionId: null,
      provider: this.name,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      clientSecret: intent.client_secret!,  // for Stripe Elements
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
      id: refund.id, provider: this.name,
      status: refund.status === 'succeeded' ? 'succeeded' : 'failed',
      amount: refund.amount, currency: refund.currency,
      refundedAt: new Date(), metadata: {},
    });
  }

  async handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<WebhookEvent> {
    const sig = headers?.['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      payload as string, sig!, this.config.webhookSecret as string,
    );
    return new WebhookEvent({
      id: event.id, provider: this.name, type: event.type,
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

### Provider Response Types

| Class | Key Fields |
|---|---|
| `PaymentIntent` | `id`, `sessionId`, `paymentIntentId`, `provider`, `status`, `amount`, `currency`, `clientSecret?`, `paymentUrl?`, `instructions?` |
| `PaymentResult` | `id`, `provider`, `status` (`succeeded`/`failed`/`processing`/`requires_action`), `amount?`, `paidAt?` |
| `RefundResult` | `id`, `provider`, `status` (`succeeded`/`failed`/`processing`), `amount?`, `refundedAt?`, `reason?` |
| `WebhookEvent` | `id`, `provider`, `type`, `data` (`sessionId?`, `paymentIntentId?`), `createdAt?` |

### Provider Patterns

- **Client-secret (Stripe)**: Return `clientSecret` in PaymentIntent for frontend confirmation
- **Redirect (SSLCommerz)**: Return `paymentUrl` in PaymentIntent for gateway redirect
- **Manual**: Return `instructions` in PaymentIntent; admin calls `verify()` after receipt
- **Mobile wallet (bKash)**: Return `paymentUrl` for deep-link or QR code flow

## Enums

```typescript
import {
  TRANSACTION_STATUS,        // pending, payment_initiated, processing, verified, completed, failed, refunded, ...
  TRANSACTION_FLOW,          // inflow, outflow
  PAYMENT_STATUS,            // pending, verified, failed, refunded, cancelled
  PAYMENT_GATEWAY_TYPE,      // manual, stripe, sslcommerz (extensible)
  SUBSCRIPTION_STATUS,       // active, paused, cancelled, expired, pending, pending_renewal
  PLAN_KEYS,                 // monthly, quarterly, yearly
  MONETIZATION_TYPES,        // free, purchase, subscription
  HOLD_STATUS,               // pending, held, released, cancelled, partially_released
  SPLIT_TYPE,                // platform_commission, affiliate_commission, referral_commission, custom
  SPLIT_STATUS,              // pending, due, paid, waived, cancelled
  SETTLEMENT_STATUS,         // pending, processing, completed, failed, cancelled
  PAYOUT_METHOD,             // bank_transfer, mobile_wallet, platform_balance, crypto, manual
} from '@classytic/revenue/enums';
```

## Subpath Imports

```typescript
// Main (everything)
import { Revenue, PaymentProvider, Money, ... } from '@classytic/revenue';

// Core only
import { Revenue, RevenueBuilder, EventBus } from '@classytic/revenue/core';

// Providers only
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue/providers';

// Enums only
import { TRANSACTION_STATUS, PAYMENT_STATUS, ... } from '@classytic/revenue/enums';

// Events only
import { EventBus } from '@classytic/revenue/events';

// Plugins
import { loggingPlugin, auditPlugin, metricsPlugin, createTaxPlugin, definePlugin } from '@classytic/revenue/plugins';

// Services (advanced)
import { MonetizationService, PaymentService, TransactionService } from '@classytic/revenue/services';

// Schemas (Mongoose subdocument schemas)
import { gatewaySchema, commissionSchema, holdSchema, splitSchema } from '@classytic/revenue/schemas';

// Validation (Zod v4)
import { CreatePaymentSchema, RefundSchema, CreateSubscriptionSchema } from '@classytic/revenue/schemas/validation';

// Utilities
import { Money, calculateCommission, calculateSplits, retry, createCircuitBreaker } from '@classytic/revenue/utils';
```

## References (Progressive Disclosure)

- **[providers](references/providers.md)** — Building custom providers (Stripe, SSLCommerz, bKash patterns), webhook signature verification, provider capabilities
- **[advanced](references/advanced.md)** — Escrow & splits, settlement/payouts, plugin system, retry & circuit breaker, tax plugin, Money utility, Result type, error classes, validation schemas
