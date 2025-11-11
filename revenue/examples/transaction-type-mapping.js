/**
 * Transaction Type Mapping Example
 * @classytic/revenue
 *
 * Shows how to configure transaction type mapping for proper accounting
 * Maps library operations to your accounting system's income/expense types
 */

import { createRevenue, TRANSACTION_TYPE } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import mongoose from 'mongoose';

// 1. Define Transaction Model with proper type field
const transactionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Transaction type: income (money in) vs expense (money out)
  type: { 
    type: String, 
    enum: ['income', 'expense'], 
    required: true 
  },
  
  // Payment method for easier reference
  method: { 
    type: String, 
    enum: ['manual', 'bkash', 'nagad', 'bank', 'card', 'cash'], 
    required: true 
  },
  
  // Category for grouping transactions
  category: { type: String, trim: true },
  
  // Transaction status
  status: {
    type: String,
    enum: ['pending', 'verified', 'completed', 'failed', 'cancelled', 'refunded'],
    default: 'pending',
  },
  
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'BDT' },
  
  // Payment gateway integration
  gateway: {
    type: { type: String },
    paymentIntentId: { type: String },
    provider: { type: String },
    verificationData: { type: mongoose.Schema.Types.Mixed },
  },
  
  // Payment details (wallet info, bank details, etc.)
  paymentDetails: {
    provider: String,
    walletNumber: String,
    transactionId: String,
    accountNumber: String,
  },
  
  // Idempotency key for duplicate prevention
  idempotencyKey: { type: String, trim: true },
  
  // Webhook tracking
  webhook: {
    eventId: String,
    eventType: String,
    receivedAt: Date,
    processedAt: Date,
    data: mongoose.Schema.Types.Mixed,
  },
  
  // Verification tracking
  verifiedAt: { type: Date },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Additional metadata
  metadata: { type: mongoose.Schema.Types.Mixed },
  
  // Polymorphic reference to any entity
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'referenceModel',
  },
  referenceModel: {
    type: String,
    enum: ['Subscription', 'Order', 'Enrollment', 'Membership'],
  },
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

// 2. Create revenue instance with transaction type mapping
const revenue = createRevenue({
  models: {
    Transaction,
  },
  
  providers: {
    manual: new ManualProvider(),
  },
  
  config: {
    // Map entity types to custom categories
    categoryMappings: {
      PlatformSubscription: 'platform_subscription',
      CourseEnrollment: 'course_enrollment',
      ProductOrder: 'product_order',
      GymMembership: 'gym_membership',
    },
    
    // ⭐ Configure transaction type mapping
    // Maps library operations to income/expense for your accounting
    transactionTypeMapping: {
      // Subscription payments are income
      subscription: 'income',
      subscription_renewal: 'income',
      
      // Purchases are income
      purchase: 'income',
      
      // Refunds are expense (money going out)
      refund: 'expense',
      
      // You can add custom mappings for different monetization types
      free: 'income',  // Even free subscriptions create records
    },
  },
  
  hooks: {
    'payment.verified': async ({ transaction }) => {
      console.log('✅ Payment verified:', {
        id: transaction._id,
        type: transaction.type,        // 'income'
        method: transaction.method,    // 'manual'
        amount: transaction.amount,
      });
    },
    
    'subscription.created': async ({ subscription, transaction, isFree }) => {
      console.log('📦 Subscription created:', {
        subscriptionId: subscription._id,
        transactionType: transaction?.type,  // 'income' (from mapping)
        isFree,
      });
    },
  },
});

