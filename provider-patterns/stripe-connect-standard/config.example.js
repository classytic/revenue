/**
 * Stripe Connect Standard - Configuration Example
 */

import { createRevenue } from '@classytic/revenue';
import { StripeConnectStandardProvider } from './provider.js';
import Transaction from './models/Transaction.js';

// ============================================================
// STRIPE CONNECT PROVIDER
// ============================================================

const stripeConnectProvider = new StripeConnectStandardProvider({
  // Platform's Stripe secret key
  platformSecretKey: process.env.STRIPE_PLATFORM_SECRET_KEY,
  
  // Webhook secret
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  
  // OAuth settings (for vendor onboarding)
  clientId: process.env.STRIPE_CLIENT_ID,
  redirectUri: `${process.env.APP_URL}/connect/oauth/callback`,
  
  // Checkout URLs
  successUrl: `${process.env.APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
  cancelUrl: `${process.env.APP_URL}/payment/cancel`,
});

// ============================================================
// REVENUE INSTANCE
// ============================================================

const revenue = createRevenue({
  models: { Transaction },
  
  providers: {
    'stripe-connect': stripeConnectProvider,
  },
  
  config: {
    // Transaction types
    transactionTypeMapping: {
      purchase: 'income',
      subscription: 'income',
      refund: 'expense',
    },
    
    // Categories
    categoryMappings: {
      ProductOrder: 'product_order',
      ServiceOrder: 'service_order',
      CourseEnrollment: 'course_enrollment',
    },
    
    // ⭐ Commission rates
    // Note: With Stripe Connect Standard, vendors receive full amount
    // You track commission separately and invoice/deduct from future sales
    commissionRates: {
      'product_order': 0.10,        // 10% platform commission
      'service_order': 0.15,        // 15% platform commission
      'course_enrollment': 0.10,    // 10% platform commission
    },
    
    // Gateway fees (for accounting)
    gatewayFeeRates: {
      'stripe-connect': 0.029,  // 2.9% + $0.30 Stripe fee
    },
  },
  
  hooks: {
    'payment.verified': async ({ transaction }) => {
      console.log('Payment verified:', transaction._id);
      console.log('Vendor receives: Full amount (payout via Stripe)');
      console.log('Commission tracked:', transaction.commission);
    },
  },
});

export default revenue;

// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

/*
# Stripe Connect Configuration
STRIPE_PLATFORM_SECRET_KEY=sk_test_51...
STRIPE_CLIENT_ID=ca_...
STRIPE_WEBHOOK_SECRET=whsec_...

# App URLs
APP_URL=http://localhost:3000

# For production:
# STRIPE_PLATFORM_SECRET_KEY=sk_live_51...
# APP_URL=https://yourplatform.com
*/

// ============================================================
// COMMISSION HANDLING NOTES
// ============================================================

/*
Stripe Connect Standard accounts:
- Vendors receive 100% of payment directly from Stripe
- Platform commission is tracked in transaction.commission
- Platform invoices vendors or deducts from future sales

Example:
1. Customer pays $100
2. Vendor receives $100 (via Stripe payout)
3. Transaction records commission: $10 pending
4. Platform invoices vendor for $10
5. Or deduct from next sale

Query pending commissions:
```javascript
const pending = await Transaction.find({
  'commission.status': 'pending',
  type: 'income',
});

const totalDue = pending.reduce((sum, t) => sum + t.commission.netAmount, 0);
console.log(`Total commission due: $${totalDue / 100}`);
```
*/

