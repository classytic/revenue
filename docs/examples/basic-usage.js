/**
 * Basic Usage Example
 * @classytic/revenue
 *
 * Simple example showing how to use the revenue system
 */

import { createRevenue } from '@classytic/revenue';
import mongoose from 'mongoose';

// 1. Define your Transaction model
const transactionSchema = new mongoose.Schema({
  amount: Number,
  status: String,
  paymentMethod: String,
  paymentIntentId: String,
  // Add other fields as needed
});

const Transaction = mongoose.model('Transaction', transactionSchema);

// 2. Create revenue instance
const revenue = createRevenue({
  models: {
    Transaction,
  },
  hooks: {
    'payment.verified': async ({ transaction }) => {
      console.log('✅ Payment verified:', transaction._id);
    },
  },
});

// 3. Use it!
async function example() {
  await mongoose.connect('mongodb://localhost:27017/test');

  // Create subscription
  const { subscription, transaction } = await revenue.subscriptions.create({
    data: { organizationId: '123', customerId: '456' },
    planKey: 'monthly',
    amount: 99.99,
    gateway: 'manual',
  });

  console.log('Subscription created:', subscription._id);
  console.log('Transaction created:', transaction._id);

  // Verify payment
  await revenue.payments.verify(transaction.paymentIntentId, {
    verifiedBy: 'admin_id',
  });

  await mongoose.disconnect();
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  example().catch(console.error);
}

export default example;
