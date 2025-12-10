# Building Payment Providers for @classytic/revenue

Complete guide for building payment provider packages (like Stripe, PayPal, etc.)

## Quick Start

```bash
# 1. Create your package
mkdir revenue-stripe
cd revenue-stripe
npm init -y

# 2. Install peer dependency
npm install @classytic/revenue --save-peer
npm install typescript tsup --save-dev
```

## Minimal Provider (5 methods)

```typescript
// src/index.ts
import {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
  type CreateIntentParams,
  type ProviderCapabilities,
} from '@classytic/revenue';
import Stripe from 'stripe';

export interface StripeProviderConfig {
  apiKey: string;
  webhookSecret: string;
}

export class StripeProvider extends PaymentProvider {
  public override readonly name = 'stripe';
  private stripe: Stripe;

  constructor(config: StripeProviderConfig) {
    super(config);
    this.stripe = new Stripe(config.apiKey);
  }

  // 1. Create payment intent
  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const intent = await this.stripe.paymentIntents.create({
      amount: params.amount,
      currency: params.currency ?? 'usd',
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
      clientSecret: intent.client_secret!,  // For frontend
      metadata: params.metadata ?? {},
    });
  }

  // 2. Verify payment
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

  // 3. Get payment status
  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);  // Can reuse verify logic
  }

  // 4. Refund payment
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

  // 5. Handle webhooks
  async handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<WebhookEvent> {
    const signature = headers?.['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      payload as string,
      signature!,
      this.config.webhookSecret as string
    );

    return new WebhookEvent({
      id: event.id,
      provider: this.name,
      type: event.type,  // payment_intent.succeeded, etc.
      data: event.data.object as any,
      createdAt: new Date(event.created * 1000),
    });
  }

  // 6. Declare capabilities
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

## Usage with Fluent API

```typescript
// In your app
import { Revenue } from '@classytic/revenue';
import { StripeProvider } from '@yourorg/revenue-stripe';

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('stripe', new StripeProvider({
    apiKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  }))
  .withCommission(10, 2.9)
  .build();

// Create payment
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: {
    customerId,
    organizationId,
    referenceId: orderId,
    referenceModel: 'Order',
  },
  planKey: 'one_time',
  monetizationType: 'purchase',
  amount: 9999,
  gateway: 'stripe',
});

// Frontend uses clientSecret
console.log('Client Secret:', paymentIntent.clientSecret);

// Webhook endpoint (Express/Fastify)
app.post('/webhooks/stripe', async (req, res) => {
  const result = await revenue.payments.handleWebhook(
    'stripe',
    req.body,
    req.headers as Record<string, string>
  );
  res.json(result);
});
```

## Webhook Flow

1. **Library calls** `provider.handleWebhook(payload, headers)`
2. **Provider validates** signature and parses event
3. **Provider returns** `WebhookEvent` with standardized data
4. **Library updates** transaction status automatically
5. **Library emits** events (`payment.succeeded`, `payment.failed`)

## Complete Example: SSLCommerz Provider

```typescript
import {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
  type CreateIntentParams,
  type ProviderCapabilities,
} from '@classytic/revenue';
import { SSLCommerzPayment } from 'sslcommerz-lts';

export interface SSLCommerzConfig {
  storeId: string;
  storePassword: string;
  sandbox?: boolean;
}

export class SSLCommerzProvider extends PaymentProvider {
  public override readonly name = 'sslcommerz';
  private ssl: SSLCommerzPayment;

