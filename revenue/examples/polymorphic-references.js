/**
 * Polymorphic References Example
 * @classytic/revenue
 *
 * Shows how to link transactions to different entities (Order, Subscription, Enrollment)
 * using Mongoose polymorphic references for proper querying
 */

import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import mongoose from 'mongoose';

// Setup models
const transactionSchema = new mongoose.Schema({
  organizationId: mongoose.Schema.Types.ObjectId,
  amount: Number,
  type: String,
  method: String,
  status: String,
  category: String,
  
  // ⭐ Polymorphic reference (TOP LEVEL)
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceModel',
    index: true,
  },
  referenceModel: {
    type: String,
    enum: ['Subscription', 'Order', 'Enrollment', 'Membership'],
    index: true,
  },
  
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

const revenue = createRevenue({
  models: { Transaction },
  providers: { manual: new ManualProvider() },
});

async function demonstratePolymorphicReferences() {
  await mongoose.connect('mongodb://localhost:27017/revenue-polymorphic');

  const orgId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();

  // ============================================================
  // EXAMPLE 1: Link to Subscription
  // ============================================================
  console.log('\n📦 EXAMPLE 1: Transaction linked to Subscription\n');

  const subscriptionId = new mongoose.Types.ObjectId();

  const { transaction: sub1Txn } = await revenue.subscriptions.create({
    data: {
      organizationId: orgId,
      customerId,
      referenceId: subscriptionId,      // ⭐ Link to Subscription
      referenceModel: 'Subscription',   // ⭐ Model name
    },
    planKey: 'monthly',
    amount: 1500,
    gateway: 'manual',
    paymentData: { method: 'bkash' },
  });

  console.log('Transaction created:');
  console.log(`  ID: ${sub1Txn._id}`);
  console.log(`  Reference: ${sub1Txn.referenceModel} → ${sub1Txn.referenceId}`);
  console.log(`  Stored at TOP LEVEL (not in metadata) ✅\n`);

  // ============================================================
  // EXAMPLE 2: Link to Order
  // ============================================================
  console.log('🛒 EXAMPLE 2: Transaction linked to Order\n');

  const orderId = new mongoose.Types.ObjectId();

  const { transaction: orderTxn } = await revenue.subscriptions.create({
    data: {
      organizationId: orgId,
      customerId,
      referenceId: orderId,           // ⭐ Link to Order
      referenceModel: 'Order',        // ⭐ Different model
    },
    planKey: 'one-time',
    amount: 2500,
    gateway: 'manual',
    entity: 'ProductOrder',
    monetizationType: 'purchase',
    paymentData: { method: 'card' },
  });

  console.log('Transaction created:');
  console.log(`  ID: ${orderTxn._id}`);
  console.log(`  Reference: ${orderTxn.referenceModel} → ${orderTxn.referenceId}\n`);

  // ============================================================
  // EXAMPLE 3: Query by Reference
  // ============================================================
  console.log('🔍 EXAMPLE 3: Query Transactions by Reference\n');

  // Find all transactions for a specific subscription
  const subscriptionTransactions = await Transaction.find({
    referenceModel: 'Subscription',
    referenceId: subscriptionId,
  });

  console.log(`Found ${subscriptionTransactions.length} transaction(s) for Subscription ${subscriptionId}`);

  // Find all Order transactions
  const orderTransactions = await Transaction.find({
    referenceModel: 'Order',
  });

  console.log(`Found ${orderTransactions.length} transaction(s) for Orders\n`);

  // ============================================================
  // EXAMPLE 4: Populate Reference (Mongoose Magic)
  // ============================================================
  console.log('✨ EXAMPLE 4: Populate Referenced Entity\n');

  // This would work if you have actual Order/Subscription models
  // const transactionsWithRefs = await Transaction.find({})
  //   .populate('referenceId');  // ⭐ Mongoose populates based on referenceModel
  
  console.log('With proper models, you can:');
  console.log('  - .populate("referenceId") → Gets full Order/Subscription data');
  console.log('  - transaction.referenceId.customerName');
  console.log('  - transaction.referenceId.items (if Order)');
  console.log('  - transaction.referenceId.planKey (if Subscription)\n');

  // ============================================================
  // EXAMPLE 5: Refund Inherits Reference
  // ============================================================
  console.log('💸 EXAMPLE 5: Refund Inherits Polymorphic Reference\n');

  await revenue.payments.verify(sub1Txn.gateway.paymentIntentId);

  const { refundTransaction } = await revenue.payments.refund(
    sub1Txn._id,
    500,
    { reason: 'Partial refund' }
  );

  console.log('Refund transaction created:');
  console.log(`  Type: ${refundTransaction.type} (expense)`);
  console.log(`  Reference: ${refundTransaction.referenceModel} → ${refundTransaction.referenceId}`);
  console.log('  ⭐ Inherited from original transaction ✅\n');

  // ============================================================
  // EXAMPLE 6: Analytics by Entity Type
  // ============================================================
  console.log('📊 EXAMPLE 6: Analytics by Entity Type\n');

  const analyticsByModel = await Transaction.aggregate([
    {
      $match: { type: 'income' }
    },
    {
      $group: {
        _id: '$referenceModel',
        totalTransactions: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
      }
    }
  ]);

  console.log('Revenue by entity type:');
  analyticsByModel.forEach(stat => {
    console.log(`  ${stat._id || 'No Reference'}: ${stat.totalTransactions} txns, ${stat.totalAmount} BDT`);
  });

  console.log('\n========================================');
  console.log('POLYMORPHIC REFERENCES COMPLETE');
  console.log('========================================\n');

  await mongoose.disconnect();
}

// ============================================================
// KEY POINTS
// ============================================================
/**
 * POLYMORPHIC REFERENCE BENEFITS:
 * 
 * 1. ✅ Proper Mongoose Queries:
 *    - Transaction.find({ referenceModel: 'Order', referenceId: orderId })
 *    - Can't do this if stored in metadata!
 * 
 * 2. ✅ Indexing:
 *    - transactionSchema.index({ referenceModel: 1, referenceId: 1 })
 *    - Fast lookups for entity transactions
 * 
 * 3. ✅ Population:
 *    - .populate('referenceId') works automatically
 *    - Gets full entity data (Order details, Subscription info, etc.)
 * 
 * 4. ✅ Aggregation:
 *    - Group by referenceModel for analytics
 *    - Count transactions per entity type
 * 
 * 5. ✅ Refund Inheritance:
 *    - Refund transactions automatically inherit reference
 *    - Maintains link to original entity
 * 
 * HOW TO USE:
 * 
 * ```javascript
 * // Pass in data param (NOT metadata!)
 * await revenue.subscriptions.create({
 *   data: {
 *     organizationId,
 *     customerId,
 *     referenceId: order._id,       // ⭐ Entity ID
 *     referenceModel: 'Order',      // ⭐ Model name
 *   },
 *   amount: 1500,
 *   // ...
 * });
 * ```
 * 
 * TRANSACTION MODEL SETUP:
 * 
 * ```javascript
 * const transactionSchema = new mongoose.Schema({
 *   // ... other fields
 *   
 *   referenceId: {
 *     type: mongoose.Schema.Types.ObjectId,
 *     refPath: 'referenceModel',    // ⭐ Dynamic reference
 *   },
 *   referenceModel: {
 *     type: String,
 *     enum: ['Subscription', 'Order', 'Enrollment'], // Your models
 *   },
 * });
 * 
 * // Add compound index
 * transactionSchema.index({ referenceModel: 1, referenceId: 1 });
 * ```
 */

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstratePolymorphicReferences().catch(console.error);
}

export default demonstratePolymorphicReferences;

