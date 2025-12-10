# Escrow & Multi-Party Split Features

Platform-as-intermediary payment flow with affiliate commission support.

---

## Overview

The escrow system enables:
- **Hold funds** - Collect payment, hold until conditions met
- **Multi-party splits** - Distribute to platform, affiliates, partners
- **Conditional release** - Release on delivery confirmation, milestone, etc.
- **Automatic refunds** - Return funds if conditions not met

---

## Quick Start

```typescript
import { Revenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction })
  .withProvider('manual', new ManualProvider())
  .withCommission(10, 2.9)
  .build();

// 1. Create payment
const { transaction } = await revenue.monetization.create({
  data: { customerId, organizationId },
  planKey: 'order',
  monetizationType: 'purchase',
  amount: 10000, // $100
  gateway: 'manual',
});

// 2. Verify payment
await revenue.payments.verify(transaction._id.toString());

// 3. Hold in escrow
await revenue.escrow.hold(transaction._id.toString(), {
  reason: 'Awaiting delivery confirmation',
  holdUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
});

// 4. Split to multiple recipients
await revenue.escrow.split(transaction._id.toString(), [
  { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.10 },
  { type: 'affiliate_commission', recipientId: 'aff_123', recipientType: 'user', rate: 0.05 },
]);

// 5. Release to vendor (after delivery confirmed)
await revenue.escrow.release(transaction._id.toString(), {
  recipientId: 'vendor_456',
  recipientType: 'organization',
  notes: 'Delivery confirmed',
});
```

---

## Use Cases

### E-commerce Marketplace
```
Customer pays $100
    ↓
Platform holds in escrow
    ↓
Delivery confirmed
    ↓
Split: Platform 10% ($10), Vendor 90% ($90)
```

### Course Platform with Affiliates
```
Student pays $50
    ↓
Platform holds
    ↓
Split: Platform 15% ($7.50), Affiliate 5% ($2.50), Instructor 80% ($40)
```

### Group Buy / Crowdfunding
```
Multiple customers pledge
    ↓
Funds held until target reached
    ↓
Target reached → Release to merchant
Target missed → Refund all customers
```

---

## API Reference

### Hold Funds

```typescript
await revenue.escrow.hold(transactionId, {
  reason: 'payment_verification', // or custom string
  holdUntil: new Date('2024-12-31'),
  metadata: { orderId: '123' },
});
```

### Split Payment

```typescript
await revenue.escrow.split(transactionId, [
  { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.10 },
  { type: 'affiliate_commission', recipientId: 'aff_123', recipientType: 'user', rate: 0.05 },
  { type: 'partner_commission', recipientId: 'partner_456', recipientType: 'organization', rate: 0.03 },
]);
// Remainder automatically goes to organization
```

### Release Funds

```typescript
// Full release
await revenue.escrow.release(transactionId, {
  recipientId: 'vendor_123',
  recipientType: 'organization',
});

// Partial release
await revenue.escrow.release(transactionId, {
  amount: 5000, // $50 of $100
  recipientId: 'vendor_123',
  recipientType: 'organization',
});
```

### Cancel Hold

```typescript
await revenue.escrow.cancelHold(transactionId, {
  reason: 'Order cancelled by customer',
});
```

### Get Status

```typescript
const status = await revenue.escrow.getStatus(transactionId);
// {
//   transaction: {...},
//   status: 'held',
//   heldAmount: 10000,
//   releasedAmount: 0,
// }
```

---

## Commission Utilities

### Calculate Splits

```typescript
import { calculateSplits } from '@classytic/revenue';

const splits = calculateSplits(
  10000, // $100
  [
    { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.10 },
    { type: 'affiliate_commission', recipientId: 'level1', recipientType: 'user', rate: 0.05 },
    { type: 'affiliate_commission', recipientId: 'level2', recipientType: 'user', rate: 0.02 },
  ],
  0.029 // Gateway fee
);

// Result:
// Platform: $10 gross, $7.10 net (after 2.9% fee)
// Level 1: $5 gross, $5 net
// Level 2: $2 gross, $2 net
// Organization receives: $83
```

### Calculate Commission with Affiliate

```typescript
import { calculateCommissionWithSplits } from '@classytic/revenue';

const commission = calculateCommissionWithSplits(
  10000,  // $100
  0.10,   // 10% platform
  0.029,  // 2.9% gateway
  {
    affiliateRate: 0.05,
    affiliateId: 'affiliate_123',
  }
);

// {
//   grossAmount: 1000,
//   gatewayFeeAmount: 290,
//   netAmount: 710,
//   affiliate: { grossAmount: 500, netAmount: 500 },
// }
```

---

## Transaction Model Setup

Add escrow fields to your Transaction model:

```typescript
import {
  gatewaySchema,
  commissionSchema,
  holdSchema,
  splitSchema,
} from '@classytic/revenue';

const TransactionSchema = new Schema({
  // ... core fields ...
  
  // Library schemas
  gateway: gatewaySchema,
  commission: commissionSchema,
  hold: holdSchema,
  splits: [splitSchema],
});
```

---

## Events

```typescript
revenue.on('escrow.held', (event) => {
  console.log('Funds held:', event.transactionId, event.amount);
});

revenue.on('escrow.released', (event) => {
  console.log('Funds released:', event.transactionId, event.releasedAmount);
});

revenue.on('escrow.split', (event) => {
  console.log('Payment split:', event.splits);
});
```

---

## Best Practices

1. **Always verify payment before holding** - Only hold verified funds
2. **Set holdUntil dates** - Prevent indefinite holds
3. **Log all releases** - Audit trail for disputes
4. **Handle partial releases** - For milestone-based payments
5. **Test refund flows** - Ensure customers can get money back

---

## Related

- [Group Buy Guide](./GROUP_BUY_GUIDE.md) - Crowdfunding implementation
- [Examples](../../revenue/examples/03-escrow-splits.ts) - Working code
