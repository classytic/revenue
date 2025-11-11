# Provider Patterns Reference

Quick reference for all available payment provider patterns.

## 🎯 Choose Your Pattern

### Single-Tenant (One Business)

**You have:** One business, one payment account  
**Choose:** [stripe-checkout](./stripe-checkout/) or [sslcommerz](./sslcommerz/)

```javascript
import { StripeCheckoutProvider } from './stripe-checkout/provider.js';

const revenue = createRevenue({
  providers: {
    stripe: new StripeCheckoutProvider({ secretKey: '...' }),
  },
});
```

---

### Multi-Tenant: Vendors Have Stripe Accounts

**You have:** Marketplace, vendors own Stripe accounts  
**Choose:** [stripe-connect-standard](./stripe-connect-standard/)

```javascript
import { StripeConnectStandardProvider } from './stripe-connect-standard/provider.js';

const revenue = createRevenue({
  providers: {
    stripe: new StripeConnectStandardProvider({ 
      platformSecretKey: '...',
      clientId: '...',
    }),
  },
  config: {
    commissionRates: { 'product_order': 0.10 }, // Track commission
  },
});

// Vendors get paid by Stripe directly
// You invoice vendors for commission separately
```

---

### Multi-Tenant: Platform Collects, Manual Payout

**You have:** Marketplace, vendors DON'T have payment accounts  
**Choose:** [stripe-platform-manual](./stripe-platform-manual/)

```javascript
import { StripePlatformManualProvider } from './stripe-platform-manual/provider.js';

const revenue = createRevenue({
  providers: {
    stripe: new StripePlatformManualProvider({ secretKey: '...' }),
  },
  config: {
    commissionRates: { 'product_order': 0.10 }, // Platform keeps 10%
  },
});

// You collect 100% via Stripe
// Commission auto-calculated
// You pay vendors manually (bank/bKash/etc.)
```

---

## 📋 Pattern Comparison

| Feature | stripe-checkout | stripe-connect | stripe-platform-manual | sslcommerz |
|---------|----------------|----------------|------------------------|------------|
| **Complexity** | ⭐ Simple | ⭐⭐ Moderate | ⭐⭐ Moderate | ⭐ Simple |
| **Vendor Onboarding** | N/A | Required | Not needed | N/A |
| **Payout** | Platform | Stripe automatic | Platform manual | Platform |
| **Commission** | Via Stripe | Track separately | Auto-tracked | Via Stripe |
| **Best For** | Single business | Established vendors | Simple platforms | Bangladesh |
| **Countries** | Global | Global | Global | Bangladesh |

---

## 📦 What's Included in Each Pattern

```
pattern-name/
├── README.md           → Setup guide & use case
├── provider.js         → Provider implementation (copy this)
├── schemas.js          → Mongoose schemas for your models
├── config.example.js   → Configuration example
└── example.js          → Usage examples
```

---

## 🚀 Quick Start

1. **Choose pattern** from table above
2. **Copy files** to your project
3. **Install dependencies** (stripe or sslcommerz-lts)
4. **Configure** with your API keys
5. **Customize** as needed

---

## 🔧 Commission Setup (All Patterns)

```javascript
const revenue = createRevenue({
  models: { Transaction },
  providers: { /* your provider */ },
  
  config: {
    // ⭐ Commission rates by category
    commissionRates: {
      'product_order': 0.10,      // 10%
      'service_order': 0.15,      // 15%
      'course_enrollment': 0.10,  // 10%
      'gym_membership': 0,        // No commission
    },
    
    // ⭐ Gateway fees (deducted from commission)
    gatewayFeeRates: {
      'stripe': 0.029,           // 2.9%
      'sslcommerz': 0.025,       // 2.5%
      'bkash': 0.018,            // 1.8%
      'manual': 0,               // No fee
    },
  },
});
```

Commission automatically calculated:
```javascript
const { transaction } = await revenue.subscriptions.create({
  amount: 10000,  // $100
  entity: 'ProductOrder',  // → 10% commission
  gateway: 'stripe',       // → 2.9% fee
});

console.log(transaction.commission);
// {
//   grossAmount: 1000,      // $10 (10% of $100)
//   gatewayFeeAmount: 290,  // $2.90 (2.9% of $100)
//   netAmount: 710,         // $7.10 (platform keeps)
//   status: 'pending'
// }
```

---

## 📚 Additional Resources

- **Provider Guide**: [../docs/guides/PROVIDER_GUIDE.md](../docs/guides/PROVIDER_GUIDE.md)
- **Core Documentation**: [../revenue/README.md](../revenue/README.md)
- **Commission Tracking**: [../revenue/examples/commission-tracking.js](../revenue/examples/commission-tracking.js)

---

## ⚠️ Important Notes

### These are NOT npm packages
- Copy the code to your project
- Customize as needed
- You own and maintain the copied code

### Schema Usage
```javascript
// ✅ Correct: Nested schema
import { stripeCustomerSchema } from './schemas.js';

const customerSchema = new Schema({
  name: String,
  stripe: stripeCustomerSchema,  // Nested
});

// ❌ Wrong: Don't spread
const customerSchema = new Schema({
  ...stripeCustomerSchema  // Don't do this
});
```

### Testing
- Use test API keys
- Test webhooks with Stripe CLI or ngrok
- Verify commission calculations

---

## 🤝 Contributing

Have a pattern for another provider? Add it following this structure:
```
new-provider/
├── README.md
├── provider.js
├── schemas.js
├── config.example.js
└── example.js
```

