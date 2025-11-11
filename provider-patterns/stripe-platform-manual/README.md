# Stripe Platform Manual Provider Pattern

Platform collects all payments, tracks commission via @classytic/revenue, and manually pays vendors.

## Use Case

- ✅ Vendors don't have Stripe/payment accounts
- ✅ Platform collects all payments
- ✅ Commission tracked automatically
- ✅ Platform manually transfers to vendors (bank, mobile money, etc.)
- ✅ Common in developing countries

## How It Works

```
1. Customer pays → Platform Stripe account (100%)
2. Commission tracked by @classytic/revenue
3. Platform manually pays vendor (bank transfer, bKash, etc.)
4. Transaction type: 'expense' for vendor payout
```

## Features

- Single platform Stripe account
- Automatic commission calculation
- Vendor payout tracking
- Multi-currency support
- Manual payout records

## Installation

```bash
npm install stripe
```

## Configuration

```javascript
import { StripePlatformManualProvider } from './providers/StripePlatformManualProvider.js';

const stripeProvider = new StripePlatformManualProvider({
  secretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  successUrl: `${process.env.APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
  cancelUrl: `${process.env.APP_URL}/payment/cancel`,
});

const revenue = createRevenue({
  models: { Transaction },
  providers: { stripe: stripeProvider },
  
  config: {
    // ⭐ Commission rates (platform keeps this)
    commissionRates: {
      'product_order': 0.10,     // Platform keeps 10%
      'service_order': 0.15,     // Platform keeps 15%
    },
    
    gatewayFeeRates: {
      'stripe': 0.029,           // 2.9% Stripe fee
    },
  },
});
```

## Workflow

### 1. Customer Payment (Income)

```javascript
const { transaction } = await revenue.subscriptions.create({
  data: { organizationId: vendor._id, customerId },
  amount: 10000, // $100.00
  gateway: 'stripe',
  entity: 'ProductOrder',
  paymentData: { method: 'card' },
  metadata: {
    vendorId: vendor._id,  // ⭐ Track vendor
  },
});

// Commission automatically calculated
console.log(transaction.commission);
// {
//   grossAmount: 1000,     // 10% of 10000
//   gatewayFeeAmount: 290, // 2.9% of 10000
//   netAmount: 710,        // Platform keeps $7.10
// }

// Vendor receives: $100 - $7.10 = $92.90 (you pay manually)
```

### 2. Query Pending Vendor Payouts

```javascript
// Find all unpaid commissions per vendor
const vendorPayouts = await Transaction.aggregate([
  {
    $match: {
      type: 'income',
      status: 'verified',
      'commission.status': 'pending',
    }
  },
  {
    $group: {
      _id: '$metadata.vendorId',
      totalSales: { $sum: '$amount' },
      platformCommission: { $sum: '$commission.netAmount' },
      vendorPayout: {
        $sum: { $subtract: ['$amount', '$commission.grossAmount'] }
      },
      count: { $sum: 1 },
    }
  }
]);

console.log(vendorPayouts);
// [
//   {
//     _id: 'vendor_123',
//     totalSales: 50000,      // $500 total sales
//     platformCommission: 3550, // Platform keeps $35.50
//     vendorPayout: 46450,    // Vendor gets $464.50
//     count: 5,               // 5 transactions
//   }
// ]
```

### 3. Record Manual Payout (Expense)

```javascript
// When you transfer money to vendor
const payoutTransaction = await Transaction.create({
  organizationId: vendor._id,
  amount: 46450,  // Amount you're paying
  type: 'expense',  // Money going out
  method: 'bank_transfer',
  status: 'completed',
  category: 'vendor_payout',
  metadata: {
    vendorId: vendor._id,
    payoutMethod: 'bank_transfer',
    bankAccount: vendor.bankAccount,
    payoutDate: new Date(),
    coveredTransactions: pendingTransactionIds, // Reference
  },
});

// Mark commissions as paid
await Transaction.updateMany(
  {
    _id: { $in: pendingTransactionIds },
    'commission.status': 'pending',
  },
  {
    $set: { 'commission.status': 'paid' }
  }
);
```

## Accounting

```javascript
// Platform P&L
const income = await Transaction.find({ type: 'income' });
const expense = await Transaction.find({ type: 'expense' });

const totalRevenue = income.reduce((sum, t) => sum + t.amount, 0);
const totalPayouts = expense.reduce((sum, t) => sum + t.amount, 0);
const totalCommission = income.reduce((sum, t) => sum + (t.commission?.netAmount || 0), 0);

console.log('Platform Financials:');
console.log(`  Gross Revenue:   $${totalRevenue / 100}`);
console.log(`  Vendor Payouts:  $${totalPayouts / 100}`);
console.log(`  Net Commission:  $${totalCommission / 100}`);
```

## Best For

- ✅ Platforms in developing countries
- ✅ Vendors without Stripe accounts
- ✅ Simpler for vendors (no onboarding)
- ✅ Platform has full control

## Limitations

- ⚠️ Platform liable for vendor transactions
- ⚠️ Manual payout overhead
- ⚠️ Platform handles all disputes
- ⚠️ Tax complexity (platform is merchant of record)

## Alternative: Stripe Connect

If vendors can create Stripe accounts, use `stripe-connect-standard` pattern instead:
- Vendors get paid automatically
- Less manual work
- Vendors handle their own taxes

