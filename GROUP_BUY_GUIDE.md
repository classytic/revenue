# Group Buy Implementation Guide

**@classytic/revenue - Crowdfunding & Group Purchase Features**

Yes, you can implement group buy (like Groupon, crowdfunding, collective purchasing) using the escrow system! Here's how.

---

## What is Group Buy?

**Tiered pricing based on quantity:**
- 4 orders → 400 BDT per person
- 10 orders → 350 BDT per person
- 20 orders → 300 BDT per person

**Time-limited campaign:**
- Runs for X days
- Payment held in escrow until target reached
- Refund if target not met

---

## Architecture

### What the Library Handles

✅ **Escrow (Hold/Release)**
- Hold customer payments during campaign
- Release to merchant when target reached
- Refund customers if campaign fails

✅ **Multi-Party Splits**
- Platform commission
- Affiliate referral fees
- Partner splits

✅ **Payment Processing**
- Gateway integration
- Verification
- Refunds

✅ **Transaction Management**
- Income/expense tracking
- Audit trail

### What You Implement (Domain Logic)

🔨 **Campaign Model**
- Start/end dates
- Pricing tiers
- Current pledge count
- Target thresholds

🔨 **Pledge Tracking**
- Link customers to campaigns
- Track pledge amounts
- Calculate final pricing

🔨 **Campaign Status**
- Active/completed/failed states
- Threshold checking
- Auto-finalize logic

---

## Implementation

### 1. Campaign Model (Your Domain)

```javascript
const campaignSchema = new mongoose.Schema({
  productId: { type: ObjectId, ref: 'Product', required: true },

  // Tiered pricing
  pricingTiers: [
    {
      minOrders: { type: Number, required: true },   // 4, 10, 20
      pricePerUnit: { type: Number, required: true }, // 400, 350, 300
    }
  ],

  // Campaign period
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },

  // Status
  status: {
    type: String,
    enum: ['draft', 'active', 'successful', 'failed', 'cancelled'],
    default: 'draft',
  },

  // Current state
  currentPledges: { type: Number, default: 0 },
  targetPledges: { type: Number, required: true }, // Minimum to succeed

  // Merchant
  merchantId: { type: ObjectId, ref: 'Organization', required: true },

  metadata: Object,
}, { timestamps: true });
```

### 2. Pledge Model (Your Domain)

```javascript
const pledgeSchema = new mongoose.Schema({
  campaignId: { type: ObjectId, ref: 'Campaign', required: true },
  customerId: { type: ObjectId, ref: 'Customer', required: true },

  // Payment held in escrow
  transactionId: { type: ObjectId, ref: 'Transaction', required: true },

  // Price at time of pledge (may change based on final tier)
  pledgedAmount: { type: Number, required: true },
  finalAmount: { type: Number }, // Set when campaign succeeds

  status: {
    type: String,
    enum: ['pending', 'held', 'confirmed', 'refunded'],
    default: 'pending',
  },

  pledgedAt: { type: Date, default: Date.now },

  metadata: Object,
}, { timestamps: true });
```

### 3. Customer Makes Pledge

```javascript
import { createRevenue } from '@classytic/revenue';

async function createPledge(campaignId, customerId) {
  const campaign = await Campaign.findById(campaignId);

  if (campaign.status !== 'active') {
    throw new Error('Campaign is not active');
  }

  if (new Date() > campaign.endDate) {
    throw new Error('Campaign has ended');
  }

  // Get current price tier
  const currentPrice = calculateCurrentPrice(campaign);

  // Create transaction via revenue library
  const revenue = getRevenue();
  const { transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: campaign.merchantId,
      customerId,
      referenceId: campaignId,
      referenceModel: 'Campaign',
    },
    entity: 'GroupBuy',
    monetizationType: 'purchase',
    amount: currentPrice,
    currency: 'BDT',
    gateway: 'stripe',
    paymentData: { ... },
  });

  // Verify payment
  await revenue.payments.verify(transaction._id);

  // HOLD in escrow (don't release yet!)
  await revenue.escrow.hold(transaction._id, {
    reason: 'payment_verification',
    holdUntil: campaign.endDate,
    metadata: {
      campaignId,
      pledgeType: 'group_buy',
    },
  });

  // Create pledge record
  const pledge = await Pledge.create({
    campaignId,
    customerId,
    transactionId: transaction._id,
    pledgedAmount: currentPrice,
    status: 'held',
  });

  // Update campaign pledge count
  campaign.currentPledges += 1;
  await campaign.save();

  return { pledge, transaction };
}

function calculateCurrentPrice(campaign) {
  const tiers = campaign.pricingTiers.sort((a, b) => b.minOrders - a.minOrders);

  for (const tier of tiers) {
    if (campaign.currentPledges >= tier.minOrders) {
      return tier.pricePerUnit;
    }
  }

  // Default to highest tier
  return tiers[tiers.length - 1].pricePerUnit;
}
```

