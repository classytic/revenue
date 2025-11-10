/**
 * Multivendor Platform Example
 * @classytic/revenue
 *
 * Shows how to use the revenue library in a multivendor platform
 * with multiple types of subscriptions and transactions
 */

import { createRevenue, MONETIZATION_TYPES } from '@classytic/revenue';
import Transaction from './transaction.model.js';

/**
 * MULTIVENDOR PLATFORM ARCHITECTURE
 *
 * In a multivendor platform, you typically have multiple transaction types:
 *
 * 1. Platform-level:
 *    - Tenant/organization subscriptions (platform_subscription)
 *    - Tenant upgrades (tenant_upgrade)
 *    - Platform fees (platform_fee)
 *
 * 2. Customer-level (within each tenant):
 *    - Customer orders (order_subscription, order_purchase)
 *    - Customer memberships (customer_membership)
 *    - One-time purchases (customer_purchase)
 *
 * 3. Vendor-level:
 *    - Vendor commissions (vendor_commission)
 *    - Vendor payouts (vendor_payout)
 */

// Setup revenue with all entity mappings
const revenue = createRevenue({
  models: { Transaction },
  config: {
    categoryMappings: {
      // Platform-level entities
      PlatformSubscription: 'platform_subscription',
      TenantUpgrade: 'tenant_upgrade',
      PlatformFee: 'platform_fee',

      // Customer-level entities
      Order: 'order_subscription',
      OrderPurchase: 'order_purchase',
      CustomerMembership: 'customer_membership',

      // Vendor-level entities
      VendorCommission: 'vendor_commission',
      VendorPayout: 'vendor_payout',
    },
  },
});

// ========================================
// PLATFORM-LEVEL TRANSACTIONS
// ========================================

/**
 * Create a platform subscription for a tenant/organization
 * This is what the tenant pays to use your platform
 */
async function createPlatformSubscription() {
  const { subscription, transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: 'tenant_123',  // The tenant's ID
      customerId: null,               // No customer - this is org-level
    },
    entity: 'PlatformSubscription',   // Logical identifier → 'platform_subscription'
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,
    planKey: 'monthly',
    amount: 99.99,
    currency: 'USD',
    gateway: 'stripe',
    metadata: {
      tenantName: 'Acme Corp',
      plan: 'professional',
      seats: 10,
    },
  });

  console.log('Platform Subscription Created:');
  console.log(`- Category: ${transaction.category}`);  // 'platform_subscription'
  console.log(`- Amount: $${transaction.amount}`);
  console.log('');

  return { subscription, transaction };
}

/**
 * Upgrade tenant to a higher plan
 */
async function upgradeTenantPlan() {
  const { transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: 'tenant_123',
    },
    entity: 'TenantUpgrade',          // Logical identifier → 'tenant_upgrade'
    monetizationType: MONETIZATION_TYPES.PURCHASE,  // One-time upgrade fee
    amount: 199.99,
    currency: 'USD',
    metadata: {
      fromPlan: 'professional',
      toPlan: 'enterprise',
      upgradeType: 'immediate',
    },
  });

  console.log('Tenant Upgrade Created:');
  console.log(`- Category: ${transaction.category}`);  // 'tenant_upgrade'
  console.log('');

  return { transaction };
}

// ========================================
// CUSTOMER-LEVEL TRANSACTIONS (Within Tenant)
// ========================================

/**
 * Create a subscription order for a customer
 * This is a customer subscribing to recurring orders within a tenant
 */
async function createCustomerSubscriptionOrder() {
  const { subscription, transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: 'tenant_123',   // Which tenant
      customerId: 'customer_456',      // Which customer
    },
    entity: 'Order',                   // Logical identifier → 'order_subscription'
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,
    planKey: 'monthly',
    amount: 49.99,
    currency: 'USD',
    metadata: {
      orderType: 'meal_kit',
      deliveryFrequency: 'weekly',
      vendorId: 'vendor_789',
    },
  });

  console.log('Customer Subscription Order Created:');
  console.log(`- Category: ${transaction.category}`);  // 'order_subscription'
  console.log(`- Tenant: ${transaction.organizationId}`);
  console.log(`- Customer: ${transaction.customerId}`);
  console.log('');

  return { subscription, transaction };
}

/**
 * Create a one-time purchase for a customer
 */
async function createCustomerPurchase() {
  const { transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: 'tenant_123',
      customerId: 'customer_789',
    },
    entity: 'OrderPurchase',           // Logical identifier → 'order_purchase'
    monetizationType: MONETIZATION_TYPES.PURCHASE,
    amount: 29.99,
    currency: 'USD',
    metadata: {
      productId: 'prod_123',
      vendorId: 'vendor_789',
      orderNumber: 'ORD-2024-001',
    },
  });

  console.log('Customer Purchase Created:');
  console.log(`- Category: ${transaction.category}`);  // 'order_purchase'
  console.log('');

  return { transaction };
}

