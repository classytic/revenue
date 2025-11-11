/**
 * Complete Transaction Flow Example
 * @classytic/revenue
 *
 * Demonstrates the full lifecycle with proper state management
 * Shows: Create → Verify → Refund (with state guards)
 */

import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import mongoose from 'mongoose';

// Simplified Transaction model for demo
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
  verifiedAt: Date,
  verifiedBy: mongoose.Schema.Types.ObjectId,
  refundedAt: Date,
  refundedAmount: Number,
  idempotencyKey: String,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

// Setup revenue instance
const revenue = createRevenue({
  models: { Transaction },
  providers: {
    manual: new ManualProvider(),
  },
  config: {
    transactionTypeMapping: {
      subscription: 'income',
      refund: 'expense',
    },
  },
  hooks: {
    'payment.verified': ({ transaction }) => {
      console.log(`✅ Payment verified: ${transaction._id}`);
    },
    'payment.refunded': ({ transaction, refundTransaction }) => {
      console.log(`💰 Refund processed: ${refundTransaction._id}`);
    },
  },
});

async function demonstrateCompleteFlow() {
  await mongoose.connect('mongodb://localhost:27017/revenue-flow');

  const orgId = new mongoose.Types.ObjectId();
  const customerId = new mongoose.Types.ObjectId();
  const adminId = new mongoose.Types.ObjectId();

  console.log('\n========================================');
  console.log('COMPLETE TRANSACTION FLOW DEMONSTRATION');
  console.log('========================================\n');

  // ============================================================
  // PHASE 1: CREATE SUBSCRIPTION (Transaction starts as PENDING)
  // ============================================================
  console.log('📦 PHASE 1: Creating Subscription\n');

  const { subscription, transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: orgId,
      customerId: customerId,
    },
    planKey: 'monthly',
    amount: 1500,
    currency: 'BDT',
    gateway: 'manual',
    paymentData: {
      method: 'bkash',
      walletNumber: '01712345678',
      transactionId: 'BKS123456',
    },
  });

  console.log('✓ Subscription created:', subscription._id);
  console.log('✓ Transaction created:', transaction._id);
  console.log(`  - Status: ${transaction.status} (pending)`);
  console.log(`  - Type: ${transaction.type} (income)`);
  console.log(`  - Method: ${transaction.method} (bkash)`);
  console.log(`  - Amount: ${transaction.amount} BDT\n`);

  // ============================================================
  // PHASE 2: TRY TO REFUND UNVERIFIED TRANSACTION (SHOULD FAIL)
  // ============================================================
  console.log('⚠️  PHASE 2: Attempting Refund on Unverified Transaction\n');

  try {
    await revenue.payments.refund(transaction._id, 500);
    console.log('❌ ERROR: Refund should have been blocked!\n');
  } catch (error) {
    console.log('✓ Refund blocked (expected):');
    console.log(`  - Error: ${error.message}`);
    console.log('  - Reason: Only verified/completed transactions can be refunded\n');
  }

  // ============================================================
  // PHASE 3: VERIFY PAYMENT (Admin approval)
  // ============================================================
  console.log('✅ PHASE 3: Admin Verifies Payment\n');

  const { transaction: verifiedTxn } = await revenue.payments.verify(
    transaction.gateway.paymentIntentId,
    { verifiedBy: adminId }
  );

  console.log('✓ Payment verified by admin');
  console.log(`  - Status: ${verifiedTxn.status} (verified)`);
  console.log(`  - Verified At: ${verifiedTxn.verifiedAt}`);
  console.log(`  - Verified By: ${verifiedTxn.verifiedBy}\n`);

  // ============================================================
  // PHASE 4: NOW REFUND WORKS (Transaction is verified)
  // ============================================================
  console.log('💰 PHASE 4: Processing Partial Refund\n');

  const { 
    transaction: refundedTxn, 
    refundTransaction,
    refundResult 
  } = await revenue.payments.refund(
    verifiedTxn._id,
    500,  // Partial refund
    { reason: 'Customer requested partial refund' }
  );

  console.log('✓ Refund successful!');
  console.log('\nOriginal Transaction:');
  console.log(`  - ID: ${refundedTxn._id}`);
  console.log(`  - Status: ${refundedTxn.status} (partially_refunded)`);
  console.log(`  - Type: ${refundedTxn.type} (income - unchanged)`);
  console.log(`  - Amount: ${refundedTxn.amount} BDT`);
  console.log(`  - Refunded: ${refundedTxn.refundedAmount} BDT`);
  console.log(`  - Net: ${refundedTxn.amount - refundedTxn.refundedAmount} BDT`);

  console.log('\nRefund Transaction (NEW):');
  console.log(`  - ID: ${refundTransaction._id}`);
  console.log(`  - Status: ${refundTransaction.status} (completed)`);
  console.log(`  - Type: ${refundTransaction.type} (expense - money out) ⭐`);
  console.log(`  - Amount: ${refundTransaction.amount} BDT`);
  console.log(`  - Method: ${refundTransaction.method} (same as original)`);
  console.log(`  - Original Txn: ${refundTransaction.metadata.originalTransactionId}\n`);

  // ============================================================
  // PHASE 5: ACCOUNTING SUMMARY
  // ============================================================
  console.log('📊 PHASE 5: Accounting Summary\n');

  const { transactions: allTransactions } = await revenue.transactions.list(
    { organizationId: orgId },
    { sort: { createdAt: 1 } }
  );

  console.log('All Transactions:');
  allTransactions.forEach((txn, i) => {
    console.log(`  ${i + 1}. ${txn.type.toUpperCase()} - ${txn.amount} BDT (${txn.status})`);
  });

  const income = allTransactions
    .filter(t => t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0);

  const expense = allTransactions
    .filter(t => t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0);

  const netRevenue = income - expense;

  console.log('\nFinancial Summary:');
  console.log(`  Total Income:  ${income} BDT`);
  console.log(`  Total Expense: ${expense} BDT`);
  console.log(`  ─────────────────────────`);
  console.log(`  Net Revenue:   ${netRevenue} BDT ✓\n`);

  // ============================================================
  // PHASE 6: TRY FULL REFUND (Should work)
  // ============================================================
  console.log('💸 PHASE 6: Processing Full Refund on Remaining Amount\n');

  const remainingAmount = refundedTxn.amount - refundedTxn.refundedAmount;

  const { 
    transaction: fullyRefundedTxn,
    refundTransaction: secondRefund 
  } = await revenue.payments.refund(
    refundedTxn._id,
    remainingAmount,
    { reason: 'Full refund - customer canceled' }
  );

  console.log('✓ Full refund processed');
  console.log(`  - Original Status: ${fullyRefundedTxn.status} (refunded)`);
  console.log(`  - Total Refunded: ${fullyRefundedTxn.refundedAmount} BDT`);
  console.log(`  - Second Refund Txn: ${secondRefund._id} (${secondRefund.type})\n`);

  // ============================================================
  // PHASE 7: FINAL STATE
  // ============================================================
  console.log('📋 PHASE 7: Final Transaction State\n');

  const { transactions: finalTransactions } = await revenue.transactions.list(
    { organizationId: orgId },
    { sort: { createdAt: 1 } }
  );

  console.log('Complete Transaction History:');
  finalTransactions.forEach((txn, i) => {
    const label = txn.metadata?.isRefund ? '(Refund)' : '(Payment)';
    console.log(`  ${i + 1}. ${txn.type.toUpperCase().padEnd(7)} ${label.padEnd(9)} - ${txn.amount} BDT - ${txn.status}`);
  });

  const finalIncome = finalTransactions
    .filter(t => t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0);

  const finalExpense = finalTransactions
    .filter(t => t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0);

  const finalNetRevenue = finalIncome - finalExpense;

  console.log('\nFinal Accounting (After Full Refund):');
  console.log(`  Total Income:  ${finalIncome} BDT  (1 payment)`);
  console.log(`  Total Expense: ${finalExpense} BDT  (2 refunds)`);
  console.log(`  ─────────────────────────`);
  console.log(`  Net Revenue:   ${finalNetRevenue} BDT  (should be 0) ✓\n`);

  console.log('========================================');
  console.log('FLOW DEMONSTRATION COMPLETE');
  console.log('========================================\n');

  await mongoose.disconnect();
}

