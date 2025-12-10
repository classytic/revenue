# Group Buy Implementation Guide

Crowdfunding & group purchase features using the escrow system.

---

## What is Group Buy?

**Tiered pricing based on quantity:**
- 4 orders → $10 per person
- 10 orders → $8.50 per person
- 20 orders → $7 per person

**Time-limited campaign:**
- Runs for X days
- Payment held in escrow until target reached
- Refund if target not met

---

## Architecture

### Library Handles ✅

- Escrow (hold/release)
- Multi-party splits
- Payment processing
- Refunds
- Transaction accounting

### You Implement 🔨

- Campaign model (dates, tiers, targets)
- Pledge tracking
- Tier calculation
- Auto-finalize workflow

---

## Implementation

### 1. Campaign Model (Your Domain)

```typescript
const campaignSchema = new mongoose.Schema({
  productId: { type: ObjectId, ref: 'Product', required: true },
  merchantId: { type: ObjectId, ref: 'Organization', required: true },
  
  pricingTiers: [{
    minOrders: { type: Number, required: true },
    pricePerUnit: { type: Number, required: true },
  }],
  
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  
  status: {
    type: String,
    enum: ['draft', 'active', 'successful', 'failed', 'cancelled'],
    default: 'draft',
  },
  
  currentPledges: { type: Number, default: 0 },
  targetPledges: { type: Number, required: true },
});
```

### 2. Pledge Model (Your Domain)

```typescript
const pledgeSchema = new mongoose.Schema({
  campaignId: { type: ObjectId, ref: 'Campaign', required: true },
  customerId: { type: ObjectId, ref: 'Customer', required: true },
  transactionId: { type: ObjectId, ref: 'Transaction', required: true },
  
  pledgedAmount: { type: Number, required: true },
  finalAmount: { type: Number },
  
  status: {
    type: String,
    enum: ['pending', 'held', 'confirmed', 'refunded'],
    default: 'pending',
  },
});
```

### 3. Customer Makes Pledge

```typescript
import { Revenue } from '@classytic/revenue';

async function createPledge(campaignId: string, customerId: string) {
  const campaign = await Campaign.findById(campaignId);
  
  if (campaign.status !== 'active') {
    throw new Error('Campaign is not active');
  }
  
  const currentPrice = calculateCurrentPrice(campaign);
  
  // Create transaction
  const { transaction } = await revenue.monetization.create({
    data: {
      organizationId: campaign.merchantId,
      customerId,
      referenceId: campaignId,
      referenceModel: 'Campaign',
    },
    planKey: 'group_buy',
    monetizationType: 'purchase',
    amount: currentPrice,
    gateway: 'stripe',
  });
  
  // Verify payment
  await revenue.payments.verify(transaction._id.toString());
  
  // Hold in escrow
  await revenue.escrow.hold(transaction._id.toString(), {
    reason: 'Group buy - awaiting campaign completion',
    holdUntil: campaign.endDate,
  });
  
  // Create pledge
  const pledge = await Pledge.create({
    campaignId,
    customerId,
    transactionId: transaction._id,
    pledgedAmount: currentPrice,
    status: 'held',
  });
  
  // Update campaign
  campaign.currentPledges += 1;
  await campaign.save();
  
  return { pledge, transaction };
}

function calculateCurrentPrice(campaign: any): number {
  const tiers = campaign.pricingTiers.sort((a: any, b: any) => b.minOrders - a.minOrders);
  
  for (const tier of tiers) {
    if (campaign.currentPledges >= tier.minOrders) {
      return tier.pricePerUnit;
    }
  }
  
  return tiers[tiers.length - 1].pricePerUnit;
}
```

### 4. Campaign Ends - Finalize

```typescript
async function finalizeCampaign(campaignId: string) {
  const campaign = await Campaign.findById(campaignId);
  const pledges = await Pledge.find({ campaignId, status: 'held' });
  
  const isSuccessful = campaign.currentPledges >= campaign.targetPledges;
  
  if (isSuccessful) {
    // SUCCESS: Release payments
    const finalPrice = calculateCurrentPrice(campaign);
    
    for (const pledge of pledges) {
      const priceDiff = pledge.pledgedAmount - finalPrice;
      
      // Partial refund if tier improved
      if (priceDiff > 0) {
        await revenue.payments.refund(
          pledge.transactionId.toString(),
          priceDiff,
          { reason: 'Better tier achieved' }
        );
      }
      
      // Split and release
      await revenue.escrow.split(pledge.transactionId.toString(), [
        { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.05 },
      ]);
      
      pledge.finalAmount = finalPrice;
      pledge.status = 'confirmed';
      await pledge.save();
    }
    
    campaign.status = 'successful';
    await campaign.save();
    
  } else {
    // FAILED: Refund all
    for (const pledge of pledges) {
      await revenue.escrow.cancelHold(pledge.transactionId.toString(), {
        reason: 'Campaign did not reach target',
      });
      
      await revenue.payments.refund(pledge.transactionId.toString());
      
      pledge.status = 'refunded';
      await pledge.save();
    }
    
    campaign.status = 'failed';
    await campaign.save();
  }
}
```

### 5. Scheduled Job

```typescript
// Run hourly to check expired campaigns
async function checkExpiredCampaigns() {
  const expired = await Campaign.find({
    status: 'active',
    endDate: { $lte: new Date() },
  });
  
  for (const campaign of expired) {
    await finalizeCampaign(campaign._id.toString());
  }
}

// Cron: every hour
cron.schedule('0 * * * *', checkExpiredCampaigns);
```

---

## Flow Diagram

```
Customer 1 pledges $10
    ↓
revenue.payments.verify()
    ↓
revenue.escrow.hold()
    ↓
campaign.currentPledges++ (1 → 2 → ... → 10)

Campaign reaches 10 pledges!
    ↓
Final tier: $8.50 per person
    ↓
For each pledge:
  ├── Pledged $10, Final $8.50 → Refund $1.50
  ├── revenue.escrow.split() → Platform 5%
  └── pledge.status = 'confirmed'

Campaign status = 'successful' ✅
```

**If campaign fails:**
```
Campaign expires with 3 pledges (target: 4)
    ↓
For each pledge:
  ├── revenue.escrow.cancelHold()
  ├── revenue.payments.refund()
  └── pledge.status = 'refunded'

Campaign status = 'failed' ❌
```

---

## Advanced Features

### Dynamic Tier Display

```typescript
async function getCampaignStatus(campaignId: string) {
  const campaign = await Campaign.findById(campaignId);
  const currentPrice = calculateCurrentPrice(campaign);
  
  const nextTier = campaign.pricingTiers.find(
    (t: any) => t.minOrders > campaign.currentPledges
  );
  
  return {
    currentPrice,
    currentPledges: campaign.currentPledges,
    nextTier: nextTier ? {
      price: nextTier.pricePerUnit,
      pledgesNeeded: nextTier.minOrders - campaign.currentPledges,
    } : null,
    daysRemaining: Math.ceil((campaign.endDate - Date.now()) / (1000 * 60 * 60 * 24)),
  };
}
```

### Affiliate Referrals

```typescript
await revenue.escrow.split(transactionId, [
  { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.05 },
  { type: 'affiliate_commission', recipientId: referrerId, recipientType: 'user', rate: 0.02 },
]);
```

---

## Same Pattern Works For

- Crowdfunding campaigns
- Pre-orders with funding goals
- Flash sales with volume discounts
- Community-funded products
- Group travel bookings
