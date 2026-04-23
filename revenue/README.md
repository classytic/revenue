# @classytic/revenue v2

> Payment lifecycle engine — transactions, subscriptions, escrow, settlements, commissions.

MongoKit repositories with domain verbs. Arc-compatible event transport. No service layer — repositories ARE the API.

---

## Install

```bash
npm install @classytic/revenue @classytic/mongokit mongoose zod
npm install @classytic/revenue-manual  # built-in manual provider
```

## Quick Start

```typescript
import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = await createRevenue({
  connection: mongoose.connection,
  defaultCurrency: 'BDT',
  providers: { manual: new ManualProvider() },
});

// Create payment — returns raw mongokit doc
const txn = await revenue.repositories.transaction.createPaymentIntent({
  amount: 10000,
  gateway: 'manual',
  data: { customerId: 'cust_1', sourceId: 'order_1', sourceModel: 'Order' },
});
// txn.publicId → 'txn_a7b3xk9m2p1q4d5e6f'
// txn.gateway.metadata.instructions → 'Payment Amount: 10000 BDT...'

// Verify (admin approves manual payment)
const verified = await revenue.repositories.transaction.verify(
  txn.gateway.paymentIntentId,
  { verifiedBy: 'admin_1' },
);
// verified.status → 'verified'

// Refund — returns the refund transaction doc
const refundTxn = await revenue.repositories.transaction.refund(
  txn._id.toString(), 5000, { reason: 'partial return' },
);
// refundTxn.type → 'refund', refundTxn.flow → 'outflow', refundTxn.amount → 5000
```

## Architecture

```
createRevenue(config) --> RevenueEngine
  |
  |-- repositories.transaction       extends mongokit Repository
  |     getAll, getById, getByQuery, create, update, delete, count  (inherited)
  |     createPaymentIntent, verify, refund, handleWebhook          (domain verbs)
  |     hold, release, split                                        (escrow verbs)
  |
  |-- repositories.subscription      extends mongokit Repository
  |     getAll, getById, create, update, delete, count              (inherited)
  |     activate, cancel, pause, resume                             (domain verbs)
  |
  |-- repositories.settlement        extends mongokit Repository
  |     getAll, getById, create, update, delete, count              (inherited)
  |     schedule, processPending, complete, fail                    (domain verbs)
  |
  |-- providers                      ProviderRegistry
  |-- events                         RevenueEventTransport (Arc-compatible)
  |-- models                         Mongoose models (for Arc adapter)
```

Repositories extend mongokit `Repository`. CRUD + pagination + query is inherited. Domain verbs contain real business logic (state machine transitions, provider calls, event emission). No service layer. No proxy methods.

## RevenueConfig

```typescript
const revenue = await createRevenue({
  // Required
  connection: mongoose.connection,
  defaultCurrency: 'BDT',

  // Providers — register any payment gateway
  providers: {
    manual: new ManualProvider(),
    stripe: new StripeProvider({ apiKey: '...' }),
    bkash: new BkashProvider({ ... }),
  },

  // Modules — progressive opt-in
  modules: {
    subscription: true,          // default: true
    escrow: true,                // default: false
    settlement: true,            // default: false
    commission: {                // commission calculation
      defaultRate: 0.05,
      gatewayFeeRate: 0.025,
    },
  },

  // Event transport — Arc-compatible, drop-in Redis/Outbox
  eventTransport: new RedisEventTransport(ioredis),

  // Bridges — optional external integrations
  bridges: {
    ledger: { onPaymentVerified: async (txn, ctx) => { ... } },
    tax: { computeTax: async (amount, taxClass, ctx) => { ... } },
    notification: { onPaymentVerified: async (txn, ctx) => { ... } },
    currency: { convert: async (amount, from, to) => { ... } },
    customer: { getCustomer: async (id) => { ... } },
    analytics: { trackEvent: async (name, payload) => { ... } },
  },

  // MongoKit plugins — inject per repository
  repositoryPlugins: {
    transaction: [cachePlugin({ adapter: redis })],
  },

  // Schema extensions — add custom fields to models
  schemaOptions: {
    transaction: {
      extraFields: { branch: { type: String }, vatInvoiceNumber: { type: String } },
      extraIndexes: [{ fields: { branch: 1, createdAt: -1 } }],
    },
  },

  multiTenant: true,             // default: true
});
```

