# Building Custom Providers

All payment providers extend `PaymentProvider` and implement 5 required methods. The system handles retry, circuit breaker, and event emission — providers only deal with gateway communication.

## PaymentProvider Base Class

```typescript
import { PaymentProvider } from '@classytic/revenue/providers';

abstract class PaymentProvider {
  public readonly config: Record<string, unknown>;
  public readonly name: string;

  // REQUIRED — implement all 5:
  abstract createIntent(params: CreateIntentParams): Promise<PaymentIntent>;
  abstract verifyPayment(intentId: string): Promise<PaymentResult>;
  abstract getStatus(intentId: string): Promise<PaymentResult>;
  abstract refund(paymentId: string, amount?: number | null, options?: { reason?: string }): Promise<RefundResult>;
  abstract handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<WebhookEvent>;

  // OPTIONAL — override as needed:
  verifyWebhookSignature(payload: unknown, signature: string): boolean { return false; }
  getCapabilities(): ProviderCapabilities {
    return { supportsWebhooks: false, supportsRefunds: true, supportsPartialRefunds: false, requiresManualVerification: false };
  }

  get defaultCurrency(): string;
  setDefaultCurrency(currency: string): void;
}
```

## CreateIntentParams (Input)

```typescript
interface CreateIntentParams {
  amount: number;                    // Amount in smallest unit (cents)
  currency?: string;                 // ISO 4217, falls back to provider.defaultCurrency
  metadata?: Record<string, unknown>;
}
```

## Response Types

### PaymentIntent

Returned from `createIntent()`. Use the appropriate field for your gateway pattern:

```typescript
new PaymentIntent({
  id: string;                        // Unique intent ID
  sessionId: string | null;          // Checkout session ID (SSLCommerz, etc.)
  paymentIntentId: string | null;    // Payment intent ID (Stripe, etc.)
  provider: string;                  // Provider name
  status: string;                    // 'pending', 'succeeded', etc.
  amount: number;
  currency?: string;
  metadata: Record<string, unknown>;

  // Gateway-specific — use ONE of these:
  clientSecret?: string;             // Stripe Elements (client-side confirmation)
  paymentUrl?: string;               // Redirect-based gateways (SSLCommerz, bKash)
  instructions?: string;             // Manual payment instructions
  raw?: unknown;                     // Full provider response
});
```

### PaymentResult

Returned from `verifyPayment()` and `getStatus()`:

```typescript
new PaymentResult({
  id: string;
  provider: string;
  status: 'succeeded' | 'failed' | 'processing' | 'requires_action';
  amount?: number;
  currency?: string;
  paidAt?: Date;
  metadata: Record<string, unknown>;
  raw?: unknown;
});
```

### RefundResult

Returned from `refund()`:

```typescript
new RefundResult({
  id: string;
  provider: string;
  status: 'succeeded' | 'failed' | 'processing';
  amount?: number;
  currency?: string;
  refundedAt?: Date;
  reason?: string;
  metadata: Record<string, unknown>;
  raw?: unknown;
});
```

### WebhookEvent

Returned from `handleWebhook()`:

```typescript
new WebhookEvent({
  id: string;
  provider: string;
  type: string;                      // e.g., 'payment.succeeded', 'payment.failed', 'refund.succeeded'
  data: {
    sessionId?: string;              // For session-based lookup
    paymentIntentId?: string;        // For intent-based lookup
    [key: string]: unknown;
  };
  createdAt?: Date;
  raw?: unknown;
});
```

**Important:** `data` must include either `sessionId` or `paymentIntentId` so the system can match the webhook to a transaction.

### ProviderCapabilities

```typescript
interface ProviderCapabilities {
  supportsWebhooks: boolean;         // Can receive webhook events
  supportsRefunds: boolean;          // Can process refunds
  supportsPartialRefunds: boolean;   // Can refund less than full amount
  requiresManualVerification: boolean; // Admin must call verify() manually
}
```

## Pattern 1: Client-Secret (Stripe)

For gateways where the frontend confirms payment using a client secret.

```typescript
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
      metadata: params.metadata as Record<string, string>,
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
      amount: amount ?? undefined, // null = full refund
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
      this.config.webhookSecret as string,
    );
    return new WebhookEvent({
      id: event.id,
      provider: this.name,
      type: event.type,
      data: {
        paymentIntentId: (event.data.object as any).id,
        ...(event.data.object as any),
      },
      createdAt: new Date(event.created * 1000),
    });
  }

  override getCapabilities(): ProviderCapabilities {
    return { supportsWebhooks: true, supportsRefunds: true, supportsPartialRefunds: true, requiresManualVerification: false };
  }
}
```

