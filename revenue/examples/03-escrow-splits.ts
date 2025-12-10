/**
 * Escrow & Multi-Party Splits Example
 * @classytic/revenue
 *
 * Platform-as-intermediary payment flow for marketplaces
 */

import mongoose from 'mongoose';
import { Revenue, calculateCommissionWithSplits, calculateSplits } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

// ============ MODEL WITH ESCROW FIELDS ============

const TransactionSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  type: { type: String, default: 'income' },
  status: { type: String, default: 'pending' },
  method: String,
  category: String,
  organizationId: mongoose.Schema.Types.ObjectId,
  customerId: mongoose.Schema.Types.ObjectId,
  gateway: mongoose.Schema.Types.Mixed,
  verifiedAt: Date,
  
  // Escrow fields
  hold: {
    status: { type: String, enum: ['none', 'held', 'partial_release', 'released', 'cancelled'], default: 'none' },
    heldAmount: Number,
    releasedAmount: { type: Number, default: 0 },
    reason: String,
    holdUntil: Date,
    heldAt: Date,
    releasedAt: Date,
    releases: [{
      amount: Number,
      recipientId: String,
      recipientType: String,
      releasedAt: Date,
      notes: String,
    }],
  },
  
  // Multi-party splits
  splits: [{
    type: String,
    recipientId: String,
    recipientType: String,
    rate: Number,
    grossAmount: Number,
    netAmount: Number,
    status: { type: String, default: 'pending' },
  }],
  
  // Commission
  commission: {
    rate: Number,
    grossAmount: Number,
    gatewayFeeRate: Number,
    gatewayFeeAmount: Number,
    netAmount: Number,
    status: String,
  },
  
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', TransactionSchema);

// ============ BUILD REVENUE ============

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction: Transaction as any })
  .withProvider('manual', new ManualProvider())
  .withCommission(10, 2.9) // 10% platform, 2.9% gateway
  .build();

// ============ ESCROW FLOW ============

async function main() {
  await mongoose.connect('mongodb://localhost:27017/revenue_example');

  try {
    // ============ SCENARIO: Marketplace Order ============
    console.log('\n🛒 MARKETPLACE ESCROW FLOW\n');

    // 1. Customer makes purchase
    console.log('1️⃣ Customer makes purchase...');
    const { transaction } = await revenue.monetization.create({
      data: {
        customerId: new mongoose.Types.ObjectId(),
        organizationId: new mongoose.Types.ObjectId(), // Vendor
      },
      planKey: 'order',
      monetizationType: 'purchase',
      amount: 10000, // $100.00
      gateway: 'manual',
    });
    console.log('Transaction:', transaction?._id);
    console.log('Amount:', transaction?.amount);

    // 2. Verify payment
    console.log('\n2️⃣ Verifying payment...');
    await revenue.payments.verify(transaction!._id.toString());

    // 3. Hold in escrow (awaiting delivery)
    console.log('\n3️⃣ Holding in escrow...');
    const held = await revenue.escrow.hold(transaction!._id.toString(), {
      reason: 'Awaiting delivery confirmation',
      holdUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });
    console.log('Hold status:', held.transaction.hold?.status);
    console.log('Held amount:', held.transaction.hold?.heldAmount);

    // 4. Multi-party split
    console.log('\n4️⃣ Calculating splits...');
    const splits = await revenue.escrow.split(transaction!._id.toString(), [
      { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.10 },
      { type: 'affiliate_commission', recipientId: 'aff_123', recipientType: 'user', rate: 0.05 },
    ]);
    console.log('Splits calculated:', splits.splits.length);
    splits.splits.forEach(s => {
      console.log(`  - ${s.type}: ${s.recipientId} → $${(s.netAmount / 100).toFixed(2)}`);
    });

    // 5. Release to vendor (after delivery confirmed)
    console.log('\n5️⃣ Releasing to vendor...');
    const released = await revenue.escrow.release(transaction!._id.toString(), {
      recipientId: 'vendor_456',
      recipientType: 'organization',
      notes: 'Delivery confirmed by customer',
    });
    console.log('Released amount:', released.releasedAmount);
    console.log('Hold status:', released.transaction.hold?.status);

    // ============ UTILITY: Calculate Commission with Splits ============
    console.log('\n\n💰 COMMISSION CALCULATION UTILITY\n');

    const commission = calculateCommissionWithSplits(
      10000,  // $100 in cents
      0.10,   // 10% platform commission
      0.029,  // 2.9% gateway fee
      {
        affiliateRate: 0.05,
        affiliateId: 'affiliate_user_123',
      }
    );

    console.log('Gross commission:', commission.grossAmount);
    console.log('Gateway fee:', commission.gatewayFeeAmount);
    console.log('Net platform:', commission.netAmount);
    console.log('Affiliate gross:', commission.affiliate?.grossAmount);
    console.log('Affiliate net:', commission.affiliate?.netAmount);
    console.log('Vendor receives:', 10000 - commission.grossAmount - (commission.affiliate?.grossAmount ?? 0));

    // ============ UTILITY: Multi-Party Splits ============
    console.log('\n\n🔀 MULTI-PARTY SPLITS UTILITY\n');

    const multiSplits = calculateSplits(
      10000, // $100
      [
        { type: 'platform_commission', recipientId: 'platform', recipientType: 'platform', rate: 0.10 },
        { type: 'affiliate_commission', recipientId: 'level1_aff', recipientType: 'user', rate: 0.05 },
        { type: 'affiliate_commission', recipientId: 'level2_aff', recipientType: 'user', rate: 0.02 },
        { type: 'partner_commission', recipientId: 'partner_org', recipientType: 'organization', rate: 0.03 },
      ],
      0.029 // Gateway fee
    );

    console.log('Multi-party splits:');
    multiSplits.forEach(s => {
      console.log(`  - ${s.type} (${s.recipientId}): $${(s.netAmount / 100).toFixed(2)}`);
    });
    
    const totalSplits = multiSplits.reduce((sum, s) => sum + s.grossAmount, 0);
    console.log(`Organization receives: $${((10000 - totalSplits) / 100).toFixed(2)}`);

  } finally {
    await mongoose.disconnect();
  }
}

main().catch(console.error);