## RevenueEngine

```typescript
interface RevenueEngine {
  config: Readonly<RevenueConfig>;
  models: RevenueModels;              // Mongoose models
  repositories: RevenueRepositories;  // MongoKit repositories (the API surface)
  providers: ProviderRegistry;        // Payment providers
  events: RevenueEventTransport;      // Event transport
  destroy(): Promise<void>;
}
```

---

## Arc Integration

Arc auto-generates CRUD routes from mongokit repositories. State transitions go through Arc's **Action Router** (Stripe pattern) — one endpoint per resource, action name in body.

```typescript
import { defineResource } from '@classytic/arc';
import { requireRoles } from '@classytic/arc/permissions';
import { createAdapter } from '#shared/adapter';

export default defineResource({
  name: 'transaction',
  prefix: '/revenue/transactions',
  adapter: createAdapter(revenue.models.Transaction, revenue.repositories.transaction),
  presets: ['multiTenant', 'softDelete'],

  // State transitions → unified action endpoint POST /:id/action
  actions: {
    verify: {
      handler: (id, data, req) => revenue.repositories.transaction.verify(id, data, req.scope),
      permissions: requireRoles('admin', 'finance-manager'),
      schema: { verifiedBy: { type: 'string' } },
      description: 'Verify a pending payment',
    },
    refund: {
      handler: (id, data, req) =>
        revenue.repositories.transaction.refund(id, data.amount, { reason: data.reason }, req.scope),
      permissions: requireRoles('admin'),
      schema: {
        amount: { type: 'number', minimum: 1 },
        reason: { type: 'string', minLength: 3 },
      },
    },
    hold: {
      handler: (id, data, req) => revenue.repositories.transaction.hold(id, data, req.scope),
      permissions: requireRoles('admin', 'marketplace-ops'),
      schema: { reason: { type: 'string' }, amount: { type: 'number' } },
    },
    release: {
      handler: (id, data, req) => revenue.repositories.transaction.release(id, data, req.scope),
      permissions: requireRoles('admin', 'marketplace-ops'),
      schema: {
        recipientId: { type: 'string' },
        recipientType: { type: 'string' },
        amount: { type: 'number' },
      },
    },
    split: {
      handler: (id, data, req) => revenue.repositories.transaction.split(id, data.rules, req.scope),
      permissions: requireRoles('admin'),
      schema: { rules: { type: 'array' } },
    },
  },

  // Non-state transitions stay as custom routes (webhooks, queries, batch ops)
  routes: [
    {
      method: 'POST', path: '/webhook/:provider',
      handler: (req) =>
        revenue.repositories.transaction.handleWebhook(req.params.provider, req.body, req.headers),
    },
  ],
});
```

**Generated endpoints:**
```
GET    /revenue/transactions                  ← list (QueryParser filters)
GET    /revenue/transactions/:id              ← get single
PATCH  /revenue/transactions/:id              ← raw update (gate with permissions)
DELETE /revenue/transactions/:id              ← soft delete
POST   /revenue/transactions/:id/action       ← verify | refund | hold | release | split
POST   /revenue/transactions/webhook/:provider ← provider webhooks
```

**Frontend usage:**
```typescript
// State transition via action endpoint
await fetch('/revenue/transactions/txn_abc123/action', {
  method: 'POST',
  body: JSON.stringify({ action: 'verify', verifiedBy: 'admin_1' }),
});

await fetch('/revenue/transactions/txn_abc123/action', {
  method: 'POST',
  body: JSON.stringify({ action: 'refund', amount: 5000, reason: 'customer request' }),
});

// Filter list via QueryParser
await fetch('/revenue/transactions?status=verified&amount_gte=1000&sort=-createdAt&page=1&limit=20');
```

