# @classytic/revenue-manual

Manual payment provider for [@classytic/revenue](../revenue).

**Perfect for**: Any payment method without API integration (cash, bank transfer, mobile money, etc.)

**Generic & Flexible**: Works with ANY payment method from ANY country.

## Installation

```bash
npm install @classytic/revenue-manual
```

## Usage

### Option 1: Custom Instructions (Simplest)

```javascript
const { subscription, transaction, paymentIntent } = await revenue.subscriptions.create({
  data: { organizationId, customerId },
  planKey: 'monthly',
  amount: 99.99,
  gateway: 'manual',
  metadata: {
    paymentInstructions: 'Send money to bKash: 01712345678\nReference: Your name',
  },
});

console.log(paymentIntent.instructions);
// Exactly what you passed
```

### Option 2: Payment Info (Auto-formatted)

```javascript
const { paymentIntent } = await revenue.subscriptions.create({
  data: { organizationId, customerId },
  planKey: 'monthly',
  amount: 99.99,
  gateway: 'manual',
  metadata: {
    paymentInfo: {
      method: 'bKash',
      number: '01712345678',
      type: 'Personal',
      note: 'Use your name as reference',
    },
  },
});

console.log(paymentIntent.instructions);
// Payment Amount: 99.99 BDT
//
// method: bKash
// number: 01712345678
// type: Personal
// note: Use your name as reference
```

## Features

- ✅ Works with ANY payment method (no hardcoded methods)
- ✅ Custom payment instructions
- ✅ Auto-formatted payment info
- ✅ Full & partial refunds
- ❌ No webhooks (manual verification only)

## Provider Capabilities

```javascript
const manual = new ManualProvider();
const capabilities = manual.getCapabilities();

// {
//   supportsWebhooks: false,
//   supportsRefunds: true,
//   supportsPartialRefunds: true,
//   requiresManualVerification: true,
// }
```

## Examples

### bKash (Bangladesh)

```javascript
metadata: {
  paymentInfo: {
    method: 'bKash',
    number: '01712345678',
    type: 'Personal',
  },
}
// Auto-formatted:
// Payment Amount: 99.99 BDT
//
// method: bKash
// number: 01712345678
// type: Personal
```

### UPI (India)

```javascript
metadata: {
  paymentInfo: {
    method: 'UPI',
    upiId: 'merchant@paytm',
  },
}
// Auto-formatted:
// Payment Amount: 99.99 INR
//
// method: UPI
// upiId: merchant@paytm
```

### M-Pesa (Kenya)

```javascript
metadata: {
  paymentInfo: {
    method: 'M-Pesa',
    businessNumber: '123456',
    accountNumber: 'ABC123',
  },
}
```

### Any Payment Method

```javascript
metadata: {
  paymentInstructions: `
    Send payment to:
    Bank: XYZ Bank
    Account: 123-456-789
    SWIFT: XYZBUS33
    Reference: ${orderId}
  `,
}
// Uses exactly what you provide
```

## Verification Flow

Manual payments require admin verification:

```javascript
// 1. Customer creates subscription with manual payment
const { transaction } = await revenue.subscriptions.create({
  data: { ... },
  gateway: 'manual',
});

// transaction.status === 'pending'

// 2. Admin verifies payment
await revenue.payments.verify(transaction.paymentIntentId, {
  verifiedBy: adminUserId,
});

// transaction.status === 'verified'
```

## Reference Implementation

This provider serves as a **reference implementation** for building custom providers.

### Building Your Own Provider

Use this structure to build providers for Stripe, SSLCommerz, bKash API, or any custom gateway:

```javascript
import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult } from '@classytic/revenue';

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
      metadata: params.metadata,
    });

    return new PaymentIntent({
      id: intent.id,
      provider: 'stripe',
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      clientSecret: intent.client_secret,
      metadata: intent.metadata,
      raw: intent,
    });
  }

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
      metadata: refund.metadata,
      raw: refund,
    });
  }

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
      type: event.type,
      data: event.data.object,
      createdAt: new Date(event.created * 1000),
      raw: event,
    });
  }

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

## Documentation

- **[Building Payment Providers](../docs/guides/PROVIDER_GUIDE.md)** - Guide to creating custom payment providers
- **[Full Documentation](../docs/README.md)** - Complete documentation

## Support

- **GitHub**: https://github.com/classytic/revenue
- **Issues**: https://github.com/classytic/revenue/issues

## License

MIT © Classytic (Classytic)

---

**Built with ❤️ as a reference for the community**