  constructor(config: SSLCommerzConfig) {
    super(config);
    this.ssl = new SSLCommerzPayment(
      config.storeId,
      config.storePassword,
      config.sandbox ?? false
    );
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    const metadata = params.metadata ?? {};
    const data = {
      total_amount: params.amount,
      currency: params.currency ?? 'BDT',
      tran_id: `tran_${Date.now()}`,
      success_url: metadata.successUrl as string,
      fail_url: metadata.failUrl as string,
      cancel_url: metadata.cancelUrl as string,
      product_name: (metadata.productName as string) ?? 'Payment',
      product_category: 'Service',
      cus_name: metadata.customerName as string,
      cus_email: metadata.customerEmail as string,
      cus_phone: metadata.customerPhone as string,
      shipping_method: 'NO',
      product_profile: 'non-physical-goods',
    };

    const response = await this.ssl.init(data);

    return new PaymentIntent({
      id: data.tran_id,
      paymentIntentId: data.tran_id,
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
    const response = await this.ssl.validate({ tran_id: intentId });

    return new PaymentResult({
      id: intentId,
      provider: this.name,
      status: response.status === 'VALID' ? 'succeeded' : 'failed',
      amount: parseFloat(response.amount),
      currency: response.currency,
      paidAt: response.status === 'VALID' ? new Date() : undefined,
      metadata: {
        cardType: response.card_type,
        cardBrand: response.card_brand,
      },
    });
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    // SSLCommerz refund implementation
    return new RefundResult({
      id: `refund_${paymentId}`,
      provider: this.name,
      status: 'succeeded',
      amount: amount ?? 0,
      currency: 'BDT',
      refundedAt: new Date(),
      metadata: {},
    });
  }

  async handleWebhook(payload: unknown, _headers?: Record<string, string>): Promise<WebhookEvent> {
    const data = payload as any;
    const { tran_id, status, val_id } = data;

    return new WebhookEvent({
      id: val_id,
      provider: this.name,
      type: status === 'VALID' ? 'payment.succeeded' : 'payment.failed',
      data: {
        paymentIntentId: tran_id,
        validationId: val_id,
        ...data,
      },
      createdAt: new Date(),
    });
  }

  override getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: false,
      requiresManualVerification: false,
    };
  }
}
```

## Publishing Your Provider

```json
// package.json
{
  "name": "@yourorg/revenue-stripe",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "peerDependencies": {
    "@classytic/revenue": "^1.0.0"
  },
  "dependencies": {
    "stripe": "^14.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsup": "^8.0.0"
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts"
  },
  "keywords": [
    "revenue",
    "payment",
    "stripe",
    "provider"
  ]
}
```

## Testing Your Provider

```typescript
import { StripeProvider } from './src/index';

const provider = new StripeProvider({
  apiKey: 'sk_test_...',
  webhookSecret: 'whsec_...',
});

// Test capabilities
console.log(provider.getCapabilities());

// Test payment intent creation
const intent = await provider.createIntent({
  amount: 9999,  // $99.99 in cents
  currency: 'usd',
  metadata: {
    customerId: '123',
    planKey: 'monthly',
  },
});
console.log('Client Secret:', intent.clientSecret);

// Test verification
const result = await provider.verifyPayment(intent.id);
console.log('Payment status:', result.status);
```

## Best Practices

1. **Always use TypeScript** - Better DX and type safety
2. **Implement all 5 methods** - Even if some throw "not supported"
3. **Validate webhook signatures** - Prevent fraud
4. **Use proper error handling** - Throw clear errors
5. **Support partial refunds** if the gateway allows
6. **Document configuration** - API keys, webhook secrets, etc.
7. **Include raw responses** - Helps debugging

## Community Providers

Build and publish providers for:
- ✅ Manual (`@classytic/revenue-manual`)
- Stripe (`@yourorg/revenue-stripe`)
- PayPal (`@yourorg/revenue-paypal`)
- Razorpay (`@yourorg/revenue-razorpay`)
- SSLCommerz (`@yourorg/revenue-sslcommerz`)
- bKash API (`@yourorg/revenue-bkash`)
- Nagad API (`@yourorg/revenue-nagad`)
- Any custom gateway!

## Support

- Core Repo: https://github.com/classytic/revenue
- Provider Template: https://github.com/classytic/revenue-manual (reference)
- Issues: https://github.com/classytic/revenue/issues