**Why actions instead of one endpoint per verb:** ~40% fewer routes, single audit point, self-documenting via OpenAPI action enum, type-safe action validation, per-action permissions and schemas. State machine validation lives inside the repository domain verb — `STATE_MACHINE.validate(from, to, id)` throws `InvalidStateTransitionError` if the transition is illegal.

---

## Building a Custom Provider

Every payment gateway implements the `PaymentProvider` abstract class. See `@classytic/revenue-manual` as the reference implementation.

### PaymentProvider Interface

```typescript
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult, WebhookEvent } from '@classytic/revenue';
import type { CreateIntentParams, ProviderCapabilities } from '@classytic/revenue/providers';

export class StripeProvider extends PaymentProvider {
  public override readonly name = 'stripe';

  constructor(config: { apiKey: string }) {
    super(config);
  }

  // 1. Create payment intent — called by createPaymentIntent()
  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const stripe = new Stripe(this.config.apiKey as string);
    const intent = await stripe.paymentIntents.create({
      amount: params.amount,
      currency: params.currency,
      metadata: params.metadata as Stripe.MetadataParam,
    });

    return new PaymentIntent({
      id: intent.id,
      sessionId: null,
      paymentIntentId: intent.id,
      provider: 'stripe',
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      clientSecret: intent.client_secret,      // frontend needs this
      metadata: params.metadata ?? {},
      raw: intent,
    });
  }

  // 2. Verify payment — called by verify()
  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const stripe = new Stripe(this.config.apiKey as string);
    const intent = await stripe.paymentIntents.retrieve(intentId);

    return new PaymentResult({
      id: intent.id,
      provider: 'stripe',
      status: intent.status === 'succeeded' ? 'succeeded'
        : intent.status === 'requires_action' ? 'requires_action'
        : intent.status === 'processing' ? 'processing'
        : 'failed',
      amount: intent.amount,
      currency: intent.currency,
      paidAt: intent.status === 'succeeded' ? new Date() : undefined,
      metadata: {},
      raw: intent,
    });
  }

  // 3. Get status — same as verify for most providers
  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  // 4. Refund — called by refund()
  async refund(paymentId: string, amount?: number | null, options?: { reason?: string }): Promise<RefundResult> {
    const stripe = new Stripe(this.config.apiKey as string);
    const refund = await stripe.refunds.create({
      payment_intent: paymentId,
      amount: amount ?? undefined,
      reason: options?.reason as any,
    });

    return new RefundResult({
      id: refund.id,
      provider: 'stripe',
      status: refund.status === 'succeeded' ? 'succeeded' : 'processing',
      amount: refund.amount,
      currency: refund.currency,
      refundedAt: new Date(),
      reason: options?.reason,
      metadata: {},
      raw: refund,
    });
  }

  // 5. Handle webhook — called by handleWebhook()
  async handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<WebhookEvent> {
    const stripe = new Stripe(this.config.apiKey as string);
    const sig = headers?.['stripe-signature'] ?? '';
    const event = stripe.webhooks.constructEvent(payload as string, sig, this.config.webhookSecret as string);

    return new WebhookEvent({
      id: event.id,
      provider: 'stripe',
      type: event.type,
      data: {
        paymentIntentId: (event.data.object as any).id,
        sessionId: (event.data.object as any).id,
      },
      createdAt: new Date(event.created * 1000),
      raw: event,
    });
  }

  // 6. Capabilities — tells revenue what this provider supports
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

### Required Methods

| Method | Called By | Returns | Purpose |
|---|---|---|---|
| `createIntent(params)` | `repo.createPaymentIntent()` | `PaymentIntent` | Initialize payment with gateway |
| `verifyPayment(intentId)` | `repo.verify()` | `PaymentResult` | Check payment status with gateway |
| `getStatus(intentId)` | Direct call | `PaymentResult` | Poll payment status |
| `refund(paymentId, amount?, options?)` | `repo.refund()` | `RefundResult` | Process refund with gateway |
| `handleWebhook(payload, headers?)` | `repo.handleWebhook()` | `WebhookEvent` | Parse incoming webhook |
| `getCapabilities()` | Engine | `ProviderCapabilities` | Declare supported features |

### PaymentResult Status Map

| Provider Status | Maps To | Revenue Action |
|---|---|---|
| `'succeeded'` | `TRANSACTION_STATUS.VERIFIED` | Mark verified, call ledger bridge |
| `'failed'` | `TRANSACTION_STATUS.FAILED` | Mark failed |
| `'processing'` | `TRANSACTION_STATUS.PROCESSING` | Wait for webhook |
| `'requires_action'` | `TRANSACTION_STATUS.REQUIRES_ACTION` | Return to frontend for 3DS/OTP |

### Register Provider

```typescript
const revenue = await createRevenue({
  connection,
  defaultCurrency: 'BDT',
  providers: {
    manual: new ManualProvider(),
    stripe: new StripeProvider({ apiKey: process.env.STRIPE_KEY }),
    bkash: new BkashProvider({ appKey: '...', appSecret: '...' }),
  },
});

