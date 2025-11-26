# Stripe Checkout Provider Pattern

Single-tenant Stripe Checkout implementation for `@classytic/revenue`.

## Use Case

- ✅ Single business accepting payments
- ✅ Stripe-hosted checkout page
- ✅ Support for subscriptions and one-time payments
- ✅ Automatic webhook handling
- ✅ Built-in refund support

## Features

- Stripe Checkout Sessions (hosted page)
- Customer management
- Payment method storage
- Webhook verification
- Refund processing
- TypeScript support

## Installation

```bash
npm install stripe
```

## Configuration

```javascript
import { StripeCheckoutProvider } from './providers/StripeCheckoutProvider.js';

const stripeProvider = new StripeCheckoutProvider({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  successUrl: 'https://yoursite.com/payment/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://yoursite.com/payment/cancel',
  
  // Optional:
  mode: 'payment', // or 'subscription'
  allowedCountries: ['US', 'CA', 'GB'],
});
```

## Environment Variables

```env
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL=https://yoursite.com/success
STRIPE_CANCEL_URL=https://yoursite.com/cancel
```

## Schema Setup

Add Stripe customer data to your Customer/User model:

```javascript
import { stripeCustomerSchema } from './schemas/stripe.js';

const customerSchema = new mongoose.Schema({
  name: String,
  email: String,
  
  // Add Stripe customer data
  stripe: stripeCustomerSchema,
});
```

## Usage

### Create Payment

```javascript
const { subscription, transaction, paymentIntent } = 
  await revenue.monetization.create({
    data: { organizationId, customerId },
    planKey: 'monthly',
    amount: 2999, // $29.99 in cents
    currency: 'USD',
    gateway: 'stripe',
    paymentData: {
      method: 'card',
      customerEmail: 'customer@example.com',
    },
  });

// Redirect user to Stripe Checkout
res.redirect(paymentIntent.paymentUrl);
```

### Handle Success (Frontend)

```javascript
// After successful payment, Stripe redirects to successUrl
// Extract session_id from URL and verify

const sessionId = new URLSearchParams(window.location.search).get('session_id');

// Verify payment on backend
await fetch('/api/verify-payment', {
  method: 'POST',
  body: JSON.stringify({ sessionId }),
});
```

### Verify Payment (Backend)

```javascript
app.post('/api/verify-payment', async (req, res) => {
  const { sessionId } = req.body;
  
  const { transaction } = await revenue.payments.verify(sessionId);
  
  res.json({ success: true, transaction });
});
```

### Handle Webhooks

```javascript
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { event, transaction } = await revenue.payments.handleWebhook(
      'stripe',
      req.body,
      req.headers
    );
    
    // Handle different event types
    switch (event.type) {
      case 'payment.succeeded':
        console.log('Payment successful:', transaction._id);
        break;
      case 'payment.failed':
        console.log('Payment failed:', transaction._id);
        break;
      case 'refund.succeeded':
        console.log('Refund processed:', transaction._id);
        break;
    }
    
    res.json({ received: true });
  } catch (error) {
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});
```

### Process Refund

```javascript
const { refundTransaction } = await revenue.payments.refund(
  transaction._id,
  1000, // Refund $10.00
  { reason: 'Customer requested' }
);
```

## Testing

### Test Mode

Use Stripe test keys:
```env
STRIPE_SECRET_KEY=sk_test_...
```

### Test Cards

```javascript
// Successful payment
Card: 4242 4242 4242 4242
Exp: Any future date
CVC: Any 3 digits

// Declined payment
Card: 4000 0000 0000 0002
```

### Webhook Testing

```bash
# Install Stripe CLI
stripe listen --forward-to localhost:3000/webhooks/stripe

# Get webhook secret
stripe listen --print-secret
```

## Notes

- Checkout Sessions expire after 24 hours
- Stripe handles PCI compliance (no card data touches your server)
- Customer data is automatically created/reused
- Supports 135+ currencies
- Built-in fraud detection

## Stripe Dashboard

View transactions: https://dashboard.stripe.com/test/payments

