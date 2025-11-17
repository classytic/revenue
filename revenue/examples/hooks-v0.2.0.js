/**
 * Hooks Example - v0.2.0 Features
 * @classytic/revenue
 *
 * Demonstrates the new semantic event hooks in v0.2.0:
 * - purchase.created (for one-time purchases)
 * - subscription.created (for recurring subscriptions)
 * - free.created (for free access grants)
 * - monetization.created (fires for all types)
 * - payment.failed (payment verification failures)
 */

import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import mongoose from 'mongoose';

// Transaction model
const transactionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  customerId: mongoose.Schema.Types.ObjectId,
  type: { type: String, enum: ['income', 'expense'], required: true },
  method: { type: String, required: true },
  status: { type: String, required: true },
  category: String,
  amount: { type: Number, required: true },
  currency: String,
  gateway: mongoose.Schema.Types.Mixed,
  paymentDetails: mongoose.Schema.Types.Mixed,
  metadata: mongoose.Schema.Types.Mixed,
  failureReason: String,
  verifiedAt: Date,
  refundedAt: Date,
  refundedAmount: Number,
  idempotencyKey: String,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

// Setup revenue with v0.2.0 hooks
const revenue = createRevenue({
  models: { Transaction },
  providers: {
    manual: new ManualProvider(),
  },
  config: {
    transactionTypeMapping: {
      subscription: 'income',
      purchase: 'income',
      refund: 'expense',
    },
  },
  hooks: {
    // ✅ NEW in v0.2.0: Fires ONLY for one-time purchases
    'purchase.created': async ({ transaction, monetizationType }) => {
      console.log('  🛒 PURCHASE.CREATED hook fired');
      console.log(`     Transaction: ${transaction._id}`);
      console.log(`     Amount: ${transaction.amount} ${transaction.currency}`);
      console.log(`     Type: ${monetizationType}`);

      // Example: Send purchase confirmation email
      // await emailService.sendPurchaseConfirmation(transaction);

      // Example: Update user's purchase history
      // await User.findByIdAndUpdate(transaction.customerId, {
      //   $push: { purchases: transaction._id }
      // });
    },

    // ✅ NEW in v0.2.0: Fires ONLY for recurring subscriptions
    'subscription.created': async ({ transaction, monetizationType }) => {
      console.log('  🔄 SUBSCRIPTION.CREATED hook fired');
      console.log(`     Transaction: ${transaction._id}`);
      console.log(`     Amount: ${transaction.amount} ${transaction.currency}`);
      console.log(`     Type: ${monetizationType}`);

      // Example: Grant subscription access
      // await User.findByIdAndUpdate(transaction.customerId, {
      //   subscriptionStatus: 'active',
      //   subscriptionStartDate: new Date()
      // });

      // Example: Send subscription welcome email
      // await emailService.sendSubscriptionWelcome(transaction);
    },

    // ✅ NEW in v0.2.0: Fires ONLY for free access grants
    'free.created': async ({ transaction, monetizationType }) => {
      console.log('  🎁 FREE.CREATED hook fired');
      console.log(`     Transaction: ${transaction._id}`);
      console.log(`     Type: ${monetizationType}`);

      // Example: Grant free access
      // await User.findByIdAndUpdate(transaction.customerId, {
      //   hasAccess: true,
      //   accessType: 'free'
      // });
    },

    // ✅ NEW in v0.2.0: Fires for ALL monetization types
    // Use this for cross-type analytics or logging
    'monetization.created': async ({ transaction, monetizationType }) => {
      console.log('  📊 MONETIZATION.CREATED hook fired (fires for all types)');
      console.log(`     Monetization type: ${monetizationType}`);

      // Example: Analytics tracking
      // await analytics.track({
      //   event: 'monetization_created',
      //   type: monetizationType,
      //   amount: transaction.amount,
      //   currency: transaction.currency,
      //   organizationId: transaction.organizationId,
      // });

      // Example: Update organization stats
      // await Organization.findByIdAndUpdate(transaction.organizationId, {
      //   $inc: { totalRevenue: transaction.amount }
      // });
    },

    // ✅ NEW in v0.2.0: Fires when payment verification fails
    'payment.failed': async ({ transaction, error, provider }) => {
      console.log('  ❌ PAYMENT.FAILED hook fired');
      console.log(`     Transaction: ${transaction._id}`);
      console.log(`     Error: ${error}`);
      console.log(`     Provider: ${provider}`);
      console.log(`     Failure reason: ${transaction.failureReason}`);

      // Example: Send payment failure notification
      // await emailService.sendPaymentFailureNotification({
      //   customerId: transaction.customerId,
      //   amount: transaction.amount,
      //   reason: transaction.failureReason
      // });

      // Example: Log to error tracking service
      // await errorTracker.log({
      //   type: 'payment_failed',
      //   transactionId: transaction._id,
      //   error,
      //   provider,
      // });

      // Example: Alert admin for manual review
      // if (transaction.amount > 10000) {
      //   await adminNotifier.alert('high_value_payment_failed', transaction);
      // }
    },

    // Existing hooks (still work the same)
    'payment.verified': ({ transaction }) => {
      console.log('  ✅ PAYMENT.VERIFIED hook fired');
      console.log(`     Transaction: ${transaction._id} verified`);
    },

    'payment.refunded': ({ transaction, refundTransaction }) => {
      console.log('  💰 PAYMENT.REFUNDED hook fired');
      console.log(`     Refund: ${refundTransaction._id}`);
    },
  },
});

