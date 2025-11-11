/**
 * Stripe Checkout Provider Configuration Example
 */

import { createRevenue } from '@classytic/revenue';
import { StripeCheckoutProvider } from './provider.js';
import Transaction from './models/Transaction.js';

// ============================================================
// CONFIGURATION
// ============================================================

const stripeProvider = new StripeCheckoutProvider({
  // Required: Stripe secret key
  secretKey: process.env.STRIPE_SECRET_KEY,
  
  // Required: Webhook secret (get from Stripe Dashboard or CLI)
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  
  // Required: Success/Cancel URLs
  successUrl: `${process.env.APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
  cancelUrl: `${process.env.APP_URL}/payment/cancel`,
  
  // Optional: Payment mode ('payment' for one-time, 'subscription' for recurring)
  mode: 'payment',
  
  // Optional: Restrict payments to specific countries
  allowedCountries: ['US', 'CA', 'GB', 'AU'], // Or null for all countries
});

// ============================================================
// REVENUE INSTANCE
// ============================================================

const revenue = createRevenue({
  models: {
    Transaction,
    // Subscription, // Optional
  },
  
  providers: {
    stripe: stripeProvider,
  },
  
  config: {
    // Transaction type mapping
    transactionTypeMapping: {
      subscription: 'income',
      purchase: 'income',
      refund: 'expense',
    },
    
    // Category mappings
    categoryMappings: {
      ProductPurchase: 'product_purchase',
      ServiceSubscription: 'service_subscription',
    },
    
    // Commission rates (optional)
    commissionRates: {
      'product_purchase': 0.05,        // 5%
      'service_subscription': 0.10,    // 10%
    },
    
    // Gateway fees (optional)
    gatewayFeeRates: {
      'stripe': 0.029,  // 2.9% + $0.30 (handle fixed fee separately if needed)
    },
  },
  
  hooks: {
    'payment.verified': async ({ transaction }) => {
      console.log('✅ Payment verified:', transaction._id);
      // Send confirmation email, etc.
    },
    
    'payment.refunded': async ({ transaction, refundTransaction }) => {
      console.log('💸 Refund processed:', refundTransaction._id);
      // Send refund notification
    },
  },
});

export default revenue;

// ============================================================
// ENVIRONMENT VARIABLES (.env file)
// ============================================================

/*
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_51...
STRIPE_WEBHOOK_SECRET=whsec_...

# App URLs
APP_URL=http://localhost:3000

# For production:
# STRIPE_SECRET_KEY=sk_live_51...
# APP_URL=https://yourapp.com
*/

// ============================================================
// WEBHOOK ENDPOINT SETUP
// ============================================================

/*
// Express.js example
import express from 'express';

const app = express();

// ⚠️ Important: Use raw body for webhook verification
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const { event, transaction } = await revenue.payments.handleWebhook(
        'stripe',
        req.body,
        req.headers
      );
      
      console.log('Webhook received:', event.type);
      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error.message);
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }
);

// Regular endpoints use JSON parser
app.use(express.json());
*/

// ============================================================
// STRIPE DASHBOARD SETUP
// ============================================================

/*
1. Go to: https://dashboard.stripe.com/webhooks
2. Click "Add endpoint"
3. Enter your webhook URL: https://yourapp.com/webhooks/stripe
4. Select events to listen for:
   - checkout.session.completed
   - checkout.session.expired
   - payment_intent.succeeded
   - payment_intent.payment_failed
   - charge.refunded
5. Copy the webhook secret to your .env file
*/

