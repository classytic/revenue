# SSLCommerz Provider Pattern

Bangladesh's leading payment gateway implementation for `@classytic/revenue`.

## Use Case

- ✅ Bangladesh-based businesses
- ✅ Accept bKash, Nagad, Rocket, cards
- ✅ Local bank transfers
- ✅ Mobile banking
- ✅ Hosted payment page

## Features

- All Bangladesh payment methods
- Hosted payment page (redirect)
- IPN (Instant Payment Notification) webhooks
- Automatic transaction validation
- Refund support
- Multi-currency (BDT, USD, EUR, GBP)

## Installation

```bash
npm install sslcommerz-lts
```

## Configuration

```javascript
import { SSLCommerzProvider } from './providers/SSLCommerzProvider.js';

const sslcommerzProvider = new SSLCommerzProvider({
  storeId: process.env.SSLCOMMERZ_STORE_ID,
  storePassword: process.env.SSLCOMMERZ_STORE_PASSWORD,
  isLive: process.env.NODE_ENV === 'production',
  
  // Success/Fail/Cancel URLs
  successUrl: `${process.env.APP_URL}/payment/success`,
  failUrl: `${process.env.APP_URL}/payment/fail`,
  cancelUrl: `${process.env.APP_URL}/payment/cancel`,
  ipnUrl: `${process.env.APP_URL}/webhooks/sslcommerz`,
});
```

## Environment Variables

```env
# Sandbox (Testing)
SSLCOMMERZ_STORE_ID=test_store
SSLCOMMERZ_STORE_PASSWORD=test_password

# Production
# SSLCOMMERZ_STORE_ID=your_live_store
# SSLCOMMERZ_STORE_PASSWORD=your_live_password

APP_URL=https://yoursite.com
```

## Usage

### Create Payment

```javascript
const { transaction, paymentIntent } = await revenue.monetization.create({
  data: {
    organizationId,
    customerId,
  },
  planKey: 'monthly',
  amount: 1500, // 1500 BDT
  currency: 'BDT',
  gateway: 'sslcommerz',
  paymentData: {
    method: 'bkash', // or 'nagad', 'rocket', 'card'
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    customerAddress: customer.address,
  },
});

// Redirect to payment page
res.redirect(paymentIntent.paymentUrl);
```

### Handle Success Callback

```javascript
app.post('/payment/success', express.urlencoded({ extended: true }), async (req, res) => {
  const { tran_id } = req.body;
  
  // Verify payment
  const { transaction } = await revenue.payments.verify(tran_id);
  
  res.render('payment-success', { transaction });
});
```

### Handle IPN (Webhook)

```javascript
app.post('/webhooks/sslcommerz', express.json(), async (req, res) => {
  try {
    const { event, transaction } = await revenue.payments.handleWebhook(
      'sslcommerz',
      req.body,
      req.headers
    );
    
    console.log('IPN received:', event.type);
    res.json({ status: 'SUCCESS' });
  } catch (error) {
    res.status(400).json({ status: 'FAILED', message: error.message });
  }
});
```

## Supported Payment Methods

| Method | Type | Fees |
|--------|------|------|
| bKash | Mobile Banking | 1.8% |
| Nagad | Mobile Banking | 1.5% |
| Rocket | Mobile Banking | 2.0% |
| DBBL Nexus | Card | 2.5% |
| Visa/Mastercard | Card | 2.5% |
| Bank Transfer | Direct | 1.5% |

## Testing

### Test Credentials

```
Store ID: test_store
Store Password: test_password
```

### Test Cards

```
Visa: 4111 1111 1111 1111
Mastercard: 5555 5555 5555 4444
CVV: Any 3 digits
Expiry: Any future date
```

### Test Mobile Banking

```
For Sandbox: Use any phone number and follow test flow
```

## Notes

- Hosted payment page (user leaves your site)
- IPN (webhook) confirms payment asynchronously
- Always validate via IPN, not just success callback
- Refunds take 5-7 business days
- BDT is primary currency
- 24/7 customer support

## SSLCommerz Dashboard

Sandbox: https://sandbox.sslcommerz.com/
Live: https://merchant.sslcommerz.com/