// Use by gateway name
const txn = await revenue.repositories.transaction.createPaymentIntent({
  amount: 5000,
  gateway: 'bkash',   // matches key in providers map
});
```

---

## Event System

Revenue uses `RevenueEventTransport` — a structural superset of Arc's `DomainEvent`. Any Arc transport drops in with zero adapters.

### RevenueDomainEvent

```typescript
interface RevenueDomainEvent<T = unknown> {
  type: string;              // 'revenue:payment.verified'
  payload: T;                // event-specific data
  meta: {
    id: string;              // crypto.randomUUID()
    timestamp: Date;
    resource?: string;       // 'transaction', 'subscription', 'settlement'
    resourceId?: string;     // publicId (txn_..., sub_..., stl_...)
    userId?: string;         // from RevenueContext.actorId
    organizationId?: string; // from RevenueContext.organizationId
    correlationId?: string;  // from RevenueContext.traceId
    aggregate?: string;      // 'revenue'
    version?: number;
    causationId?: string;
    tags?: string[];
  };
}
```

### RevenueEventTransport

```typescript
interface RevenueEventTransport {
  publish(event: RevenueDomainEvent): Promise<void>;
  subscribe?(pattern: string, handler: RevenueEventHandler): Promise<() => void>;
  close?(): Promise<void>;
}
```

### Drop-in Transports

```typescript
// Arc Redis
import { RedisEventTransport } from '@classytic/arc/events';
const revenue = await createRevenue({
  eventTransport: new RedisEventTransport(ioredis),
});

// Arc Outbox (guaranteed delivery)
import { EventOutbox } from '@classytic/arc/events';
const outbox = new EventOutbox({ store: mongoOutboxStore, transport: redisTransport });
const revenue = await createRevenue({
  eventTransport: { publish: (event) => outbox.store(event) },
});

