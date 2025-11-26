/**
 * Single-Tenant Example
 * @classytic/revenue
 *
 * Simple SaaS with no organizations - just users/customers
 */

import { createRevenue } from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';
import mongoose from 'mongoose';

// Simple Transaction model (no organizationId)
const transactionSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  type: { type: String, enum: ['income', 'expense'], required: true },
  method: { type: String, required: true },
  status: { type: String, required: true },
  category: String,
  currency: { type: String, default: 'USD' },
  gateway: mongoose.Schema.Types.Mixed,
  paymentDetails: mongoose.Schema.Types.Mixed,
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

// Setup revenue
const revenue = createRevenue({
  models: { Transaction },
  providers: { manual: new ManualProvider() },
});

async function example() {
  await mongoose.connect('mongodb://localhost:27017/single-tenant-demo');

  const userId = new mongoose.Types.ObjectId();

  // ============================================================
  // Create subscription (NO organizationId)
  // ============================================================
  const { subscription, transaction } = await revenue.monetization.create({
    data: {
      customerId: userId,  // ✅ Just customerId, no organizationId
    },
    planKey: 'monthly',
    amount: 2999,  // $29.99
    currency: 'USD',
    gateway: 'manual',
    paymentData: {
      method: 'card',
    },
  });

  console.log('✅ Single-tenant subscription created:', transaction._id);

  // ============================================================
  // Verify payment
  // ============================================================
  await revenue.payments.verify(transaction.gateway.paymentIntentId);

  console.log('✅ Payment verified');

  // ============================================================
  // List user's transactions
  // ============================================================
  const { transactions } = await revenue.transactions.list(
    { customerId: userId },  // ✅ Query by customerId
    { sort: { createdAt: -1 } }
  );

  console.log(`✅ Found ${transactions.length} transactions for user`);

  await mongoose.disconnect();
}

/**
 * KEY POINTS FOR SINGLE-TENANT:
 * 
 * 1. ✅ organizationId is OPTIONAL
 * 2. ✅ Use customerId for user tracking
 * 3. ✅ Query by { customerId: userId }
 * 4. ✅ Same API as multi-tenant
 * 5. ✅ Perfect for: SaaS, simple subscription apps, B2C platforms
 */

if (import.meta.url === `file://${process.argv[1]}`) {
  example().catch(console.error);
}

export default example;

