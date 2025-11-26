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
```

## Minimal Provider (5 methods)

```javascript
// index.js
import { PaymentProvider, PaymentIntent, PaymentResult } from '@classytic/revenue';

export class StripeProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'stripe';
    this.stripe = new Stripe(config.apiKey);
  }

  // 1. Create payment intent
  async createIntent(params) {
    const intent = await this.stripe.paymentIntents.create({
      amount: params.amount,
      currency: params.currency,
      metadata: params.metadata,
    });

    return new PaymentIntent({
      id: intent.id,
      provider: 'stripe',
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      clientSecret: intent.client_secret,  // For frontend
      metadata: intent.metadata,
      raw: intent,  // Always include raw response
    });
  }

  // 2. Verify payment
  async verifyPayment(intentId) {
    const intent = await this.stripe.paymentIntents.retrieve(intentId);

    return new PaymentResult({
      id: intent.id,
      provider: 'stripe',
      status: intent.status === 'succeeded' ? 'succeeded' : 'failed',
      amount: intent.amount,
      currency: intent.currency,
      paidAt: intent.status === 'succeeded' ? new Date() : null,
      metadata: intent.metadata,
      raw: intent,
    });
  }

  // 3. Get payment status
  async getStatus(intentId) {
    return this.verifyPayment(intentId);  // Can reuse verify logic
  }

  // 4. Refund payment
  async refund(paymentId, amount, options = {}) {
    const refund = await this.stripe.refunds.create({
      payment_intent: paymentId,
      amount,
      reason: options.reason,
    });

    return new RefundResult({
      id: refund.id,
      provider: 'stripe',
      status: refund.status,
      amount: refund.amount,
      currency: refund.currency,
      refundedAt: new Date(),
      reason: refund.reason,
      raw: refund,
    });
  }

  // 5. Handle webhooks
  async handleWebhook(payload, headers) {
    const signature = headers['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.config.webhookSecret
    );

    return new WebhookEvent({
      id: event.id,
      provider: 'stripe',
      type: event.type,  // payment.succeeded, payment.failed, etc.
      data: event.data.object,
      createdAt: new Date(event.created * 1000),
      raw: event,
    });
  }

  // 6. Declare capabilities
  getCapabilities() {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false,
    };
  }
}
```

## Usage

```javascript
// In your app
import { createRevenue } from '@classytic/revenue';
import { StripeProvider } from '@classytic/revenue-stripe';

const revenue = createRevenue({
  models: { Transaction },
  providers: {
    stripe: new StripeProvider({
      apiKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    }),
  },
});

// Create subscription with Stripe
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: { organizationId, customerId },
  planKey: 'monthly',
  amount: 99.99,
  gateway: 'stripe',  // Uses your provider
});

// Webhook endpoint (Express/Fastify)
app.post('/webhooks/stripe', async (req, res) => {
  const result = await revenue.payments.handleWebhook(
    'stripe',
    req.body,
    req.headers
  );
  res.json(result);
});
```

## Webhook Flow

1. **Library calls** `provider.handleWebhook(payload, headers)`
2. **Provider validates** signature and parses event
3. **Provider returns** `WebhookEvent` with standardized data
4. **Library updates** transaction status automatically
5. **Library triggers** hooks (`payment.webhook.payment.succeeded`)

## Complete Example: SSLCommerz Provider

```javascript
import { PaymentProvider, PaymentIntent, PaymentResult, WebhookEvent } from '@classytic/revenue';
import { SSLCommerzPayment } from 'sslcommerz-lts';