### 4. Campaign Ends - Finalize

```javascript
async function finalizeCampaign(campaignId) {
  const campaign = await Campaign.findById(campaignId);
  const pledges = await Pledge.find({ campaignId, status: 'held' });
  const revenue = getRevenue();

  // Check if target reached
  const isSuccessful = campaign.currentPledges >= campaign.targetPledges;

  if (isSuccessful) {
    // SUCCESS: Release payments to merchant

    // Calculate final price tier
    const finalPrice = calculateCurrentPrice(campaign);

    for (const pledge of pledges) {
      const transaction = await Transaction.findById(pledge.transactionId);

      // Calculate price difference (if tier improved)
      const priceDiff = pledge.pledgedAmount - finalPrice;

      if (priceDiff > 0) {
        // Partial refund (tier improved!)
        await revenue.payments.refund(
          transaction._id,
          priceDiff,
          { reason: 'Better tier pricing achieved' }
        );
      }

      // Release to merchant (with commission splits)
      const releaseAmount = transaction.amount - priceDiff;

      await revenue.escrow.split(transaction._id, [
        { type: 'platform_commission', recipientId: 'platform', rate: 0.05 },
        // Auto-releases remainder to merchant
      ]);

      // Update pledge
      pledge.finalAmount = finalPrice;
      pledge.status = 'confirmed';
      await pledge.save();
    }

    campaign.status = 'successful';
    await campaign.save();

    // Send success emails to all customers

  } else {
    // FAILED: Refund all customers

    for (const pledge of pledges) {
      // Cancel hold and refund
      await revenue.escrow.cancel(pledge.transactionId, {
        reason: 'Campaign did not reach target',
      });

      // Refund payment
      await revenue.payments.refund(
        pledge.transactionId,
        null, // Full refund
        { reason: 'Group buy campaign failed' }
      );

      pledge.status = 'refunded';
      await pledge.save();
    }

    campaign.status = 'failed';
    await campaign.save();

    // Send refund emails to all customers
  }
}
```

### 5. Scheduled Job (Auto-Finalize)

```javascript
// Run daily to check expired campaigns
async function checkExpiredCampaigns() {
  const now = new Date();

  const expiredCampaigns = await Campaign.find({
    status: 'active',
    endDate: { $lte: now },
  });

  for (const campaign of expiredCampaigns) {
    await finalizeCampaign(campaign._id);
  }
}

// Cron job: Every hour
cron.schedule('0 * * * *', checkExpiredCampaigns);
```

---

## Complete Flow Diagram

```
Customer 1 pledges 400 BDT
    ↓
revenue.payments.verify() → VERIFIED
    ↓
revenue.escrow.hold() → HELD IN ESCROW
    ↓
campaign.currentPledges++ (1 → 2 → 3 → 4)

... more customers pledge ...

Campaign reaches 10 pledges!
    ↓
Final tier: 350 BDT per person
    ↓
For each pledge:
  ├── Pledged 400, Final 350 → Refund 50 BDT
  ├── revenue.escrow.split() → Platform 5%, Merchant 95%
  └── pledge.status = 'confirmed'

Campaign status = 'successful' ✅
```

**If campaign fails (<4 pledges):**
```
Campaign expires
    ↓
currentPledges (3) < targetPledges (4)
    ↓
For each pledge:
  ├── revenue.escrow.cancel()
  ├── revenue.payments.refund() → Full refund
  └── pledge.status = 'refunded'

Campaign status = 'failed' ❌
```

