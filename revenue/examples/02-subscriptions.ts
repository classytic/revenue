/**
 * Subscriptions Example
 * @classytic/revenue
 *
 * TWO PATTERNS:
 * 1. Transaction-only (recommended) - Track payments, use sourceModel
 * 2. With Subscription model - For subscription STATE management (optional)
 */

import mongoose from 'mongoose';
import {
  Revenue,
  TRANSACTION_FLOW_VALUES,
  TRANSACTION_STATUS_VALUES,
  gatewaySchema,
  commissionSchema,
} from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

// ============ TRANSACTION MODEL (Required) ============

const CATEGORIES = [
  'platform_subscription',
  'refund',
] as const;

const TransactionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, required: true },
  customerId: mongoose.Schema.Types.ObjectId,
  type: { type: String, enum: CATEGORIES, required: true }, // category
  flow: { type: String, enum: TRANSACTION_FLOW_VALUES, required: true },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, default: 'pending' },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  method: { type: String, default: 'manual' },
  gateway: gatewaySchema,
  commission: commissionSchema,
  sourceId: { type: mongoose.Schema.Types.ObjectId, refPath: 'sourceModel' },
  sourceModel: { type: String },
  verifiedAt: Date,
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', TransactionSchema);

// ============ SUBSCRIPTION MODEL (Optional) ============
// Only needed if you want to track subscription STATE (active/paused/cancelled)
// Your subscription entity (external to revenue library)

const SubscriptionSchema = new mongoose.Schema({
  customerId: mongoose.Schema.Types.ObjectId,
  organizationId: mongoose.Schema.Types.ObjectId,
  planKey: String,
  status: { type: String, default: 'pending' }, // pending, active, paused, cancelled
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  pausedAt: Date,
  cancelledAt: Date,
  renewalCount: { type: Number, default: 0 },
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Subscription = mongoose.model('Subscription', SubscriptionSchema);

// ============ PATTERN 1: Transaction-Only (Simpler) ============

async function patternTransactionOnly() {
  console.log('\n📊 PATTERN 1: Transaction-Only\n');
  console.log('Use this when you manage subscription state elsewhere.');
  console.log('Transaction tracks PAYMENTS, sourceModel links to your entities.\n');

  const revenue = Revenue
    .create({ defaultCurrency: 'USD' })
    .withModels({ Transaction: Transaction as any })  // Only Transaction!
    .withProvider('manual', new ManualProvider())
    .withCategoryMappings({
      PlatformSubscription: 'platform_subscription',
    })
    .build();

  const orgId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const subscriptionId = new mongoose.Types.ObjectId(); // Your external subscription

  // Create initial payment
  console.log('1️⃣ Creating subscription payment...');
  const { transaction } = await revenue.monetization.create({
    data: {
      organizationId: orgId,
      customerId,
      sourceId: subscriptionId,
      sourceModel: 'Subscription',
    },
    planKey: 'monthly',
    monetizationType: 'subscription',
    entity: 'PlatformSubscription',
    amount: 2999,
    gateway: 'manual',
  });
  console.log('Transaction:', transaction?._id);
  console.log('Linked to:', transaction?.sourceModel, transaction?.sourceId);

  // Verify payment
  console.log('\n2️⃣ Verifying payment...');
  await revenue.payments.verify(transaction!._id.toString());

  // Query payments for this subscription
  const payments = await Transaction.find({
    sourceModel: 'Subscription',
    sourceId: subscriptionId,
    status: 'verified',
  });
  console.log('\n3️⃣ Payments for subscription:', payments.length);

  // You manage subscription state in YOUR model
  // Update your Subscription model's status, period dates, etc.
}

// ============ PATTERN 2: With Subscription Model (Full Lifecycle) ============

async function patternWithSubscription() {
  console.log('\n\n📋 PATTERN 2: With Subscription Model\n');
  console.log('Use this when you want the library to manage subscription state.\n');

  const revenue = Revenue
    .create({ defaultCurrency: 'USD' })
    .withModels({
      Transaction: Transaction as any,
      Subscription: Subscription as any,  // Optional!
    })
    .withProvider('manual', new ManualProvider())
    .build();

  const orgId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();

  // 1. Create subscription (library creates Subscription document)
  console.log('1️⃣ Creating subscription...');
  const { subscription, transaction } = await revenue.monetization.create({
    data: {
      organizationId: orgId,
      customerId,
    },
    planKey: 'monthly',
    monetizationType: 'subscription',
    amount: 2999,
    gateway: 'manual',
  });
  console.log('Subscription:', subscription?._id);
  console.log('Status:', subscription?.status); // 'pending'
  console.log('Transaction:', transaction?._id);

  // 2. Verify payment
  console.log('\n2️⃣ Verifying payment...');
  await revenue.payments.verify(transaction!._id.toString());

  // 3. Activate subscription (sets period dates)
  console.log('\n3️⃣ Activating subscription...');
  const activated = await revenue.monetization.activate(subscription!._id.toString());
  console.log('Status:', activated.subscription.status); // 'active'
  console.log('Period start:', activated.subscription.currentPeriodStart);
  console.log('Period end:', activated.subscription.currentPeriodEnd);

  // 4. Renew subscription
  console.log('\n4️⃣ Renewing subscription...');
  const renewed = await revenue.monetization.renew(subscription!._id.toString(), {
    gateway: 'manual',
  });
  console.log('New transaction:', renewed.transaction._id);
  console.log('Renewal count:', renewed.renewalCount);

  // 5. Pause subscription
  console.log('\n5️⃣ Pausing subscription...');
  const paused = await revenue.monetization.pause(subscription!._id.toString(), {
    reason: 'Customer vacation',
  });
  console.log('Status:', paused.subscription.status); // 'paused'

  // 6. Resume subscription
  console.log('\n6️⃣ Resuming subscription...');
  const resumed = await revenue.monetization.resume(subscription!._id.toString());
  console.log('Status:', resumed.subscription.status); // 'active'

  // 7. Cancel subscription
  console.log('\n7️⃣ Cancelling subscription...');
  const cancelled = await revenue.monetization.cancel(subscription!._id.toString(), {
    immediate: false, // At period end
    reason: 'Customer churn',
  });
  console.log('Status:', cancelled.subscription.status); // 'cancelled'
}

// ============ SUMMARY ============

console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                   SUBSCRIPTION PATTERNS                            ║
╠═══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  PATTERN 1: Transaction-Only (Recommended for most apps)          ║
║  ─────────────────────────────────────────────────────             ║
║  • Transaction tracks payments                                     ║
║  • sourceId/sourceModel links to YOUR entities               ║
║  • You manage subscription state in your own model                 ║
║  • More flexible, less coupling                                    ║
║                                                                    ║
║  PATTERN 2: With Subscription Model                                ║
║  ─────────────────────────────────────────────────────             ║
║  • Library creates/manages Subscription documents                  ║
║  • Built-in activate/pause/resume/cancel/renew                     ║
║  • Good for simple subscription apps                               ║
║  • Transaction still tracks all payments                           ║
║                                                                    ║
╚═══════════════════════════════════════════════════════════════════╝
`);

// ============ RUN ============

async function main() {
  await mongoose.connect('mongodb://localhost:27017/revenue_example');
  
  try {
    await patternTransactionOnly();
    await patternWithSubscription();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(console.error);
