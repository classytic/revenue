/**
 * Affiliate Commission Example
 * @classytic/revenue
 *
 * Multi-party commission splits for affiliate/referral systems
 * Use cases: E-commerce marketplaces, Course platforms, SaaS resellers
 */

import { createRevenue, calculateCommissionWithSplits, calculateSplits } from '../index.js';
import { ManualProvider } from '@classytic/revenue-manual';
import Transaction from './transaction.model.js';

const revenue = createRevenue({
  models: { Transaction },
  providers: { manual: new ManualProvider() },
  config: {
    categoryMappings: {
      CourseEnrollment: 'course_enrollment',
      ProductOrder: 'product_order',
    },
  },
});

async function simpleAffiliateFlow() {
  console.log('\n=== SIMPLE AFFILIATE COMMISSION ===\n');

  const amount = 5000;
  const platformRate = 0.10;
  const affiliateRate = 0.05;

  const commission = calculateCommissionWithSplits(
    amount,
    platformRate,
    0,
    {
      affiliateRate,
      affiliateId: 'affiliate-123',
      affiliateType: 'user',
    }
  );

  console.log('Transaction: 5000 BDT');
  console.log('Platform commission (10%):', commission.grossAmount, 'BDT');
  console.log('Affiliate commission (5%):', commission.affiliate.grossAmount, 'BDT');
  console.log('Total commission:', commission.grossAmount + commission.affiliate.grossAmount, 'BDT');
  console.log('Organization receives:', amount - commission.grossAmount - commission.affiliate.grossAmount, 'BDT');
  console.log('\nSplits:', commission.splits.length);
  commission.splits.forEach(split => {
    console.log(`  - ${split.type}: ${split.netAmount} BDT`);
  });
}

async function multiTierAffiliateFlow() {
  console.log('\n\n=== MULTI-TIER AFFILIATE COMMISSION ===\n');

  const amount = 10000;

  const splitRules = [
    {
      type: 'platform_commission',
      recipientId: 'platform',
      recipientType: 'platform',
      rate: 0.10,
    },
    {
      type: 'affiliate_commission',
      recipientId: 'affiliate-level-1',
      recipientType: 'user',
      rate: 0.05,
    },
    {
      type: 'affiliate_commission',
      recipientId: 'affiliate-level-2',
      recipientType: 'user',
      rate: 0.02,
    },
    {
      type: 'partner_commission',
      recipientId: 'partner-org',
      recipientType: 'organization',
      rate: 0.03,
    },
  ];

  const splits = calculateSplits(amount, splitRules, 0.029);

  console.log('Transaction: 10000 BDT');
  console.log('Gateway fee (2.9%):', splits[0].gatewayFeeAmount, 'BDT');
  console.log('\nCommission breakdown:');

  let totalCommission = 0;
  splits.forEach(split => {
    console.log(`\n${split.type}:`);
    console.log(`  Recipient: ${split.recipientId}`);
    console.log(`  Rate: ${split.rate * 100}%`);
    console.log(`  Gross: ${split.grossAmount} BDT`);
    console.log(`  Gateway fee: ${split.gatewayFeeAmount} BDT`);
    console.log(`  Net: ${split.netAmount} BDT`);
    totalCommission += split.grossAmount;
  });

  console.log(`\nTotal commission: ${totalCommission} BDT (${(totalCommission / amount) * 100}%)`);
  console.log(`Organization receives: ${amount - totalCommission} BDT (${((amount - totalCommission) / amount) * 100}%)`);
}

async function courseEnrollmentWithReferral() {
  console.log('\n\n=== COURSE ENROLLMENT WITH REFERRAL ===\n');

  const enrollmentAmount = 15000;
  const organizationId = 'instructor-001';
  const customerId = 'student-123';
  const affiliateId = 'influencer-456';

  console.log('Course: Advanced Web Development');
  console.log('Price: 15000 BDT');
  console.log('Referred by: Social Media Influencer');
  console.log('');

  const transaction = await Transaction.create({
    organizationId,
    customerId,
    amount: enrollmentAmount,
    currency: 'BDT',
    category: 'course_enrollment',
    type: 'income',
    method: 'stripe',
    status: 'verified',
    gateway: {
      type: 'stripe',
    },
    metadata: {
      courseId: 'course-web-dev-advanced',
      referralCode: 'INFLUENCER20',
      affiliateId,
    },
  });

  await revenue.escrow.hold(transaction._id.toString());

  const splitRules = [
    {
      type: 'platform_commission',
      recipientId: 'platform',
      recipientType: 'platform',
      rate: 0.10,
    },
    {
      type: 'referral_commission',
      recipientId: affiliateId,
      recipientType: 'user',
      rate: 0.10,
    },
  ];

  const result = await revenue.escrow.split(transaction._id.toString(), splitRules);

  console.log('Payment processed:');
  console.log(`  Platform fee: ${result.splits[0].netAmount} BDT`);
  console.log(`  Referral commission: ${result.splits[1].netAmount} BDT`);
  console.log(`  Instructor receives: ${result.organizationPayout} BDT`);
  console.log('\nAll parties paid automatically ✅');
}

async function marketplaceFlow() {
  console.log('\n\n=== E-COMMERCE MARKETPLACE FLOW ===\n');

  const orderAmount = 8000;
  const sellerId = 'seller-789';
  const customerId = 'buyer-456';
  const referrerId = 'affiliate-123';

  console.log('Product: Wireless Headphones');
  console.log('Price: 8000 BDT');
  console.log('Seller: Electronics Store');
  console.log('Referred by: Tech Blogger\n');

  const transaction = await Transaction.create({
    organizationId: sellerId,
    customerId,
    amount: orderAmount,
    currency: 'BDT',
    category: 'product_order',
    type: 'income',
    method: 'sslcommerz',
    status: 'verified',
    gateway: {
      type: 'sslcommerz',
    },
    metadata: {
      productId: 'headphones-wireless-001',
      referrerId,
      marketplace: true,
    },
  });

  await revenue.escrow.hold(transaction._id.toString());

  const splitRules = [
    {
      type: 'platform_commission',
      recipientId: 'platform',
      recipientType: 'platform',
      rate: 0.15,
    },
    {
      type: 'affiliate_commission',
      recipientId: referrerId,
      recipientType: 'user',
      rate: 0.05,
    },
  ];

  const result = await revenue.escrow.split(transaction._id.toString(), splitRules);

  console.log('Marketplace fee (15%):', result.splits[0].netAmount, 'BDT');
  console.log('Affiliate commission (5%):', result.splits[1].netAmount, 'BDT');
  console.log('Seller receives:', result.organizationPayout, 'BDT');
  console.log('\nPlatform holds payment until delivery confirmed');
  console.log('Automatic payout on delivery ✅');
}

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  @classytic/revenue - Affiliate Commission Examples       ║');
console.log('║  Multi-Party Revenue Sharing                              ║');
console.log('╚════════════════════════════════════════════════════════════╝');

try {
  await simpleAffiliateFlow();
  await multiTierAffiliateFlow();
  await courseEnrollmentWithReferral();
  await marketplaceFlow();

  console.log('\n\n✅ All affiliate commission examples completed\n');
} catch (error) {
  console.error('\n❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
