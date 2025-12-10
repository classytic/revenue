/**
 * Quick Start Example
 * @classytic/revenue
 *
 * ONE Transaction model = Universal Financial Ledger
 * Handles subscriptions, purchases, refunds, and expenses
 */

import mongoose from 'mongoose';
import {
  Revenue,
  Money,
  // Enums
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS_VALUES,
  // Mongoose schemas (compose into your model)
  gatewaySchema,
  commissionSchema,
  paymentDetailsSchema,
} from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

// ============ TRANSACTION MODEL ============
// This is the ONLY required model!

const CATEGORIES = [
  'platform_subscription',
  'course_enrollment',
  'product_order',
  'refund',
] as const;

const TransactionSchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, index: true },
  type: { type: String, enum: TRANSACTION_TYPE_VALUES, required: true },
  category: { type: String, enum: CATEGORIES },
  status: { type: String, enum: TRANSACTION_STATUS_VALUES, default: 'pending' },
  amount: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'USD' },
  method: { type: String, default: 'manual' },

  // Library schemas
  gateway: gatewaySchema,
  commission: commissionSchema,
  paymentDetails: paymentDetailsSchema,

  // Polymorphic reference
  referenceId: { type: mongoose.Schema.Types.ObjectId, refPath: 'referenceModel' },
  referenceModel: { type: String, enum: ['Subscription', 'Order', 'Enrollment'] },

  // Verification
  verifiedAt: Date,
  verifiedBy: mongoose.Schema.Types.Mixed,
  refundedAmount: Number,
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', TransactionSchema);

// ============ BUILD REVENUE ============

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction: Transaction as any })
  .withProvider('manual', new ManualProvider())
  .withCommission(10, 2.9)  // 10% platform, 2.9% gateway
  .withCategoryMappings({
    PlatformSubscription: 'platform_subscription',
    CourseEnrollment: 'course_enrollment',
    ProductOrder: 'product_order',
  })
  .withDebug(true)
  .build();

// ============ USAGE ============

async function main() {
  await mongoose.connect('mongodb://localhost:27017/revenue_example');

  try {
    const orgId = new mongoose.Types.ObjectId();
    const customerId = new mongoose.Types.ObjectId();
    const subscriptionId = new mongoose.Types.ObjectId();

    // 1. Create subscription payment
    console.log('\n📋 Creating subscription payment...');
    const { transaction } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: subscriptionId,
        referenceModel: 'Subscription',
      },
      planKey: 'monthly',
      monetizationType: 'subscription',
      entity: 'PlatformSubscription',  // Maps to 'platform_subscription' category
      amount: 2999, // $29.99
      gateway: 'manual',
      paymentData: { method: 'bkash' },
      metadata: {
        paymentInstructions: 'bKash: 01712345678',
      },
    });

    console.log('Transaction ID:', transaction?._id);
    console.log('Category:', transaction?.category);  // 'platform_subscription'
    console.log('Type:', transaction?.type);          // 'income'
    console.log('Status:', transaction?.status);      // 'pending'

    // 2. Verify payment
    console.log('\n✅ Verifying payment...');
    await revenue.payments.verify(transaction!._id.toString());

    // 3. Create one-time purchase
    console.log('\n🛒 Creating product order...');
    const orderId = new mongoose.Types.ObjectId();
    const { transaction: orderTx } = await revenue.monetization.create({
      data: {
        organizationId: orgId,
        customerId,
        referenceId: orderId,
        referenceModel: 'Order',
      },
      planKey: 'one_time',
      monetizationType: 'purchase',
      entity: 'ProductOrder',  // Maps to 'product_order' category
      amount: 1500, // $15.00
      gateway: 'manual',
    });

    console.log('Order Transaction:', orderTx?._id);
    console.log('Category:', orderTx?.category);  // 'product_order'

    // 4. Query by category
    console.log('\n📊 Querying transactions...');
    const subscriptions = await Transaction.find({
      category: 'platform_subscription',
    });
    console.log('Subscription payments:', subscriptions.length);

    const orders = await Transaction.find({
      category: 'product_order',
    });
    console.log('Order payments:', orders.length);

    // 5. Query by reference
    const subPayments = await Transaction.find({
      referenceModel: 'Subscription',
      referenceId: subscriptionId,
    });
    console.log('Payments for subscription:', subPayments.length);

    // 6. Money utility
    console.log('\n💰 Money calculations:');
    const price = Money.usd(2999);
    console.log('Price:', price.format());                    // $29.99
    console.log('10% off:', price.multiply(0.9).format());   // $26.99
    console.log('Split 3:', price.split(3).map(m => m.format())); // ["$10.00", "$9.99", "$10.00"]

    // 7. Events
    revenue.on('payment.succeeded', (event) => {
      console.log('\n🎉 Event: Payment succeeded:', event.transactionId);
    });

  } finally {
    await mongoose.disconnect();
  }
}

main().catch(console.error);