---

## Advanced Features

### Dynamic Tier Updates

Show customers live pricing as more people join:

```javascript
async function getCurrentCampaignPrice(campaignId) {
  const campaign = await Campaign.findById(campaignId);
  const currentPrice = calculateCurrentPrice(campaign);

  // Find next tier
  const nextTier = campaign.pricingTiers.find(
    tier => tier.minOrders > campaign.currentPledges
  );

  return {
    currentPrice,
    currentPledges: campaign.currentPledges,
    nextTier: nextTier ? {
      price: nextTier.pricePerUnit,
      pledgesNeeded: nextTier.minOrders - campaign.currentPledges,
    } : null,
  };
}
```

### Affiliate Referrals

Reward users who bring in pledges:

```javascript
async function createPledge(campaignId, customerId, referrerId = null) {
  // ... create transaction ...

  // Hold with affiliate info
  await revenue.escrow.hold(transaction._id, {
    metadata: {
      campaignId,
      referrerId,  // Track who referred
    },
  });

  // When finalizing, split includes affiliate
  if (referrerId) {
    await revenue.escrow.split(transaction._id, [
      { type: 'platform_commission', recipientId: 'platform', rate: 0.05 },
      { type: 'affiliate_commission', recipientId: referrerId, rate: 0.02 },
    ]);
  }
}
```

### Early Bird Pricing

First N customers get better price:

```javascript
const campaignSchema = new mongoose.Schema({
  // ... existing fields ...

  earlyBirdTier: {
    maxPledges: { type: Number, default: 5 },  // First 5 customers
    pricePerUnit: { type: Number },            // 300 BDT
  },
});

function calculateCurrentPrice(campaign) {
  // Early bird check
  if (campaign.currentPledges < campaign.earlyBirdTier.maxPledges) {
    return campaign.earlyBirdTier.pricePerUnit;
  }

  // Regular tier logic
  // ...
}
```

---

## What You DON'T Need to Build

❌ Payment gateway integration → Library handles
❌ Escrow/hold logic → Library handles
❌ Refund processing → Library handles
❌ Commission calculation → Library handles
❌ Transaction accounting → Library handles

## What You DO Need to Build

✅ Campaign model & business rules
✅ Pledge tracking
✅ Tier calculation logic
✅ Campaign finalization workflow
✅ Scheduled jobs for auto-finalize
✅ UI for campaign creation & pledge tracking

---

## Example API Routes

```javascript
// Create campaign
POST /campaigns
{
  "productId": "...",
  "pricingTiers": [
    { "minOrders": 4, "pricePerUnit": 400 },
    { "minOrders": 10, "pricePerUnit": 350 },
    { "minOrders": 20, "pricePerUnit": 300 }
  ],
  "startDate": "2025-11-20",
  "endDate": "2025-11-30",
  "targetPledges": 4
}

// Make pledge
POST /campaigns/:id/pledge
{
  "customerId": "...",
  "paymentMethod": "stripe"
}

// Get campaign status
GET /campaigns/:id/status
{
  "currentPrice": 350,
  "currentPledges": 8,
  "nextTier": {
    "price": 300,
    "pledgesNeeded": 12
  },
  "daysRemaining": 5
}
```

---

## Production Considerations

1. **Idempotency**: Use `idempotencyKey` to prevent duplicate pledges
2. **Race Conditions**: Lock campaign during pledge creation
3. **Webhook Handling**: Listen to payment webhooks for automated verification
4. **Email Notifications**: Notify customers of tier changes, success/failure
5. **Admin Dashboard**: Monitor active campaigns, manual finalization
6. **Analytics**: Track conversion rates, popular tiers, referral performance

---

## Summary

**YES, group buy is fully supported!**

The escrow system provides all the payment infrastructure. You just need to implement:
- Campaign management (domain logic)
- Pledge tracking
- Tier calculation
- Finalization workflow

The library handles:
- Holding payments safely
- Releasing to merchant on success
- Refunding on failure
- Commission splits
- Transaction accounting

This same pattern works for:
- Crowdfunding campaigns
- Pre-orders with funding goals
- Collective purchasing
- Flash sales with volume discounts
- Community-funded products

All built on the escrow foundation! 🚀
