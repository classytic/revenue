# Payment Provider Patterns

Reference implementations for building payment providers for `@classytic/revenue`.

**These are NOT npm packages** - Copy the pattern you need into your project and customize it.

## 📦 Available Patterns

| Pattern | Use Case | Complexity |
|---------|----------|------------|
| [stripe-checkout](./stripe-checkout/) | Single-tenant Stripe payments | ⭐ Simple |
| [stripe-connect-standard](./stripe-connect-standard/) | Multi-tenant marketplace (Stripe handles onboarding) | ⭐⭐ Moderate |
| [stripe-connect-express](./stripe-connect-express/) | Multi-tenant platform (embedded onboarding) | ⭐⭐ Moderate |
| [stripe-platform-manual](./stripe-platform-manual/) | Platform collects, manual vendor payouts | ⭐⭐ Moderate |
| [sslcommerz](./sslcommerz/) | Bangladesh payment gateway | ⭐ Simple |
| [bkash-tokenized](./bkash-tokenized/) | Bangladesh mobile money (API) | ⭐⭐ Moderate |

## 🚀 How to Use

### 1. Choose a Pattern
Pick the pattern that matches your use case from the table above.

### 2. Copy to Your Project
```bash
# Copy the entire pattern directory
cp -r provider-patterns/stripe-checkout src/providers/

# Or copy individual files
cp provider-patterns/stripe-checkout/provider.js src/providers/StripeProvider.js
cp provider-patterns/stripe-checkout/schemas.js src/schemas/stripe.js
```

### 3. Install Dependencies
```bash
npm install stripe  # For Stripe patterns
# or
npm install sslcommerz-lts  # For SSLCommerz
```

### 4. Configure
```javascript
import { createRevenue } from '@classytic/revenue';
import { StripeCheckoutProvider } from './providers/StripeProvider.js';

const revenue = createRevenue({
  models: { Transaction },
  providers: {
    stripe: new StripeCheckoutProvider({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      successUrl: 'https://yoursite.com/success',
      cancelUrl: 'https://yoursite.com/cancel',
    }),
  },
});
```

### 5. Customize
Modify the copied code to fit your specific needs.

## 📚 Pattern Structure

Each pattern contains:
```
pattern-name/
├── provider.js         → Provider implementation (copy this)
├── schemas.js          → Mongoose schemas for your models
├── config.example.js   → Configuration example
├── example.js          → Usage example
└── README.md           → Detailed setup guide
```

## 🎯 Decision Guide

### Single-Tenant (One Business)
```
You: Single business accepting payments
Use: stripe-checkout, sslcommerz, or bkash-tokenized
```

### Multi-Tenant Marketplace (Vendors Have Stripe)
```
You: Platform connecting buyers & vendors
Vendors: Have their own Stripe accounts
Use: stripe-connect-standard or stripe-connect-express
```

### Multi-Tenant Platform (You Collect, Manual Payout)
```
You: Platform collects all payments
Vendors: Don't have Stripe accounts
Use: stripe-platform-manual
Commission: Calculated by @classytic/revenue
Payouts: You transfer manually (bank transfer, etc.)
```

## 🔧 Customization Tips

### Adding Custom Fields
```javascript
// In schemas.js
export const stripeCustomerSchema = new Schema({
  stripeCustomerId: String,
  // Add your fields:
  preferredPaymentMethod: String,
  billingAddress: { ... },
});
```

### Handling Webhooks
```javascript
// In your Express/Fastify app
app.post('/webhooks/stripe', async (req, res) => {
  const { event, transaction } = await revenue.payments.handleWebhook(
    'stripe',
    req.body,
    req.headers
  );
  
  // Your custom logic
  if (event.type === 'payment.succeeded') {
    await sendConfirmationEmail(transaction.customerId);
  }
  
  res.json({ received: true });
});
```

### Multi-Currency
```javascript
// Pass currency in createIntent
const { paymentIntent } = await revenue.subscriptions.create({
  amount: 1000,
  currency: 'USD',  // or 'EUR', 'GBP', etc.
  gateway: 'stripe',
});
```

## 🆘 Support

- **Core Library Issues**: [github.com/classytic/revenue/issues](https://github.com/classytic/revenue/issues)
- **Pattern Questions**: Open a discussion on GitHub
- **Provider Bugs**: Fix in your copied code (you own it)

## 📝 Contributing

Have a pattern for another provider? Submit a PR with:
- Complete implementation
- Schemas
- Configuration example
- Usage example
- README

## ⚖️ License

These patterns are provided as-is under MIT license. Copy, modify, and use freely.