// 3. Usage Examples
async function example() {
  await mongoose.connect('mongodb://localhost:27017/revenue-demo');

  // ============ EXAMPLE 1: Create paid subscription ============
  console.log('\n=== Creating Paid Subscription ===');
  
  const { subscription, transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: new mongoose.Types.ObjectId(),
      customerId: new mongoose.Types.ObjectId(),
    },
    planKey: 'monthly',
    amount: 1500,
    currency: 'BDT',
    gateway: 'manual',
    entity: 'PlatformSubscription',
    monetizationType: 'subscription',
    paymentData: {
      method: 'bkash',              // ⭐ Payment method stored at top level
      walletNumber: '01712345678',
      transactionId: 'BKS123456',
    },
    metadata: {
      notes: 'Annual platform subscription',
    },
  });

  console.log('Transaction created:', {
    id: transaction._id,
    type: transaction.type,          // 'income' (from mapping)
    method: transaction.method,      // 'bkash' (from paymentData)
    amount: transaction.amount,
    status: transaction.status,
    category: transaction.category,  // 'platform_subscription' (from categoryMappings)
  });

  // ============ EXAMPLE 2: Verify payment ============
  console.log('\n=== Verifying Payment ===');
  
  const { transaction: verified } = await revenue.payments.verify(
    transaction.gateway.paymentIntentId,
    {
      verifiedBy: new mongoose.Types.ObjectId(),
    }
  );

  console.log('Payment verified:', {
    status: verified.status,        // 'verified'
    verifiedAt: verified.verifiedAt,
    type: verified.type,            // Still 'income'
  });

  // ============ EXAMPLE 3: Free subscription ============
  console.log('\n=== Creating Free Subscription ===');
  
  const { subscription: freeSub } = await revenue.subscriptions.create({
    data: {
      organizationId: new mongoose.Types.ObjectId(),
      customerId: new mongoose.Types.ObjectId(),
    },
    planKey: 'monthly',
    amount: 0,  // Free!
    entity: 'PlatformSubscription',
    monetizationType: 'free',
  });

  console.log('Free subscription created:', {
    id: freeSub._id,
    isActive: freeSub.isActive,  // true immediately
    status: freeSub.status,       // 'active'
  });

  // ============ EXAMPLE 4: Subscription renewal ============
  console.log('\n=== Renewing Subscription ===');
  
  const { transaction: renewalTxn } = await revenue.subscriptions.renew(
    subscription._id,
    {
      gateway: 'manual',
      paymentData: {
        method: 'nagad',
        walletNumber: '01812345678',
      },
    }
  );

  console.log('Renewal transaction:', {
    type: renewalTxn.type,         // 'income' (from subscription_renewal mapping)
    method: renewalTxn.method,     // 'nagad'
    isRenewal: renewalTxn.metadata.isRenewal,  // true
  });

  // ============ EXAMPLE 5: Refund (creates EXPENSE transaction) ============
  console.log('\n=== Processing Refund ===');
  
  const { 
    transaction: originalTxn, 
    refundTransaction 
  } = await revenue.payments.refund(
    verified._id,
    500,  // Partial refund
    { reason: 'Customer requested partial refund' }
  );

  console.log('Refund processed:', {
    originalTransaction: {
      id: originalTxn._id,
      type: originalTxn.type,              // Still 'income'
      status: originalTxn.status,          // 'partially_refunded'
      refundedAmount: originalTxn.refundedAmount,  // 500
    },
    refundTransaction: {
      id: refundTransaction._id,
      type: refundTransaction.type,        // 'expense' ⭐
      amount: refundTransaction.amount,    // 500
      status: refundTransaction.status,    // 'completed'
      isRefund: refundTransaction.metadata.isRefund,  // true
    },
  });

  // ============ EXAMPLE 6: Query transactions by type ============
  console.log('\n=== Querying Transactions by Type ===');
  
  // Get all income transactions
  const { transactions: incomeTransactions } = await revenue.transactions.list(
    { type: 'income' },
    { limit: 10, sort: { createdAt: -1 } }
  );

  console.log(`Found ${incomeTransactions.length} income transactions`);

  // Get all expense transactions (refunds)
  const { transactions: expenseTransactions } = await revenue.transactions.list(
    { type: 'expense' },
    { limit: 10, sort: { createdAt: -1 } }
  );

  console.log(`Found ${expenseTransactions.length} expense transactions (refunds)`);

  // Calculate net revenue (income - expenses)
  const totalIncome = incomeTransactions.reduce((sum, txn) => sum + txn.amount, 0);
  const totalExpense = expenseTransactions.reduce((sum, txn) => sum + txn.amount, 0);
  const netRevenue = totalIncome - totalExpense;

  console.log('Financial Summary:');
  console.log(`  Total Income:   ${totalIncome} BDT`);
  console.log(`  Total Expense:  ${totalExpense} BDT`);
  console.log(`  Net Revenue:    ${netRevenue} BDT`);

  await mongoose.disconnect();
}

// ============ KEY POINTS ============
/**
 * 1. Transaction Type (type field):
 *    - 'income': Payments, subscriptions, purchases (money coming in)
 *    - 'expense': Refunds, payouts (money going out)
 *    - Library uses transactionTypeMapping to determine this
 *    - Defaults to 'income' if no mapping provided
 * 
 * 2. Payment Method (method field):
 *    - Stored at transaction top level for easier querying
 *    - Extracted from paymentData?.method or defaults to 'manual'
 *    - Use for filtering: "Show all bKash payments"
 * 
 * 3. Category (category field):
 *    - Resolved from entity + monetizationType using categoryMappings
 *    - Falls back to library defaults: 'subscription' or 'purchase'
 *    - Use for grouping: "Show all course enrollment revenue"
 * 
 * 4. Type vs Category:
 *    - Type: Accounting direction (income/expense)
 *    - Category: Business classification (subscription/enrollment/order)
 * 
 * 5. Refund Pattern (Double-Entry Accounting):
 *    - Refunds CREATE a NEW transaction with type='expense'
 *    - Original transaction status becomes 'refunded' or 'partially_refunded'
 *    - Both transactions linked via metadata for audit trail
 *    - Calculate net revenue: SUM(income) - SUM(expense)
 *    - Follows Stripe's pattern (separate refund objects)
 * 
 * 6. Customization:
 *    - You control type mapping via config.transactionTypeMapping
 *    - You control categories via config.categoryMappings
 *    - Library provides sensible defaults
 */

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  example().catch(console.error);
}

export default example;

