/**
 * Stripe Platform Manual - Complete Example
 * Shows: Payment collection + Commission tracking + Manual vendor payout
 */

import { createRevenue } from '@classytic/revenue';
import { StripePlatformManualProvider } from './provider.js';
import Transaction from './models/Transaction.js';
import Vendor from './models/Vendor.js';

const revenue = createRevenue({
  models: { Transaction },
  providers: {
    stripe: new StripePlatformManualProvider({
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      successUrl: `${process.env.APP_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${process.env.APP_URL}/payment/cancel`,
    }),
  },
  
  config: {
    commissionRates: {
      'product_order': 0.10,  // Platform keeps 10%
      'service_order': 0.15,  // Platform keeps 15%
    },
    
    gatewayFeeRates: {
      'stripe': 0.029,  // 2.9% Stripe fee (platform pays this)
    },
  },
});

// ============================================================
// STEP 1: Customer pays via Stripe
// ============================================================

async function createVendorSalePayment(vendorId, customerId, amount) {
  const { transaction, paymentIntent } = await revenue.subscriptions.create({
    data: {
      organizationId: vendorId,
      customerId,
    },
    planKey: 'one-time',
    amount: 10000, // $100.00
    gateway: 'stripe',
    entity: 'ProductOrder',
    monetizationType: 'purchase',
    paymentData: { method: 'card' },
    metadata: {
      vendorId, // ⭐ Track for payout
    },
  });

  // Platform receives: $100.00 to Stripe account
  // Commission tracked:
  // - Gross: $10.00 (10%)
  // - Stripe fee: $2.90
  // - Net platform commission: $7.10
  // 
  // Vendor should receive: $100 - $10 = $90.00

  return { transaction, paymentIntent };
}

// ============================================================
// STEP 2: Calculate vendor payouts
// ============================================================

async function calculateVendorPayouts() {
  const payoutSummary = await Transaction.aggregate([
    {
      $match: {
        type: 'income',
        status: 'verified',
        'commission.status': 'pending', // Not yet paid to vendor
      }
    },
    {
      $group: {
        _id: '$metadata.vendorId',
        transactions: { $push: '$_id' },
        totalGrossSales: { $sum: '$amount' },
        totalCommission: { $sum: '$commission.grossAmount' },
        totalStripeFees: { $sum: '$commission.gatewayFeeAmount' },
        count: { $sum: 1 },
      }
    },
    {
      $project: {
        vendorId: '$_id',
        transactions: 1,
        totalGrossSales: 1,
        totalCommission: 1,
        totalStripeFees: 1,
        vendorPayout: { $subtract: ['$totalGrossSales', '$totalCommission'] },
        count: 1,
      }
    }
  ]);

  return payoutSummary;
}

// ============================================================
// STEP 3: Pay vendor manually (bKash, bank, etc.)
// ============================================================

async function payVendor(vendorId, payoutAmount, transactionIds) {
  const vendor = await Vendor.findById(vendorId);
  
  // Record manual payout as EXPENSE transaction
  const payoutTxn = await Transaction.create({
    organizationId: vendorId,
    customerId: null,
    amount: payoutAmount,
    type: 'expense',  // ⭐ Money going out
    method: vendor.preferredPayoutMethod || 'bank_transfer',
    status: 'completed',
    category: 'vendor_payout',
    currency: 'USD',
    paymentDetails: {
      provider: vendor.preferredPayoutMethod,
      walletNumber: vendor.bkashNumber,
      accountNumber: vendor.bankAccount,
      reference: `PAYOUT_${Date.now()}`,
    },
    metadata: {
      vendorId,
      payoutMethod: vendor.preferredPayoutMethod,
      coveredTransactions: transactionIds,
      payoutDate: new Date(),
    },
    idempotencyKey: `payout_${vendorId}_${Date.now()}`,
  });

  // Mark commissions as paid
  await Transaction.updateMany(
    { _id: { $in: transactionIds } },
    { $set: { 'commission.status': 'paid', 'commission.paidDate': new Date() } }
  );

  return payoutTxn;
}

// ============================================================
// STEP 4: Generate payout report
// ============================================================

async function generatePayoutReport(vendorId) {
  const vendor = await Vendor.findById(vendorId);
  
  // Get all income transactions
  const sales = await Transaction.find({
    organizationId: vendorId,
    type: 'income',
    status: 'verified',
  });

  // Get all payout transactions
  const payouts = await Transaction.find({
    organizationId: vendorId,
    type: 'expense',
    category: 'vendor_payout',
  });

  const totalSales = sales.reduce((sum, t) => sum + t.amount, 0);
  const totalCommission = sales.reduce((sum, t) => sum + (t.commission?.grossAmount || 0), 0);
  const totalPaidOut = payouts.reduce((sum, t) => sum + t.amount, 0);
  const pendingPayout = totalSales - totalCommission - totalPaidOut;

  return {
    vendor: {
      id: vendor._id,
      name: vendor.name,
      email: vendor.email,
    },
    summary: {
      totalSales: (totalSales / 100).toFixed(2),
      platformCommission: (totalCommission / 100).toFixed(2),
      totalPaidOut: (totalPaidOut / 100).toFixed(2),
      pendingPayout: (pendingPayout / 100).toFixed(2),
    },
    transactions: {
      salesCount: sales.length,
      payoutsCount: payouts.length,
    },
  };
}

// ============================================================
// USAGE EXAMPLE
// ============================================================

async function example() {
  // 1. Customer purchases from vendor
  const { transaction } = await createVendorSalePayment(
    'vendor_123',
    'customer_456',
    10000
  );

  console.log('Sale recorded:', {
    amount: '$100.00',
    commission: '$10.00',
    vendorEarns: '$90.00',
  });

  // 2. Calculate payouts (weekly/monthly)
  const payouts = await calculateVendorPayouts();
  
  console.log('Vendor payouts due:');
  payouts.forEach(p => {
    console.log(`  Vendor ${p.vendorId}: $${(p.vendorPayout / 100).toFixed(2)}`);
  });

  // 3. Pay vendor manually
  await payVendor('vendor_123', 9000, transaction._id);
  
  console.log('Payout completed to vendor');

  // 4. Generate report
  const report = await generatePayoutReport('vendor_123');
  console.log('Vendor report:', report);
}

export { createVendorSalePayment, calculateVendorPayouts, payVendor, generatePayoutReport };
export default example;