async function demonstrateHooks() {
  await mongoose.connect('mongodb://localhost:27017/revenue-hooks-demo');

  const orgId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();

  console.log('\n========================================');
  console.log('  v0.2.0 HOOKS DEMONSTRATION');
  console.log('========================================\n');

  // ============================================================
  // EXAMPLE 1: One-Time Purchase
  // ============================================================
  console.log('📦 EXAMPLE 1: Creating One-Time Purchase\n');
  console.log('Expected hooks: purchase.created + monetization.created\n');

  const { transaction: purchaseTxn } = await revenue.subscriptions.create({
    data: {
      organizationId: orgId,
      customerId: customerId,
    },
    planKey: 'one-time',
    amount: 5000,
    currency: 'BDT',
    gateway: 'manual',
    monetizationType: 'purchase',  // ⭐ One-time purchase
    paymentData: {
      method: 'card',
    },
  });

  console.log(`\n✓ Purchase created: ${purchaseTxn._id}\n`);

  // ============================================================
  // EXAMPLE 2: Recurring Subscription
  // ============================================================
  console.log('🔄 EXAMPLE 2: Creating Recurring Subscription\n');
  console.log('Expected hooks: subscription.created + monetization.created\n');

  const { transaction: subscriptionTxn } = await revenue.subscriptions.create({
    data: {
      organizationId: orgId,
      customerId: customerId,
    },
    planKey: 'monthly',
    amount: 2999,
    currency: 'BDT',
    gateway: 'manual',
    monetizationType: 'subscription',  // ⭐ Recurring subscription
    paymentData: {
      method: 'card',
    },
  });

  console.log(`\n✓ Subscription created: ${subscriptionTxn._id}\n`);

  // ============================================================
  // EXAMPLE 3: Free Access Grant
  // ============================================================
  console.log('🎁 EXAMPLE 3: Granting Free Access\n');
  console.log('Expected hooks: free.created + monetization.created\n');

  const { transaction: freeTxn } = await revenue.subscriptions.create({
    data: {
      organizationId: orgId,
      customerId: customerId,
    },
    planKey: 'free',
    amount: 0,
    currency: 'BDT',
    gateway: 'manual',
    monetizationType: 'free',  // ⭐ Free access
    paymentData: {
      method: 'free',
    },
  });

  console.log(`\n✓ Free access granted: ${freeTxn._id}\n`);

  // ============================================================
  // EXAMPLE 4: Payment Failure
  // ============================================================
  console.log('❌ EXAMPLE 4: Simulating Payment Failure\n');
  console.log('Expected hooks: payment.failed\n');

  const { transaction: failedTxn } = await revenue.subscriptions.create({
    data: {
      organizationId: orgId,
      customerId: customerId,
    },
    planKey: 'monthly',
    amount: 1500,
    currency: 'BDT',
    gateway: 'manual',
    monetizationType: 'subscription',
    paymentData: {
      method: 'card',
      shouldFail: true,  // Trigger failure
    },
  });

  // Try to verify with wrong amount (will fail)
  try {
    await revenue.payments.verify(failedTxn.gateway.paymentIntentId, {
      amount: 9999,  // Wrong amount!
    });
  } catch (error) {
    console.log(`\n✓ Payment verification failed as expected`);
    console.log(`  Error: ${error.message}\n`);
  }

  console.log('========================================');
  console.log('  HOOK SUMMARY');
  console.log('========================================\n');

  console.log('✅ purchase.created → Fires for monetizationType: "purchase"');
  console.log('✅ subscription.created → Fires for monetizationType: "subscription"');
  console.log('✅ free.created → Fires for monetizationType: "free"');
  console.log('✅ monetization.created → Fires for ALL types');
  console.log('✅ payment.failed → Fires when verification fails\n');

  await mongoose.disconnect();
}

// ============================================================
// MIGRATION FROM v0.1.0 to v0.2.0
// ============================================================
/**
 * BREAKING CHANGE: subscription.created behavior changed
 *
 * ❌ BEFORE (v0.1.0):
 *
 * hooks: {
 *   'subscription.created': async ({ transaction }) => {
 *     // This fired for BOTH purchases AND subscriptions!
 *     // You had to check metadata.monetizationType manually
 *     const type = transaction.metadata?.monetizationType;
 *
 *     if (type === 'purchase') {
 *       // Handle purchase
 *     } else if (type === 'subscription') {
 *       // Handle subscription
 *     }
 *   }
 * }
 *
 * ✅ AFTER (v0.2.0):
 *
 * hooks: {
 *   'purchase.created': async ({ transaction, monetizationType }) => {
 *     // Only fires for purchases
 *     // No need to check type - it's always 'purchase'
 *   },
 *
 *   'subscription.created': async ({ transaction, monetizationType }) => {
 *     // Only fires for subscriptions
 *     // No need to check type - it's always 'subscription'
 *   },
 *
 *   'free.created': async ({ transaction, monetizationType }) => {
 *     // Only fires for free access
 *   },
 *
 *   // Optional: Use this if you want to handle all types together
 *   'monetization.created': async ({ transaction, monetizationType }) => {
 *     // Fires for ALL types
 *     // Use monetizationType parameter to differentiate
 *   }
 * }
 *
 * BENEFITS OF v0.2.0:
 *
 * 1. ✅ Clearer semantics - hook names match intent
 * 2. ✅ Type safety - each hook has specific purpose
 * 3. ✅ Easier code - no manual type checking needed
 * 4. ✅ Better errors - payment.failed hook for failures
 * 5. ✅ Backward compatible - monetization.created works like old behavior
 */

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateHooks().catch(console.error);
}

export default demonstrateHooks;