// No events (testing)
import { NoopRevenueEventTransport } from '@classytic/revenue';
const revenue = await createRevenue({
  eventTransport: new NoopRevenueEventTransport(),
});
```

### Pattern Matching

```typescript
await revenue.events.subscribe?.('revenue:payment.*', handler);   // payment.verified, payment.refunded, ...
await revenue.events.subscribe?.('revenue:*', handler);            // all revenue events
await revenue.events.subscribe?.('*', handler);                    // everything
await revenue.events.subscribe?.('revenue:escrow.held', handler);  // exact match
```

### Event Reference

| Event | Payload |
|---|---|
| `revenue:monetization.created` | `{ monetizationType, transaction }` |
| `revenue:payment.verified` | `{ transaction, paymentResult, verifiedBy }` |
| `revenue:payment.failed` | `{ transaction, paymentResult }` |
| `revenue:payment.refunded` | `{ transaction, refundTransaction, refundAmount, reason }` |
| `revenue:payment.requires_action` | `{ transaction, paymentResult }` |
| `revenue:payment.processing` | `{ transaction, paymentResult }` |
| `revenue:subscription.activated` | `{ subscription, activatedAt }` |
| `revenue:subscription.cancelled` | `{ subscription, immediate, reason }` |
| `revenue:subscription.paused` | `{ subscription, reason }` |
| `revenue:subscription.resumed` | `{ subscription, extendPeriod }` |
| `revenue:escrow.held` | `{ transaction, heldAmount, reason }` |
| `revenue:escrow.released` | `{ transaction, releaseAmount, recipientId, isFullRelease }` |
| `revenue:escrow.split` | `{ transaction, splits, organizationPayout }` |
| `revenue:settlement.scheduled` | `{ settlement, scheduledAt }` |
| `revenue:settlement.processing` | `{ settlement, processedAt }` |
| `revenue:settlement.completed` | `{ settlement, completedAt }` |
| `revenue:settlement.failed` | `{ settlement, reason, retry }` |
| `revenue:webhook.processed` | `{ webhookType, provider, transaction }` |

---

## Bridges

All bridges are optional. Every method is optional. Features degrade gracefully when bridge is absent.

```typescript
interface RevenueBridges {
  ledger?: LedgerBridge;             // post journal entries on payment events
  tax?: TaxBridge;                    // compute tax for amounts
  notification?: NotificationBridge;  // send emails/SMS on lifecycle events
  currency?: CurrencyBridge;          // multi-currency conversion
  customer?: CustomerBridge;          // resolve customer details
  analytics?: AnalyticsBridge;        // track events for BI
  source?: SourceBridge;              // resolve polymorphic source documents (Order, Invoice, Stripe charge, etc.)
}
```

### SourceBridge — Polymorphic Source Resolution

Revenue stores `sourceId` as a `String` so it works with any ID format: ObjectId hex, UUIDs, Stripe IDs, REST API resource IDs. Hosts implement `SourceBridge` to teach revenue how to load source documents — works for any deployment topology.

```typescript
// Same MongoDB, single connection (most common)
const revenue = await createRevenue({
  connection,
  bridges: {
    source: {
      async resolve(sourceId, sourceModel) {
        const Model = mongoose.connection.models[sourceModel];
        return Model ? await Model.findById(sourceId).lean() : null;
      },
    },
  },
});

// Microservices (different DBs / HTTP)
bridges: {
  source: {
    async resolve(sourceId, sourceModel) {
      if (sourceModel === 'Order') return await fetch(`http://orders-svc/${sourceId}`).then(r => r.json());
      if (sourceModel === 'Invoice') return await invoiceDb.collection('invoices').findOne({ _id: sourceId });
      return null;
    },
  },
}