## Pattern 2: Redirect (SSLCommerz)

For gateways that redirect the user to a hosted payment page.

```typescript
class SSLCommerzProvider extends PaymentProvider {
  constructor(config: { storeId: string; storePassword: string; sandbox?: boolean }) {
    super(config);
    this.name = 'sslcommerz';
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const meta = params.metadata ?? {};
    const tranId = `tran_${Date.now()}`;

    const response = await sslcommerz.init({
      total_amount: params.amount,
      currency: params.currency ?? 'BDT',
      tran_id: tranId,
      success_url: meta.successUrl as string,
      fail_url: meta.failUrl as string,
      cancel_url: meta.cancelUrl as string,
      // ... customer details from metadata
    });

    return new PaymentIntent({
      id: tranId,
      paymentIntentId: tranId,
      sessionId: null,
      provider: this.name,
      status: 'pending',
      amount: params.amount,
      currency: params.currency ?? 'BDT',
      paymentUrl: response.GatewayPageURL,  // Redirect user here
      metadata: params.metadata ?? {},
    });
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    const response = await sslcommerz.validate({ tran_id: intentId });
    return new PaymentResult({
      id: intentId,
      provider: this.name,
      status: response.status === 'VALID' ? 'succeeded' : 'failed',
      amount: parseFloat(response.amount),
      currency: response.currency,
      paidAt: response.status === 'VALID' ? new Date() : undefined,
      metadata: { cardType: response.card_type },
    });
  }

  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const data = payload as any;
    return new WebhookEvent({
      id: data.val_id,
      provider: this.name,
      type: data.status === 'VALID' ? 'payment.succeeded' : 'payment.failed',
      data: { paymentIntentId: data.tran_id, ...data },
      createdAt: new Date(),
    });
  }

  // ... getStatus, refund similar patterns
}
```

## Pattern 3: Manual Verification

For bank transfers, cash, or any offline payment method. Admin calls `verify()` after confirming receipt.

```typescript
import { ManualProvider } from '@classytic/revenue-manual';

// Pre-built — just install:
// npm install @classytic/revenue-manual

const revenue = Revenue
  .create()
  .withProvider('manual', new ManualProvider({
    instructions: {            // optional custom instructions
      bankName: 'Example Bank',
      accountNumber: '1234567890',
    },
  }))
  .build();

// ManualProvider capabilities:
// supportsWebhooks: false
// supportsRefunds: true
// supportsPartialRefunds: true
// requiresManualVerification: true
```

## Pattern 4: Mobile Wallet (bKash)

For mobile wallet gateways with deep-link or QR code flows.

```typescript
class BkashProvider extends PaymentProvider {
  constructor(config: { appKey: string; appSecret: string; sandbox?: boolean }) {
    super(config);
    this.name = 'bkash';
    this.setDefaultCurrency('BDT');
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const token = await this.getToken();
    const payment = await this.createBkashPayment(token, params.amount);

    return new PaymentIntent({
      id: payment.paymentID,
      paymentIntentId: payment.paymentID,
      sessionId: null,
      provider: this.name,
      status: 'pending',
      amount: params.amount,
      currency: 'BDT',
      paymentUrl: payment.bkashURL,  // Deep-link or redirect
      metadata: params.metadata ?? {},
    });
  }

  // ... verifyPayment, refund, handleWebhook follow same patterns
}
```

## Registration

```typescript
const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('stripe', new StripeProvider({ apiKey: '...', webhookSecret: '...' }))
  .withProvider('manual', new ManualProvider())
  .withProvider('sslcommerz', new SSLCommerzProvider({ storeId: '...', storePassword: '...' }))
  .withProvider('bkash', new BkashProvider({ appKey: '...', appSecret: '...' }))
  .build();

// Use in monetization
await revenue.monetization.create({
  data: { organizationId, customerId, sourceId, sourceModel: 'Order' },
  monetizationType: 'purchase',
  amount: 5000,
  gateway: 'stripe',  // matches provider name
});
```

## Webhook Route Setup

```typescript
// One route per provider
app.post('/webhooks/stripe', async (req, res) => {
  try {
    const result = await revenue.payments.handleWebhook('stripe', req.body, req.headers);
    res.json({ received: true, status: result.status });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/webhooks/sslcommerz', async (req, res) => {
  const result = await revenue.payments.handleWebhook('sslcommerz', req.body);
  res.json({ received: true });
});
```

The system automatically:
1. Delegates to the provider's `handleWebhook()`
2. Matches the webhook to a transaction via `sessionId` or `paymentIntentId`
3. Updates transaction status based on event type
4. Emits `webhook.processed` event
5. Checks idempotency (duplicate webhooks are ignored)
