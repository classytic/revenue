/**
 * Events & Plugins Example
 * @classytic/revenue
 *
 * Type-safe events and composable plugins
 */

import mongoose from 'mongoose';
import {
  Revenue,
  loggingPlugin,
  auditPlugin,
  metricsPlugin,
  definePlugin,
  type RevenueEvents,
} from '@classytic/revenue';
import { ManualProvider } from '@classytic/revenue-manual';

// ============ SIMPLE MODEL ============

const TransactionSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  currency: { type: String, default: 'USD' },
  type: { type: String, default: 'income' },
  status: { type: String, default: 'pending' },
  method: String,
  gateway: mongoose.Schema.Types.Mixed,
  verifiedAt: Date,
  metadata: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', TransactionSchema);

// ============ CUSTOM PLUGINS ============

// Notification plugin
const notificationPlugin = definePlugin({
  name: 'notifications',
  version: '1.0.0',
  description: 'Send notifications on payment events',
  events: {
    'payment.succeeded': async (event) => {
      console.log(`📧 [Notification] Payment succeeded: ${event.transactionId}`);
      // await sendEmail(event.transaction.customerId, 'Payment received!');
    },
    'payment.failed': async (event) => {
      console.log(`📧 [Notification] Payment failed: ${event.transactionId}`);
      // await sendEmail(event.transaction.customerId, 'Payment failed');
    },
    'subscription.renewed': async (event) => {
      console.log(`📧 [Notification] Subscription renewed: ${event.subscriptionId}`);
    },
  },
});

// Rate limiting plugin
const rateLimitPlugin = definePlugin({
  name: 'rate-limit',
  hooks: {
    'payment.create.before': async (ctx, input, next) => {
      const requestsPerMinute = 10;
      const key = `rate_limit:${(input as any).customerId}`;
      
      // In production, use Redis
      const count = ctx.storage.get(key) as number ?? 0;
      if (count >= requestsPerMinute) {
        throw new Error('Rate limit exceeded. Try again later.');
      }
      ctx.storage.set(key, count + 1);
      
      ctx.logger.debug('Rate limit check passed', { count: count + 1 });
      return next();
    },
  },
});

// Analytics plugin
const analyticsPlugin = definePlugin({
  name: 'analytics',
  events: {
    '*': async (event) => {
      console.log(`📊 [Analytics] Event: ${event.type}`, {
        timestamp: event.timestamp,
      });
      // await analytics.track(event.type, event);
    },
  },
});

// ============ AUDIT STORE ============

const auditLog: Array<{ action: string; timestamp: Date; data: unknown }> = [];

async function saveAuditEntry(entry: unknown) {
  auditLog.push({
    action: (entry as any).action,
    timestamp: (entry as any).timestamp,
    data: entry,
  });
  console.log(`📝 [Audit] ${(entry as any).action}`, entry);
}

// ============ BUILD REVENUE WITH PLUGINS ============

const revenue = Revenue
  .create({ defaultCurrency: 'USD' })
  .withModels({ Transaction: Transaction as any })
  .withProvider('manual', new ManualProvider())
  .withPlugin(loggingPlugin({ level: 'info' }))
  .withPlugin(auditPlugin({ store: saveAuditEntry }))
  .withPlugin(metricsPlugin({
    onMetric: (metric) => {
      console.log(`📈 [Metrics] ${metric.name}:`, {
        duration: metric.duration,
        success: metric.success,
      });
    },
  }))
  .withPlugin(notificationPlugin)
  .withPlugin(analyticsPlugin)
  // .withPlugin(rateLimitPlugin) // Uncomment to enable
  .withDebug(true)
  .build();

// ============ EVENT SUBSCRIPTIONS ============

async function main() {
  await mongoose.connect('mongodb://localhost:27017/revenue_example');

  try {
    // Subscribe to specific events
    console.log('\n🎯 Setting up event listeners...\n');

    revenue.on('payment.succeeded', (event) => {
      console.log('✅ Payment succeeded:', event.transactionId);
      // event is fully typed!
    });

    revenue.on('payment.failed', (event) => {
      console.log('❌ Payment failed:', event.transactionId, event.error.message);
    });

    revenue.on('payment.refunded', (event) => {
      console.log('💸 Payment refunded:', event.transactionId, event.amount);
    });

    revenue.on('subscription.created', (event) => {
      console.log('📋 Subscription created:', event.subscriptionId);
    });

    revenue.on('escrow.held', (event) => {
      console.log('🔒 Escrow held:', event.transactionId, event.amount);
    });

    revenue.on('escrow.released', (event) => {
      console.log('🔓 Escrow released:', event.transactionId, event.releasedAmount);
    });

    // Wildcard listener (catches all events)
    const unsubscribe = revenue.on('*', (event) => {
      console.log(`[*] Event: ${event.type}`);
    });

    // One-time listener
    revenue.once('payment.succeeded', () => {
      console.log('🎉 First payment received!');
    });

    // ============ TRIGGER EVENTS ============

    console.log('\n🚀 Creating transaction...\n');

    const { transaction } = await revenue.monetization.create({
      data: { customerId: new mongoose.Types.ObjectId() },
      planKey: 'test',
      monetizationType: 'purchase',
      amount: 999,
      gateway: 'manual',
    });

    console.log('\n✅ Verifying payment...\n');
    await revenue.payments.verify(transaction!._id.toString());

    // Unsubscribe from wildcard
    unsubscribe();

    // ============ VIEW AUDIT LOG ============

    console.log('\n📜 Audit Log:');
    auditLog.forEach((entry, i) => {
      console.log(`  ${i + 1}. ${entry.action} at ${entry.timestamp.toISOString()}`);
    });

  } finally {
    await mongoose.disconnect();
  }
}

main().catch(console.error);

