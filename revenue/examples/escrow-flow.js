/**
 * Escrow Flow Example
 * @classytic/revenue
 *
 * Platform-as-intermediary payment flow with affiliate commissions
 * Demonstrates: Hold → Verify → Split → Release
 */

import { createRevenue } from '../index.js';
import { ManualProvider } from '@classytic/revenue-manual';
import Transaction from './transaction.model.js';

const revenue = createRevenue({
  models: { Transaction },
  providers: { manual: new ManualProvider() },
  config: {
    categoryMappings: {
      ProductOrder: 'product_order',
    },
    commissionRates: {
      product_order: 0.10,
    },
    gatewayFeeRates: {
      manual: 0,
      stripe: 0.029,
    },
  },
  hooks: {
    'escrow.held': [
      async ({ transaction, heldAmount }) => {
        console.log(`Funds held: ${heldAmount} ${transaction.currency}`);
      },
    ],
    'escrow.split': [
      async ({ splits, organizationPayout }) => {
        console.log(`Splits: ${splits.length}, Organization: ${organizationPayout}`);
      },
    ],
    'escrow.released': [
      async ({ releaseAmount, recipientId }) => {
        console.log(`Released ${releaseAmount} to ${recipientId}`);
      },
    ],
  },
});

async function completeEscrowFlow() {
  console.log('\n=== ESCROW FLOW WITH AFFILIATE COMMISSION ===\n');

  const organizationId = 'org-123';
  const customerId = 'customer-456';
  const affiliateId = 'affiliate-789';
  const amount = 1000;

  console.log('Step 1: Customer makes purchase (1000 BDT)');
  console.log('         Gateway receives payment');
  console.log('         Platform receives money (not organization yet)\n');

  const transaction = await Transaction.create({
    organizationId,
    customerId,
    amount,
    currency: 'BDT',
    category: 'product_order',
    type: 'income',
    method: 'stripe',
    status: 'pending',
    gateway: {
      type: 'stripe',
      paymentIntentId: 'pi_test_123',
    },
    metadata: {
      productId: 'product-001',
      affiliateId,
    },
  });

  console.log(`Transaction created: ${transaction._id}`);
  console.log(`Status: ${transaction.status}\n`);

  console.log('Step 2: Verify payment');
  const verified = await revenue.payments.verify(transaction._id.toString());
  console.log(`Payment verified: ${verified.transaction.status}`);
  console.log(`Amount: ${verified.transaction.amount} BDT\n`);

  console.log('Step 3: Hold funds in escrow');
  const held = await revenue.escrow.hold(transaction._id.toString(), {
    reason: 'payment_verification',
    metadata: { holdDuration: '7 days' },
  });
  console.log(`Funds held: ${held.hold.heldAmount} BDT`);
  console.log(`Hold status: ${held.hold.status}\n`);

  console.log('Step 4: Calculate and apply splits');
  console.log('         - Platform commission: 10% (100 BDT)');
  console.log('         - Affiliate commission: 2% (20 BDT)');
  console.log('         - Organization receives: 88% (880 BDT)\n');

  const splitRules = [
    {
      type: 'platform_commission',
      recipientId: 'platform',
      recipientType: 'platform',
      rate: 0.10,
    },
    {
      type: 'affiliate_commission',
      recipientId: affiliateId,
      recipientType: 'user',
      rate: 0.02,
    },
  ];

  const splitResult = await revenue.escrow.split(transaction._id.toString(), splitRules);

  console.log('Splits applied:');
  splitResult.splits.forEach(split => {
    console.log(`  - ${split.type}: ${split.netAmount} BDT to ${split.recipientId}`);
  });
  console.log(`\nOrganization payout: ${splitResult.organizationPayout} BDT`);
  console.log(`Hold status: ${splitResult.transaction.hold.status}\n`);

  console.log('=== FINAL BREAKDOWN ===');
  console.log(`Total amount: 1000 BDT`);
  console.log(`Platform commission: 100 BDT (10%)`);
  console.log(`Affiliate commission: 20 BDT (2%)`);
  console.log(`Organization receives: 880 BDT (88%)`);
  console.log(`\nAll transactions created: ${splitResult.splitTransactions.length + 1}`);
}

async function partialReleaseExample() {
  console.log('\n\n=== PARTIAL RELEASE EXAMPLE ===\n');

  const transaction = await Transaction.create({
    organizationId: 'org-123',
    customerId: 'customer-456',
    amount: 1000,
    currency: 'BDT',
    category: 'product_order',
    type: 'income',
    method: 'manual',
    status: 'verified',
  });

  await revenue.escrow.hold(transaction._id.toString());

  console.log('Held amount: 1000 BDT');
  console.log('\nRelease 1: 300 BDT to supplier');
  const release1 = await revenue.escrow.release(transaction._id.toString(), {
    amount: 300,
    recipientId: 'supplier-001',
    recipientType: 'supplier',
    reason: 'partial_payment',
  });

  console.log(`Released: ${release1.releaseAmount} BDT`);
  console.log(`Remaining: ${release1.transaction.hold.heldAmount - release1.transaction.hold.releasedAmount} BDT`);
  console.log(`Status: ${release1.transaction.hold.status}\n`);

  console.log('Release 2: 700 BDT to organization');
  const release2 = await revenue.escrow.release(transaction._id.toString(), {
    amount: 700,
    recipientId: 'org-123',
    recipientType: 'organization',
    reason: 'payment_verified',
  });

  console.log(`Released: ${release2.releaseAmount} BDT`);
  console.log(`Total released: ${release2.transaction.hold.releasedAmount} BDT`);
  console.log(`Status: ${release2.transaction.hold.status}`);
  console.log(`Is fully released: ${release2.isFullRelease}`);
}

async function cancelHoldExample() {
  console.log('\n\n=== CANCEL HOLD EXAMPLE ===\n');

  const transaction = await Transaction.create({
    organizationId: 'org-123',
    customerId: 'customer-456',
    amount: 1000,
    currency: 'BDT',
    category: 'product_order',
    type: 'income',
    method: 'manual',
    status: 'verified',
  });

  await revenue.escrow.hold(transaction._id.toString(), {
    reason: 'fraud_check',
  });

  console.log('Funds held for fraud check');
  console.log('Fraud detected - cancelling hold\n');

  const cancelled = await revenue.escrow.cancel(transaction._id.toString(), {
    reason: 'Fraudulent transaction detected',
  });

  console.log(`Hold status: ${cancelled.hold.status}`);
  console.log(`Transaction status: ${cancelled.status}`);
  console.log(`Cancelled at: ${cancelled.hold.cancelledAt}`);
}

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║  @classytic/revenue - Escrow Flow Examples                ║');
console.log('║  Platform-as-Intermediary Payment Processing              ║');
console.log('╚════════════════════════════════════════════════════════════╝');

try {
  await completeEscrowFlow();
  await partialReleaseExample();
  await cancelHoldExample();

  console.log('\n\n✅ All examples completed successfully\n');
} catch (error) {
  console.error('\n❌ Error:', error.message);
  console.error(error.stack);
  process.exit(1);
}
