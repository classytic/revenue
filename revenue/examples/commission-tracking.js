/**
 * Commission Tracking Example
 * @classytic/revenue
 *
 * Shows automatic platform commission calculation for marketplaces and multi-vendor platforms
 */

import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import mongoose from 'mongoose';
import {
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS_VALUES,
} from '@classytic/revenue/enums';
import {
  gatewaySchema,
  paymentDetailsSchema,
  commissionSchema,
} from '@classytic/revenue/schemas';

// Transaction model with commission tracking
const transactionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  customerId: mongoose.Schema.Types.ObjectId,
  amount: { type: Number, required: true },
  type: { type: String, enum: TRANSACTION_TYPE_VALUES, required: true },
  method: { type: String, required: true },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, required: true },
  category: String,
  currency: String,
  gateway: gatewaySchema,
  paymentDetails: paymentDetailsSchema,
  
  // ⭐ Commission tracking (automatically calculated by library)
  commission: commissionSchema,
  
  metadata: mongoose.Schema.Types.Mixed,
  idempotencyKey: String,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

// Configure revenue with commission rates
const revenue = createRevenue({
  models: { Transaction },
  providers: { manual: new ManualProvider() },
  
  config: {
    // Map entities to categories
    categoryMappings: {
      CourseEnrollment: 'course_enrollment',
      ProductOrder: 'product_order',
      GymMembership: 'gym_membership',
      PlatformSubscription: 'platform_subscription',
    },
    
    // ⭐ Commission rates by category (0 to 1)
    commissionRates: {
      'course_enrollment': 0.10,       // 10% on course sales
      'product_order': 0.05,            // 5% on products
      'gym_membership': 0,              // No commission
      'platform_subscription': 0.10,    // 10% on subscriptions
    },
    
    // ⭐ Gateway fees (deducted from commission)
    gatewayFeeRates: {
      'bkash': 0.018,       // 1.8% bKash fee
      'nagad': 0.015,       // 1.5% Nagad fee
      'sslcommerz': 0.025,  // 2.5% SSLCommerz fee
      'stripe': 0.029,      // 2.9% Stripe fee
      'manual': 0,          // No gateway fee
    },
  },
});

