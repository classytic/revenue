# Escrow & Multi-Party Split Features

**@classytic/revenue v0.1.0**

Platform-as-intermediary payment flow with affiliate commission support.

---

## What's New

### 1. Escrow Service
Hold funds, verify, split, and release to multiple parties.

```javascript
import { createRevenue } from '@classytic/revenue';

const revenue = createRevenue({ ... });

// Hold funds
await revenue.escrow.hold(transactionId);

// Split to multiple recipients
await revenue.escrow.split(transactionId, [
  { type: 'platform_commission', recipientId: 'platform', rate: 0.10 },
  { type: 'affiliate_commission', recipientId: 'affiliate-123', rate: 0.05 },
]);

// Release to organization
await revenue.escrow.release(transactionId, {
  recipientId: 'org-123',
  recipientType: 'organization',
});
```

### 2. Multi-Party Commission Splits
Distribute revenue across platform, affiliates, partners.

```javascript
import { calculateSplits } from '@classytic/revenue';

const splits = calculateSplits(1000, [
  { type: 'platform_commission', recipientId: 'platform', rate: 0.10 },
  { type: 'affiliate_commission', recipientId: 'affiliate-1', rate: 0.05 },
  { type: 'affiliate_commission', recipientId: 'affiliate-2', rate: 0.02 },
]);

// Result:
// [
//   { type: 'platform_commission', grossAmount: 100, netAmount: 100, ... },
//   { type: 'affiliate_commission', grossAmount: 50, netAmount: 50, ... },
//   { type: 'affiliate_commission', grossAmount: 20, netAmount: 20, ... },
// ]
```

### 3. Affiliate Commission Helper
Simplified API for common affiliate scenarios.

```javascript
import { calculateCommissionWithSplits } from '@classytic/revenue';

const commission = calculateCommissionWithSplits(
  1000,          // amount
  0.10,          // platform rate
  0.029,         // gateway fee rate
  {
    affiliateRate: 0.05,
    affiliateId: 'affiliate-123',
  }
);

// Returns commission with affiliate split
```

### 4. New Schemas (Spreadable)
Use in your transaction models.

```javascript
import { holdSchema, splitsSchema } from '@classytic/revenue';

const TransactionSchema = new Schema({
  // ... existing fields
  ...holdSchema,        // Adds: hold.status, hold.heldAmount, etc.
  ...splitsSchema,      // Adds: splits array
});
```

### 5. New Enums

```javascript
import {
  HOLD_STATUS,
  RELEASE_REASON,
  SPLIT_TYPE,
  SPLIT_STATUS,
  PAYOUT_METHOD,
} from '@classytic/revenue';
```

---

## Use Cases

### E-commerce Marketplace
Platform holds payment → Verifies delivery → Deducts commission → Pays seller

### Course Platform with Affiliates
Student pays → Platform holds → Deducts platform fee + affiliate commission → Pays instructor

### SaaS Reseller Program
Customer subscribes → Platform receives → Splits to: platform, reseller, partner

### Multi-Level Marketing
Sale made → Platform holds → Distributes to: platform, level-1 affiliate, level-2 affiliate

---

## Payment Flow

### Traditional Direct Payment
```
Customer → Gateway → Organization
                    ↓
                 Platform tracks commission owed
```

### New Escrow Flow
```
Customer → Gateway → Platform (holds in escrow)
                    ↓
                 Verify payment
                    ↓
                 Split to: Platform, Affiliate, Partner
                    ↓
                 Release remainder to Organization
```

---

## API Reference

### EscrowService

```javascript
// Hold funds
await revenue.escrow.hold(transactionId, options);

// Release funds
await revenue.escrow.release(transactionId, {
  amount: 500,              // Optional: partial release
  recipientId: 'org-123',
  recipientType: 'organization',
  reason: 'payment_verified',
});

// Split payment
await revenue.escrow.split(transactionId, [
  { type: 'platform_commission', recipientId: 'platform', rate: 0.10 },
  { type: 'affiliate_commission', recipientId: 'aff-123', rate: 0.05 },
]);

// Cancel hold
await revenue.escrow.cancel(transactionId, { reason: 'fraud_detected' });

// Get status
await revenue.escrow.getStatus(transactionId);
```

### Utilities

```javascript
import {
  calculateSplits,
  calculateOrganizationPayout,
  reverseSplits,
  calculateCommissionWithSplits,
} from '@classytic/revenue';

// Calculate splits
const splits = calculateSplits(amount, splitRules, gatewayFeeRate);

// Calculate organization payout
const payout = calculateOrganizationPayout(amount, splits);

// Reverse splits on refund
const reversed = reverseSplits(originalSplits, originalAmount, refundAmount);

// Calculate with affiliate
const commission = calculateCommissionWithSplits(amount, platformRate, gatewayFeeRate, {
  affiliateRate: 0.05,
  affiliateId: 'affiliate-123',
});
```

---

## Migration Guide

### For Existing Apps

**No breaking changes.** All existing functionality works as before.

Escrow features are **opt-in**:
- Don't use `revenue.escrow.*` → Works exactly as before
- Commission calculation unchanged (backward compatible)
- Schemas are spreadable (not forced)

### Enabling Escrow

```javascript
// 1. Update transaction model (optional)
import { holdSchema, splitsSchema } from '@classytic/revenue';

TransactionSchema.add(holdSchema);
TransactionSchema.add(splitsSchema);

// 2. Use escrow service
await revenue.escrow.hold(transactionId);
await revenue.escrow.split(transactionId, splitRules);
await revenue.escrow.release(transactionId, options);
```

---

## Examples

See [examples/](./revenue/examples/) folder:
- `escrow-flow.js` - Complete escrow workflow
- `affiliate-commission.js` - Multi-party splits
- `commission-tracking.js` - Commission management
- `complete-flow.js` - End-to-end flows

---

## Event Hooks

New hooks for escrow operations:

```javascript
hooks: {
  'escrow.held': [async ({ transaction, heldAmount }) => { ... }],
  'escrow.released': [async ({ transaction, releaseAmount, recipientId }) => { ... }],
  'escrow.split': [async ({ transaction, splits, organizationPayout }) => { ... }],
  'escrow.cancelled': [async ({ transaction, reason }) => { ... }],
}
```

---

## Design Principles

✅ **No breaking changes** - Existing apps unaffected
✅ **Opt-in** - Use escrow only when needed
✅ **Spreadable schemas** - Users control their models
✅ **Clean separation** - Escrow logic isolated
✅ **Database agnostic** - Patterns work across databases
✅ **Production ready** - Battle-tested patterns

---

## Version

- **Previous**: v0.0.24 - Basic commission tracking
- **Current**: v0.1.0 - Escrow + multi-party splits
- **Next**: v0.2.0 - Scheduled payouts, batch processing

---

## License

MIT - Use freely in your projects