/**
 * Create a customer membership within a tenant
 * Example: Gym membership, club membership, etc.
 */
async function createCustomerMembership() {
  const { subscription, transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: 'tenant_gym_001',
      customerId: 'customer_999',
    },
    entity: 'CustomerMembership',      // Logical identifier → 'customer_membership'
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,
    planKey: 'monthly',
    amount: 59.99,
    currency: 'USD',
    metadata: {
      membershipType: 'premium',
      facilityAccess: 'all_locations',
    },
  });

  console.log('Customer Membership Created:');
  console.log(`- Category: ${transaction.category}`);  // 'customer_membership'
  console.log('');

  return { subscription, transaction };
}

// ========================================
// VENDOR-LEVEL TRANSACTIONS
// ========================================

/**
 * Record vendor commission
 */
async function recordVendorCommission() {
  const { transaction } = await revenue.subscriptions.create({
    data: {
      organizationId: 'tenant_123',
      customerId: 'vendor_789',
    },
    entity: 'VendorCommission',        // Logical identifier → 'vendor_commission'
    monetizationType: MONETIZATION_TYPES.PURCHASE,
    amount: 5.00,  // Commission from sale
    currency: 'USD',
    metadata: {
      orderId: 'ord_123',
      commissionRate: 0.10,
      orderAmount: 50.00,
    },
  });

  console.log('Vendor Commission Recorded:');
  console.log(`- Category: ${transaction.category}`);  // 'vendor_commission'
  console.log('');

  return { transaction };
}

// ========================================
// EXAMPLE WORKFLOW: Complete Platform Flow
// ========================================

async function demonstrateCompleteFlow() {
  console.log('=== Complete Multivendor Platform Flow ===\n');

  // 1. Tenant signs up and subscribes to platform
  console.log('Step 1: Tenant subscribes to platform');
  await createPlatformSubscription();

  // 2. Customer within tenant creates subscription order
  console.log('Step 2: Customer creates subscription order');
  await createCustomerSubscriptionOrder();

  // 3. Customer makes one-time purchase
  console.log('Step 3: Customer makes one-time purchase');
  await createCustomerPurchase();

  // 4. Record vendor commission
  console.log('Step 4: Record vendor commission');
  await recordVendorCommission();

  // 5. Tenant upgrades plan
  console.log('Step 5: Tenant upgrades plan');
  await upgradeTenantPlan();

  console.log('✅ Complete flow demonstrated!\n');
}

// ========================================
// QUERYING TRANSACTIONS BY CATEGORY
// ========================================

/**
 * Query examples showing how to filter by category
 */
async function queryExamples() {
  const TransactionModel = revenue.container.get('models').Transaction;

  // Get all platform subscriptions
  const platformSubs = await TransactionModel.find({
    category: 'platform_subscription',
  });

  // Get all customer orders for a tenant
  const tenantOrders = await TransactionModel.find({
    organizationId: 'tenant_123',
    category: { $in: ['order_subscription', 'order_purchase'] },
  });

  // Get all vendor commissions
  const vendorCommissions = await TransactionModel.find({
    category: 'vendor_commission',
  });

  console.log('Query Results:');
  console.log(`- Platform subscriptions: ${platformSubs.length}`);
  console.log(`- Tenant orders: ${tenantOrders.length}`);
  console.log(`- Vendor commissions: ${vendorCommissions.length}`);
}

// ========================================
// KEY TAKEAWAYS
// ========================================

/**
 * KEY POINTS:
 *
 * 1. Entity identifiers (PlatformSubscription, Order, etc.) are NOT database model names
 *    - They are logical identifiers YOU choose
 *    - They map to transaction categories via categoryMappings
 *
 * 2. Monetization types are STRICT:
 *    - FREE: No payment
 *    - SUBSCRIPTION: Recurring payments
 *    - PURCHASE: One-time payments
 *
 * 3. Transaction categories are FLEXIBLE:
 *    - Define as many as you need in your Transaction model enum
 *    - Use categoryMappings to map entities → categories
 *
 * 4. Use organizationId + customerId to organize:
 *    - organizationId: Which tenant
 *    - customerId: Which customer (or vendor, or null for org-level)
 *
 * 5. Use metadata for additional context:
 *    - Store vendor IDs, order IDs, plan details, etc.
 *    - Query and aggregate later as needed
 */

// Uncomment to run:
// demonstrateCompleteFlow();

export {
  createPlatformSubscription,
  upgradeTenantPlan,
  createCustomerSubscriptionOrder,
  createCustomerPurchase,
  createCustomerMembership,
  recordVendorCommission,
  demonstrateCompleteFlow,
  queryExamples,
};