async function demonstrateCommissionTracking() {
  await mongoose.connect('mongodb://localhost:27017/revenue-commission-demo');

  console.log('\n========================================');
  console.log('COMMISSION TRACKING DEMONSTRATION');
  console.log('========================================\n');

  // ============================================================
  // EXAMPLE 1: Course Enrollment (10% commission)
  // ============================================================
  console.log('📚 EXAMPLE 1: Course Enrollment\n');

  const { transaction: courseTxn } = await revenue.monetization.create({
    data: {
      organizationId: new mongoose.Types.ObjectId(),
      customerId: new mongoose.Types.ObjectId(),
    },
    planKey: 'monthly',
    amount: 1000,  // 1000 BDT
    entity: 'CourseEnrollment',  // Maps to 'course_enrollment' → 10% commission
    gateway: 'bkash',  // 1.8% gateway fee
    monetizationType: 'subscription',
    paymentData: { method: 'bkash', walletNumber: '01712345678' },
  });

  console.log('Transaction created with commission:');
  console.log(`  Amount: ${courseTxn.amount} BDT`);
  console.log(`  Category: ${courseTxn.category}`);
  console.log(`  Gateway: ${courseTxn.gateway.type}`);
  console.log('\nCommission breakdown:');
  console.log(`  Rate: ${courseTxn.commission.rate * 100}%`);
  console.log(`  Gross Commission: ${courseTxn.commission.grossAmount} BDT (${courseTxn.commission.rate * 100}% of ${courseTxn.amount})`);
  console.log(`  Gateway Fee: ${courseTxn.commission.gatewayFeeAmount} BDT (${courseTxn.commission.gatewayFeeRate * 100}% of ${courseTxn.amount})`);
  console.log(`  Net Commission: ${courseTxn.commission.netAmount} BDT ⭐`);
  console.log(`  Status: ${courseTxn.commission.status}\n`);

  // ============================================================
  // EXAMPLE 2: Product Order (5% commission)
  // ============================================================
  console.log('📦 EXAMPLE 2: Product Order\n');

  const { transaction: productTxn } = await revenue.monetization.create({
    data: {
      organizationId: new mongoose.Types.ObjectId(),
      customerId: new mongoose.Types.ObjectId(),
    },
    planKey: 'monthly',
    amount: 2000,  // 2000 BDT
    entity: 'ProductOrder',  // Maps to 'product_order' → 5% commission
    gateway: 'nagad',  // 1.5% gateway fee
    monetizationType: 'purchase',
    paymentData: { method: 'nagad', walletNumber: '01812345678' },
  });

  console.log('Product order commission:');
  console.log(`  Amount: ${productTxn.amount} BDT`);
  console.log(`  Gross Commission: ${productTxn.commission.grossAmount} BDT (5%)`);
  console.log(`  Gateway Fee: ${productTxn.commission.gatewayFeeAmount} BDT (1.5%)`);
  console.log(`  Net Commission: ${productTxn.commission.netAmount} BDT\n`);

  // ============================================================
  // EXAMPLE 3: No Commission (Gym Membership)
  // ============================================================
  console.log('🏋️  EXAMPLE 3: Gym Membership (No Commission)\n');

  const { transaction: gymTxn } = await revenue.monetization.create({
    data: {
      organizationId: new mongoose.Types.ObjectId(),
      customerId: new mongoose.Types.ObjectId(),
    },
    planKey: 'monthly',
    amount: 1500,
    entity: 'GymMembership',  // Maps to 'gym_membership' → 0% commission
    gateway: 'manual',
    monetizationType: 'subscription',
    paymentData: { method: 'cash' },
  });

  console.log('Gym membership (no commission):');
  console.log(`  Amount: ${gymTxn.amount} BDT`);
  console.log(`  Commission: ${gymTxn.commission ? 'Yes' : 'No'} ⭐`);
  console.log('  (No commission field added when rate is 0%)\n');

  // ============================================================
  // EXAMPLE 4: Refund (Commission Waived)
  // ============================================================
  console.log('💸 EXAMPLE 4: Refund with Commission Reversal\n');

  // Verify the course transaction first
  await revenue.payments.verify(courseTxn._id);

  // Process partial refund
  const { refundTransaction } = await revenue.payments.refund(
    courseTxn._id,
    500,  // Refund 500 BDT (50% of 1000)
    { reason: 'Partial refund requested' }
  );

  console.log('Refund transaction created:');
  console.log(`  Amount: ${refundTransaction.amount} BDT`);
  console.log(`  Type: ${refundTransaction.type} (expense)`);
  console.log('\nCommission reversed (proportionally):');
  console.log(`  Original Net Commission: ${courseTxn.commission.netAmount} BDT`);
  console.log(`  Refund Ratio: 50%`);
  console.log(`  Reversed Commission: ${refundTransaction.commission.netAmount} BDT`);
  console.log(`  Status: ${refundTransaction.commission.status} ⭐\n`);

  // ============================================================
  // EXAMPLE 5: Query Pending Commissions
  // ============================================================
  console.log('📊 EXAMPLE 5: Query Pending Commissions\n');

  const pendingCommissions = await Transaction.find({
    'commission.status': 'pending',
    type: 'income',
  });

  console.log(`Found ${pendingCommissions.length} transactions with pending commissions:\n`);

  let totalPendingCommission = 0;
  pendingCommissions.forEach((txn, i) => {
    console.log(`  ${i + 1}. ${txn.category}: ${txn.commission.netAmount} BDT`);
    totalPendingCommission += txn.commission.netAmount;
  });

  console.log(`\nTotal Pending Commission: ${totalPendingCommission} BDT ⭐\n`);

  // ============================================================
  // EXAMPLE 6: Commission by Category (Analytics)
  // ============================================================
  console.log('📈 EXAMPLE 6: Commission Analytics\n');

  const allTransactions = await Transaction.find({ 
    type: 'income',
    commission: { $exists: true },
  });

  const commissionByCategory = {};
  allTransactions.forEach(txn => {
    if (!commissionByCategory[txn.category]) {
      commissionByCategory[txn.category] = {
        count: 0,
        totalAmount: 0,
        totalCommission: 0,
      };
    }
    commissionByCategory[txn.category].count++;
    commissionByCategory[txn.category].totalAmount += txn.amount;
    commissionByCategory[txn.category].totalCommission += txn.commission.netAmount;
  });

  console.log('Commission breakdown by category:');
  Object.entries(commissionByCategory).forEach(([category, stats]) => {
    const avgRate = (stats.totalCommission / stats.totalAmount * 100).toFixed(1);
    console.log(`\n  ${category}:`);
    console.log(`    Transactions: ${stats.count}`);
    console.log(`    Total Sales: ${stats.totalAmount} BDT`);
    console.log(`    Total Commission: ${stats.totalCommission} BDT`);
    console.log(`    Avg Rate: ${avgRate}%`);
  });

  console.log('\n========================================');
  console.log('COMMISSION TRACKING COMPLETE');
  console.log('========================================\n');

  await mongoose.disconnect();
}

// ============================================================
// KEY POINTS
// ============================================================
/**
 * COMMISSION CALCULATION:
 * 
 * 1. Automatic Calculation:
 *    - Library calculates commission based on config.commissionRates
 *    - Gateway fees automatically deducted from gross commission
 *    - Only adds commission field if rate > 0
 * 
 * 2. Formula:
 *    - Gross Commission = Amount × Commission Rate
 *    - Gateway Fee = Amount × Gateway Fee Rate
 *    - Net Commission = Gross Commission - Gateway Fee
 * 
 * 3. Refund Handling:
 *    - Refunds automatically reverse commission proportionally
 *    - Refund commission status: 'waived'
 *    - Original transaction commission unchanged
 * 
 * 4. Commission States:
 *    - 'pending': Awaiting verification
 *    - 'due': Payment verified, commission due
 *    - 'paid': Commission paid to platform
 *    - 'waived': Commission waived (refund)
 * 
 * 5. Querying Commissions:
 *    ```javascript
 *    // Pending commissions
 *    const pending = await Transaction.find({ 'commission.status': 'pending' });
 *    
 *    // Total commission by category
 *    const result = await Transaction.aggregate([
 *      { $match: { type: 'income', commission: { $exists: true } } },
 *      { $group: {
 *          _id: '$category',
 *          totalCommission: { $sum: '$commission.netAmount' }
 *        }
 *      }
 *    ]);
 *    ```
 * 
 * 6. Configuration:
 *    - commissionRates: Per-category rates (0 to 1)
 *    - gatewayFeeRates: Per-gateway fees (0 to 1)
 *    - If no config provided, commission field not added
 * 
 * 7. Schema Usage:
 *    ```javascript
 *    import { commissionSchema } from '@classytic/revenue/schemas';
 *    
 *    const schema = new mongoose.Schema({
 *      commission: commissionSchema,  // ✅ Nested (recommended)
 *    });
 *    ```
 */

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateCommissionTracking().catch(console.error);
}

export default demonstrateCommissionTracking;