// External systems (Stripe, Postgres)
bridges: {
  source: {
    async resolve(sourceId, sourceModel) {
      if (sourceModel === 'StripeCharge') return await stripe.charges.retrieve(sourceId);
      if (sourceModel === 'PostgresOrder') {
        const { rows } = await pg.query('SELECT * FROM orders WHERE id = $1', [sourceId]);
        return rows[0];
      }
      return null;
    },
  },
}
```

Use it in custom Arc routes for enrichment:
```typescript
{
  method: 'GET',
  path: '/:id/with-source',
  handler: async (req) => {
    const txn = await revenue.repositories.transaction.getById(req.params.id);
    const source = txn.sourceId
      ? await revenue.config.bridges?.source?.resolve?.(txn.sourceId, txn.sourceModel, req.scope)
      : null;
    return { ...txn, source };
  },
}
```

For batch/list endpoints, use `resolveMany` to avoid N+1 queries:
```typescript
async resolveMany(refs, ctx) {
  // Group by sourceModel, batch fetch, return Map<sourceId, doc>
}
```

### LedgerBridge

```typescript
interface LedgerBridge {
  onPaymentVerified?(transaction: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onRefundProcessed?(original: Record<string, unknown>, refund: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  onSettlementCompleted?(settlement: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
}
```

### TaxBridge

```typescript
interface TaxBridge {
  computeTax?(amount: number, taxClass: string, ctx: RevenueContext): Promise<{ rate: number; amount: number; inclusive: boolean }>;
}
```

---

## Soft Delete & Force Cleanup

All financial repositories use mongokit's `softDeletePlugin` with `ttlDays: 365`. Calling `delete()` sets `deletedAt` instead of removing the document. After 365 days, MongoDB's TTL index automatically removes the document.

### Inherited methods (from softDeletePlugin)

```typescript
// Soft delete (sets deletedAt)
await revenue.repositories.transaction.delete(id);

// Restore a soft-deleted document
await revenue.repositories.transaction.restore(id);

// List soft-deleted documents
const trash = await revenue.repositories.transaction.getDeleted({ page: 1, limit: 50 });

// Read a specific soft-deleted document
const doc = await revenue.repositories.transaction.getById(id, { includeDeleted: true });
```

### Custom retention period

For compliance (US/EU financial records: ~7 years), override the plugin via `repositoryPlugins`:

```typescript
import { softDeletePlugin } from '@classytic/mongokit';

const revenue = await createRevenue({
  connection,
  defaultCurrency: 'USD',
  repositoryPlugins: {
    transaction: [softDeletePlugin({ ttlDays: 2555 })],   // 7 years
    subscription: [softDeletePlugin({ ttlDays: 2555 })],
  },
});
```

### Force-delete (admin / GDPR right-to-be-forgotten)

The repository's `Model` is the underlying Mongoose model — use it for raw operations when needed:

```typescript
// Custom Arc route for surgical force-delete
{
  method: 'DELETE',
  path: '/:id/force',
  permissions: requireRoles('superadmin', 'compliance-officer'),
  handler: async (req) => {
    const id = req.params.id;

    // Verify it IS soft-deleted first
    const doc = await revenue.repositories.transaction.getById(id, {
      includeDeleted: true,
      throwOnNotFound: false,
    });
    if (!doc) return { error: 'Not found' };
    if (!(doc as any).deletedAt) {
      return { error: 'Document is not soft-deleted. Soft-delete first.' };
    }

    // Hard delete via raw Mongoose model
    await revenue.repositories.transaction.Model.deleteOne({ _id: id });

    // Audit
    await auditBridge.log({
      action: 'force_delete',
      resource: 'transaction',
      resourceId: doc.publicId,
      actor: req.user.id,
      reason: req.body.reason,
    });

    return { success: true, publicId: doc.publicId };
  },
}
```

### Bulk force-cleanup (admin)

```typescript
{
  method: 'POST',
  path: '/force-cleanup',
  permissions: requireRoles('superadmin'),
  handler: async (req) => {
    const { olderThanDays = 30, dryRun = true } = req.body;
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const query = { deletedAt: { $ne: null, $lte: cutoff } };

    if (dryRun) {
      const count = await revenue.repositories.transaction.Model.countDocuments(query);
      return { dryRun: true, wouldDelete: count };
    }

    const result = await revenue.repositories.transaction.Model.deleteMany(query);
    return { deleted: result.deletedCount };
  },
}
```

### Trash bin endpoint

```typescript
{
  method: 'GET',
  path: '/trash',
  permissions: requireRoles('admin'),
  handler: (req) => revenue.repositories.transaction.getDeleted({
    page: req.query.page ?? 1,
    limit: req.query.limit ?? 50,
    sort: { deletedAt: -1 },
  }),
}
```

### Cleanup strategies

| Scenario | Approach |
|---|---|
| Default retention | TTL plugin handles it — no code needed |
| Compliance retention (7yr) | Override `softDeletePlugin({ ttlDays: 2555 })` |
| Test data cleanup | `Model.deleteMany({ deletedAt: { $ne: null } })` in test teardown |
| GDPR right-to-be-forgotten | Custom force-delete endpoint with audit log |
| Database size emergency | Bulk force-cleanup with dry-run support |

---

## Domain Verbs Reference

### TransactionRepository

| Method | Input | Returns | Description |
|---|---|---|---|
| `createPaymentIntent(params, ctx?)` | `{ amount, gateway, data?, metadata?, idempotencyKey? }` | `TransactionDocument` | Create transaction + call provider |
| `verify(intentId, options?, ctx?)` | `intentId, { verifiedBy? }` | `TransactionDocument` | Verify via provider, update status |
| `refund(txnId, amount?, options?, ctx?)` | `txnId, amount?, { reason? }` | `TransactionDocument` (refund) | Create refund transaction |
| `handleWebhook(provider, payload, headers?, ctx?)` | provider name + raw payload | `TransactionDocument \| null` | Process webhook, update transaction |
| `hold(txnId, options?, ctx?)` | `txnId, { amount?, reason?, holdUntil? }` | `TransactionDocument` | Place escrow hold |
| `release(txnId, options, ctx?)` | `txnId, { recipientId, recipientType, amount? }` | `TransactionDocument` | Release escrow |
| `split(txnId, rules, ctx?)` | `txnId, [{ type, recipientId, recipientType, rate }]` | `TransactionDocument` | Multi-party split |

### SubscriptionRepository

| Method | Input | Returns | Description |
|---|---|---|---|
| `activate(subId, options?, ctx?)` | `subId, { timestamp? }` | `SubscriptionDocument` | Activate, calculate period end |
| `cancel(subId, options?, ctx?)` | `subId, { immediate?, reason? }` | `SubscriptionDocument` | Cancel immediately or at period end |
| `pause(subId, options?, ctx?)` | `subId, { reason? }` | `SubscriptionDocument` | Pause subscription |
| `resume(subId, options?, ctx?)` | `subId, { extendPeriod? }` | `SubscriptionDocument` | Resume, optionally extend |

### SettlementRepository

| Method | Input | Returns | Description |
|---|---|---|---|
| `schedule(params, ctx?)` | `{ organizationId, recipientId, amount, payoutMethod, ... }` | `SettlementDocument` | Schedule payout |
| `processPending(options?, ctx?)` | `{ limit?, organizationId?, dryRun? }` | `{ processed, succeeded, failed, settlements }` | Batch process pending |
| `complete(stlId, details?, ctx?)` | `stlId, { transferReference?, transactionHash? }` | `SettlementDocument` | Mark completed |
| `fail(stlId, reason, options?, ctx?)` | `stlId, reason, { retry?, code? }` | `SettlementDocument` | Mark failed or retry |

All inherited mongokit methods also available: `getAll`, `getById`, `getByQuery`, `getOne`, `create`, `update`, `delete`, `count`, `exists`, `distinct`, `aggregate`, `withTransaction`.

---

## Stripe-Style IDs

Via mongokit `customIdPlugin` + `prefixedId`:

```
Transaction:  txn_a7b3xk9m2p1q4d5e6f
Subscription: sub_x1y2z3a4b5c6d7e8f9g
Settlement:   stl_m9n8o7p6q5r4s3t2u1v
```

Internal `_id` stays as MongoDB ObjectId. `publicId` is the external-facing identifier.

## Zod Schemas

Exported at `@classytic/revenue/schemas` for Arc OpenAPI auto-generation and runtime validation.

```typescript
import {
  transactionCreateSchema, transactionUpdateSchema, transactionListFilterSchema,
  subscriptionCreateSchema, subscriptionListFilterSchema,
  settlementCreateSchema, settlementListFilterSchema,
  paymentIntentSchema, paymentVerifySchema, refundSchema,
  escrowHoldSchema, escrowReleaseSchema, splitRuleSchema,
} from '@classytic/revenue/schemas';
```

## Subpath Exports

| Import | Contents |
|---|---|
| `@classytic/revenue` | Main entry — engine, repos, types, everything |
| `@classytic/revenue/schemas` | Zod validators |
| `@classytic/revenue/enums` | Status/flow/type enums |
| `@classytic/revenue/events` | Event types, constants, transports |
| `@classytic/revenue/providers` | PaymentProvider base, response classes |
| `@classytic/revenue/bridges` | Bridge interfaces |
| `@classytic/revenue/utils` | Calculators (commission, tax, splits), Money class |
| `@classytic/revenue/core` | State machines, errors, Result type |

## Peer Dependencies

```json
{
  "@classytic/mongokit": ">=3.5.6",
  "mongoose": ">=9.0.0",
  "zod": ">=4.0.0"
}
```

## License

MIT
