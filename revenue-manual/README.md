# @classytic/revenue-manual

> Manual Payment Provider for @classytic/revenue

Perfect for any payment method without API integration: cash, bank transfer, mobile money (bKash, M-Pesa, UPI), wire transfer, etc.

## Installation

```bash
npm install @classytic/revenue @classytic/revenue-manual
```

## Usage

```typescript
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction, Subscription })
  .withProvider('manual', new ManualProvider())
  .build();

// Create payment with custom instructions
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: { customerId: user._id },
  planKey: 'monthly',
  amount: 2999,
  gateway: 'manual',
  metadata: {
    paymentInstructions: `
      Send payment to:
      bKash: 01712345678
      Reference: ${user.name}
    `,
  },
});

console.log(paymentIntent.instructions);
// Your custom instructions

// Admin verifies payment
await revenue.payments.verify(transaction._id, {
  verifiedBy: adminId,
});
```

## Payment Info (Auto-formatted)

```typescript
const { paymentIntent } = await revenue.monetization.create({
  data: { customerId: user._id },
  amount: 9999,
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
// Payment Amount: 99.99 USD
//
// method: bKash
// number: 01712345678
// type: Personal
// note: Use your name as reference
```

## Examples

### bKash (Bangladesh)

```typescript
metadata: {
  paymentInfo: {
    method: 'bKash',
    number: '01712345678',
    type: 'Personal',
  },
}
```

### UPI (India)

```typescript
metadata: {
  paymentInfo: {
    method: 'UPI',
    upiId: 'merchant@paytm',
  },
}
```

### M-Pesa (Kenya)

```typescript
metadata: {
  paymentInfo: {
    method: 'M-Pesa',
    businessNumber: '123456',
    accountNumber: 'ABC123',
  },
}
```

### Bank Transfer

```typescript
metadata: {
  paymentInstructions: `
    Bank: XYZ Bank
    Account: 123-456-789
    SWIFT: XYZBUS33
    Reference: ORDER-${orderId}
  `,
}
```

## Capabilities

```typescript
const manual = new ManualProvider();
manual.getCapabilities();
// {
//   supportsWebhooks: false,
//   supportsRefunds: true,
//   supportsPartialRefunds: true,
//   requiresManualVerification: true,
// }
```

## Verification Flow

```typescript
// 1. Customer creates payment
const { transaction } = await revenue.monetization.create({
  data: { customerId },
  amount: 1500,
  gateway: 'manual',
});
// transaction.status === 'pending'

// 2. Customer pays outside the system (cash, bank, etc.)

// 3. Admin verifies payment received
await revenue.payments.verify(transaction._id, {
  verifiedBy: adminUserId,
});
// transaction.status === 'verified'
```

## Refunds

```typescript
// Full refund
await revenue.payments.refund(transaction._id);

// Partial refund
await revenue.payments.refund(transaction._id, 500, {
  reason: 'Partial return',
});
```

## TypeScript

Full TypeScript support:

```typescript
import { ManualProvider } from '@classytic/revenue-manual';
import type { ManualProviderConfig, ManualRefundOptions } from '@classytic/revenue-manual';

const provider = new ManualProvider({
  // Custom config if needed
});
```

## Building Custom Providers

Use ManualProvider as a reference for building your own:

```typescript
import {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from '@classytic/revenue';
import type { CreateIntentParams, ProviderCapabilities } from '@classytic/revenue';

export class MyProvider extends PaymentProvider {
  public override readonly name = 'my-provider';

  constructor(config: MyConfig) {
    super(config);
  }

  async createIntent(params: CreateIntentParams): Promise<PaymentIntent> {
    // Your implementation
  }

  async verifyPayment(intentId: string): Promise<PaymentResult> {
    // Your implementation
  }

  async getStatus(intentId: string): Promise<PaymentResult> {
    // Your implementation
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    // Your implementation
  }

  async handleWebhook(payload: unknown, headers?: Record<string, string>): Promise<WebhookEvent> {
    // Your implementation
  }

  override getCapabilities(): ProviderCapabilities {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: true,
    };
  }
}
```

## Links

- **Core Package**: [@classytic/revenue](../revenue/README.md)
- **Provider Guide**: [Building Payment Providers](../docs/guides/PROVIDER_GUIDE.md)
- **GitHub**: https://github.com/classytic/revenue

## License

MIT © [Classytic](https://github.com/classytic)