export class SSLCommerzProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'sslcommerz';
    this.ssl = new SSLCommerzPayment(
      config.storeId,
      config.storePassword,
      config.sandbox
    );
  }

  async createIntent(params) {
    const data = {
      total_amount: params.amount,
      currency: params.currency || 'BDT',
      tran_id: `tran_${Date.now()}`,
      success_url: params.metadata.successUrl,
      fail_url: params.metadata.failUrl,
      cancel_url: params.metadata.cancelUrl,
      product_name: params.metadata.productName || 'Subscription',
      product_category: 'Subscription',
      cus_name: params.metadata.customerName,
      cus_email: params.metadata.customerEmail,
      cus_phone: params.metadata.customerPhone,
      shipping_method: 'NO',
      product_profile: 'non-physical-goods',
    };

    const response = await this.ssl.init(data);

    return new PaymentIntent({
      id: data.tran_id,
      provider: 'sslcommerz',
      status: 'pending',
      amount: params.amount,
      currency: params.currency || 'BDT',
      paymentUrl: response.GatewayPageURL,  // Redirect user here
      metadata: params.metadata,
      raw: response,
    });
  }

  async verifyPayment(intentId) {
    const response = await this.ssl.validate({ tran_id: intentId });

    return new PaymentResult({
      id: intentId,
      provider: 'sslcommerz',
      status: response.status === 'VALID' ? 'succeeded' : 'failed',
      amount: parseFloat(response.amount),
      currency: response.currency,
      paidAt: response.status === 'VALID' ? new Date() : null,
      metadata: {
        cardType: response.card_type,
        cardBrand: response.card_brand,
      },
      raw: response,
    });
  }

  async getStatus(intentId) {
    return this.verifyPayment(intentId);
  }

  async refund(paymentId, amount, options = {}) {
    const response = await this.ssl.refund({
      refund_amount: amount,
      refund_remarks: options.reason || 'Customer request',
      bank_tran_id: options.bankTransId,
    });

    return new RefundResult({
      id: response.refund_ref_id,
      provider: 'sslcommerz',
      status: response.status === 'success' ? 'succeeded' : 'failed',
      amount,
      currency: 'BDT',
      refundedAt: new Date(),
      reason: options.reason,
      raw: response,
    });
  }

  async handleWebhook(payload, headers) {
    // SSLCommerz sends data as form-urlencoded
    const { tran_id, status, val_id } = payload;

    // Validate with SSLCommerz API
    const validation = await this.ssl.validate({ val_id });

    return new WebhookEvent({
      id: val_id,
      provider: 'sslcommerz',
      type: status === 'VALID' ? 'payment.succeeded' : 'payment.failed',
      data: {
        paymentIntentId: tran_id,
        validationId: val_id,
        ...validation,
      },
      createdAt: new Date(),
      raw: payload,
    });
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
```

## Publishing Your Provider

```json
// package.json
{
  "name": "@yourorg/revenue-stripe",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "peerDependencies": {
    "@classytic/revenue": "^1.0.0"
  },
  "dependencies": {
    "stripe": "^14.0.0"
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

```javascript
import { StripeProvider } from './index.js';

const provider = new StripeProvider({
  apiKey: 'sk_test_...',
  webhookSecret: 'whsec_...',
});

// Test capabilities
console.log(provider.getCapabilities());

// Test payment intent creation
const intent = await provider.createIntent({
  amount: 9999,  // $99.99
  currency: 'USD',
  metadata: {
    customerId: '123',
    planKey: 'monthly',
  },
});
console.log('Payment URL:', intent.clientSecret);

// Test verification
const result = await provider.verifyPayment(intent.id);
console.log('Payment status:', result.status);
```

## Best Practices

1. **Always include `raw` responses** - helps debugging
2. **Implement idempotency** - handle duplicate webhooks gracefully
3. **Validate webhook signatures** - prevent fraud
4. **Use proper error handling** - throw clear errors
5. **Support partial refunds** if possible
6. **Document configuration** - API keys, webhook secrets, etc.
7. **Add TypeScript definitions** if applicable

## Community Providers

Build and publish providers for:
- ✅ Stripe (`@classytic/revenue-stripe`)
- ✅ SSLCommerz (`@classytic/revenue-sslcommerz`)
- PayPal (`@classytic/revenue-paypal`)
- Razorpay (`@classytic/revenue-razorpay`)
- bKash API (`@classytic/revenue-bkash-api`)
- Nagad API (`@classytic/revenue-nagad-api`)
- Any custom gateway!

## Support

- Core Repo: https://github.com/classytic/revenue
- Provider Template: https://github.com/classytic/revenue-manual (reference)
- Issues: https://github.com/classytic/revenue/issues
