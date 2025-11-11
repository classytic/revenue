# Stripe Connect Standard Provider Pattern

Multi-tenant marketplace implementation using Stripe Connect Standard accounts.

## Use Case

- ✅ Multi-vendor marketplace/platform
- ✅ Vendors have their own Stripe accounts
- ✅ Stripe handles vendor onboarding
- ✅ Platform takes commission (handled by @classytic/revenue)
- ✅ Vendors receive payouts directly from Stripe

## Stripe Connect Account Types

| Type | Onboarding | Control | Best For |
|------|------------|---------|----------|
| **Standard** | Vendor owns Stripe account | Vendor controls | Established vendors, transparency |
| **Express** | Embedded onboarding | Platform controls | Quick setup, less vendor control |
| **Custom** | Fully custom UX | Platform controls | Complete customization, complex |

**This pattern uses Standard accounts** - easiest to implement, vendors have full control.

## Features

- Automatic vendor onboarding
- Direct payouts to vendors
- Platform commission (via revenue config, not Stripe fees)
- Separate financial reporting per vendor
- Vendor dashboard access
- Webhook handling for all accounts

## Installation

```bash
npm install stripe
```

## Configuration

```javascript
import { StripeConnectStandardProvider } from './providers/StripeConnectStandardProvider.js';

const stripeProvider = new StripeConnectStandardProvider({
  platformSecretKey: process.env.STRIPE_PLATFORM_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  
  // OAuth settings for Connect onboarding
  clientId: process.env.STRIPE_CLIENT_ID,
  redirectUri: `${process.env.APP_URL}/connect/callback`,
  
  // Success/Cancel URLs for checkout
  successUrl: `${process.env.APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
  cancelUrl: `${process.env.APP_URL}/payment/cancel`,
});
```

## Environment Variables

```env
STRIPE_PLATFORM_SECRET_KEY=sk_test_...
STRIPE_CLIENT_ID=ca_...
STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=https://yourplatform.com
```

## Schemas

Add to Organization/Vendor model:

```javascript
import { stripeConnectAccountSchema } from './schemas/stripe-connect.js';

const organizationSchema = new mongoose.Schema({
  name: String,
  email: String,
  
  // Stripe Connect account
  stripeConnect: stripeConnectAccountSchema,
});
```

## Workflow

### 1. Vendor Onboarding

```javascript
// Generate onboarding link
app.get('/vendors/:id/connect', async (req, res) => {
  const vendor = await Organization.findById(req.params.id);
  
  const onboardingUrl = await stripeProvider.createConnectAccountLink({
    organizationId: vendor._id,
    email: vendor.email,
    businessName: vendor.name,
    returnUrl: `${process.env.APP_URL}/vendors/${vendor._id}/dashboard`,
    refreshUrl: `${process.env.APP_URL}/vendors/${vendor._id}/connect`,
  });
  
  res.redirect(onboardingUrl);
});
```

### 2. Handle OAuth Callback

```javascript
app.get('/connect/callback', async (req, res) => {
  const { code, state } = req.query;
  
  // Exchange code for account ID
  const accountId = await stripeProvider.handleOAuthCallback(code);
  
  // Save to vendor
  const vendor = await Organization.findById(state);
  vendor.stripeConnect = {
    accountId,
    connected: true,
    connectedAt: new Date(),
  };
  await vendor.save();
  
  res.redirect(`/vendors/${vendor._id}/dashboard?connected=true`);
});
```

### 3. Create Payment

```javascript
// Customer buys from vendor
const { transaction, paymentIntent } = await revenue.subscriptions.create({
  data: {
    organizationId: vendor._id,
    customerId: customer._id,
  },
  planKey: 'one-time',
  amount: 5000, // $50.00
  gateway: 'stripe-connect',
  entity: 'ProductOrder',
  monetizationType: 'purchase',
  paymentData: {
    method: 'card',
  },
  metadata: {
    connectedAccountId: vendor.stripeConnect.accountId, // ⭐ Required
  },
});

// Commission calculated by @classytic/revenue
console.log(transaction.commission);
// {
//   rate: 0.10,           // 10% platform commission
//   grossAmount: 500,      // 10% of 5000
//   gatewayFeeAmount: 145, // 2.9% Stripe fee
//   netAmount: 355,        // Platform keeps 355 cents
// }

// Vendor receives: 5000 - 0 = $50.00 (full amount)
// Platform tracks: $3.55 commission (handled separately)
```

## Key Differences from Single-Tenant

| Aspect | Single-Tenant | Connect Standard |
|--------|---------------|------------------|
| **Stripe Account** | One platform account | One account per vendor |
| **Onboarding** | Not needed | Vendor OAuth flow |
| **Payouts** | Platform receives | Vendors receive directly |
| **Commission** | Via Stripe fees | Via revenue config |
| **Dashboard** | Platform only | Vendors have own dashboard |

## Commission Handling

**Important:** Stripe Connect Standard does NOT automatically deduct platform commission. You track commission via `@classytic/revenue` and collect separately.

```javascript
// 1. Payment goes entirely to vendor
// 2. Commission tracked in transaction
const revenue = createRevenue({
  config: {
    commissionRates: {
      'product_order': 0.10,  // 10% commission
    },
    gatewayFeeRates: {
      'stripe-connect': 0.029,  // 2.9% Stripe fee
    },
  },
});

// 3. Query pending commissions
const pending = await Transaction.find({
  'commission.status': 'pending',
  'gateway.type': 'stripe-connect',
});

// 4. Invoice vendors separately or deduct from future payouts
```

## Notes

- Vendors control their own Stripe dashboard
- Platform cannot access vendor funds
- Vendors handle their own taxes and compliance
- Best for marketplaces with established vendors
- More transparent than Express/Custom accounts

## Stripe Dashboard

- Platform: https://dashboard.stripe.com/test/connect/accounts
- Vendors: Each has their own dashboard link