// ============================================================
// KEY LEARNINGS
// ============================================================
/**
 * STATE MANAGEMENT RULES:
 * 
 * 1. ✅ Transactions start as 'pending'
 * 2. ✅ Admin must verify before refund allowed
 * 3. ✅ Refund blocked on unverified transactions (state guard)
 * 4. ✅ Refunds create NEW expense transactions (double-entry)
 * 5. ✅ Original transaction status updates (refunded/partially_refunded)
 * 6. ✅ Both transactions linked via metadata (audit trail)
 * 
 * ACCOUNTING PATTERN:
 * 
 * - Income transactions: type='income' (money in)
 * - Refund transactions: type='expense' (money out)
 * - Net Revenue = SUM(income) - SUM(expense)
 * - Follows Stripe's separate refund object pattern
 * 
 * IDEMPOTENCY:
 * 
 * - Each transaction has unique idempotencyKey
 * - Prevents duplicate payments on retry
 * - Safe for network failures
 * 
 * STATE TRANSITIONS:
 * 
 * Payment:  pending → verified → (refunded/partially_refunded)
 * Refund:   completed (instant)
 * 
 * VALIDATION GUARDS:
 * 
 * ❌ Cannot refund: pending, failed, cancelled
 * ✅ Can refund: verified, completed
 */

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateCompleteFlow().catch(console.error);
}

export default demonstrateCompleteFlow;

