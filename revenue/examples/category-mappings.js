/**
 * Category Mappings Example
 * @classytic/revenue
 *
 * Demonstrates how to use categoryMappings to support custom use cases
 * while maintaining strict monetization types (free, subscription, purchase)
 */

import { createRevenue, MONETIZATION_TYPES } from '@classytic/revenue';
import Transaction from './transaction.model.js';

/**
 * ARCHITECTURE OVERVIEW
 *
 * 1. Monetization Types (STRICT - Library enforced):
 *    - FREE: No payment required
 *    - SUBSCRIPTION: Recurring payments
 *    - PURCHASE: One-time payments
 *
 * 2. Transaction Categories (FLEXIBLE - User defined):
 *    - Custom names for your business logic
 *    - Examples: 'order_subscription', 'platform_subscription', 'gym_membership', 'course_enrollment'
 *
 * 3. Entity Identifiers:
 *    - Logical identifiers you choose (Order, PlatformSubscription, Membership, etc.)
 *    - NOT database model names - just logical identifiers for organization
 *    - Maps to transaction categories via categoryMappings config
 */

// ========================================
// EXAMPLE 1: E-commerce Platform
// ========================================

console.log('\n=== Example 1: E-commerce Platform ===\n');

const ecommerceRevenue = createRevenue({
  models: { Transaction },
  config: {
    categoryMappings: {
      Order: 'order_subscription',        // Recurring orders → 'order_subscription'
      Purchase: 'order_purchase',          // One-time orders → 'order_purchase'
    },
  },
});

// Recurring meal kit subscription
async function createMealKitSubscription() {
  const { subscription, transaction } = await ecommerceRevenue.subscriptions.create({
    data: {
      organizationId: 'org_123',
      customerId: 'cust_456',
    },
    entity: 'Order',                                // Logical identifier (NOT a DB model name)
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,  // Which type? (strict)
    planKey: 'monthly',
    amount: 49.99,
    currency: 'USD',
    gateway: 'manual',
    metadata: {
      productType: 'meal_kit',
      deliveryFrequency: 'weekly',
    },
  });

  console.log('Meal Kit Subscription Created:');
  console.log(`- Subscription ID: ${subscription._id}`);
  console.log(`- Transaction ID: ${transaction._id}`);
  console.log(`- Category: ${transaction.category}`);  // 'order_subscription'
  console.log(`- Monetization Type: ${transaction.metadata.monetizationType}`);  // 'subscription'
  console.log('');

  return { subscription, transaction };
}

// One-time electronics purchase
async function createElectronicsPurchase() {
  const { transaction } = await ecommerceRevenue.subscriptions.create({
    data: {
      organizationId: 'org_123',
      customerId: 'cust_789',
    },
    entity: 'Purchase',                             // Logical identifier
    monetizationType: MONETIZATION_TYPES.PURCHASE,   // Which type? (strict)
    amount: 299.99,
    currency: 'USD',
    gateway: 'manual',
    metadata: {
      productType: 'electronics',
      productId: 'laptop_001',
    },
  });

  console.log('Electronics Purchase Created:');
  console.log(`- Transaction ID: ${transaction._id}`);
  console.log(`- Category: ${transaction.category}`);  // 'order_purchase'
  console.log(`- Monetization Type: ${transaction.metadata.monetizationType}`);  // 'purchase'
  console.log('');

  return { transaction };
}

// ========================================
// EXAMPLE 2: Gym Management System
// ========================================

console.log('\n=== Example 2: Gym Management System ===\n');

const gymRevenue = createRevenue({
  models: { Transaction },
  config: {
    categoryMappings: {
      Membership: 'gym_membership',
      PersonalTraining: 'personal_training',
      DayPass: 'day_pass',
      Equipment: 'equipment_purchase',
    },
  },
});

// Monthly gym membership
async function createGymMembership() {
  const { subscription, transaction } = await gymRevenue.subscriptions.create({
    data: {
      organizationId: 'gym_001',
      customerId: 'member_123',
    },
    entity: 'Membership',
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,
    planKey: 'monthly',
    amount: 59.99,
    currency: 'USD',
    metadata: {
      membershipType: 'premium',
      accessLevel: 'full',
    },
  });

  console.log('Gym Membership Created:');
  console.log(`- Category: ${transaction.category}`);  // 'gym_membership'
  console.log('');

  return { subscription, transaction };
}

// Personal training package (one-time)
async function createPersonalTrainingPackage() {
  const { transaction } = await gymRevenue.subscriptions.create({
    data: {
      organizationId: 'gym_001',
      customerId: 'member_456',
    },
    entity: 'PersonalTraining',
    monetizationType: MONETIZATION_TYPES.PURCHASE,
    amount: 299.99,
    currency: 'USD',
    metadata: {
      sessions: 10,
      trainer: 'trainer_789',
    },
  });

  console.log('Personal Training Package Created:');
  console.log(`- Category: ${transaction.category}`);  // 'personal_training'
  console.log('');

  return { transaction };
}

// Free trial day pass
async function createFreeDayPass() {
  const { subscription } = await gymRevenue.subscriptions.create({
    data: {
      organizationId: 'gym_001',
      customerId: 'guest_999',
    },
    entity: 'DayPass',
    monetizationType: MONETIZATION_TYPES.FREE,
    amount: 0,
    metadata: {
      validDate: new Date(),
      accessLevel: 'basic',
    },
  });

  console.log('Free Day Pass Created:');
  console.log(`- No transaction created (free)`);
  console.log(`- Subscription status: ${subscription.status}`);  // 'active'
  console.log('');

  return { subscription };
}

// ========================================
// EXAMPLE 3: Online Learning Platform
// ========================================

console.log('\n=== Example 3: Online Learning Platform ===\n');

const learningRevenue = createRevenue({
  models: { Transaction },
  config: {
    categoryMappings: {
      CourseEnrollment: 'course_enrollment',
      MembershipPlan: 'membership_plan',
      Certification: 'certification_exam',
    },
  },
});

// One-time course purchase
async function createCoursePurchase() {
  const { transaction } = await learningRevenue.subscriptions.create({
    data: {
      organizationId: 'platform_001',
      customerId: 'student_123',
    },
    entity: 'CourseEnrollment',
    monetizationType: MONETIZATION_TYPES.PURCHASE,
    amount: 99.00,
    currency: 'USD',
    metadata: {
      courseId: 'react-advanced',
      courseName: 'Advanced React Patterns',
      instructor: 'instructor_456',
    },
  });

  console.log('Course Enrollment Created:');
  console.log(`- Category: ${transaction.category}`);  // 'course_enrollment'
  console.log('');

  return { transaction };
}

// Monthly all-access membership
async function createAllAccessMembership() {
  const { subscription, transaction } = await learningRevenue.subscriptions.create({
    data: {
      organizationId: 'platform_001',
      customerId: 'student_789',
    },
    entity: 'MembershipPlan',
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,
    planKey: 'monthly',
    amount: 29.99,
    currency: 'USD',
    metadata: {
      accessLevel: 'all_courses',
      downloadAllowed: true,
    },
  });

  console.log('All-Access Membership Created:');
  console.log(`- Category: ${transaction.category}`);  // 'membership_plan'
  console.log('');

  return { subscription, transaction };
}

// ========================================
// EXAMPLE 4: Without Category Mappings (Defaults)
// ========================================

console.log('\n=== Example 4: Using Library Defaults ===\n');

const defaultRevenue = createRevenue({
  models: { Transaction },
  config: {
    categoryMappings: {},  // Empty - use defaults
  },
});

// Subscription without custom category
async function createDefaultSubscription() {
  const { subscription, transaction } = await defaultRevenue.subscriptions.create({
    data: {
      organizationId: 'org_default',
      customerId: 'cust_default',
    },
    // No referenceModel specified
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,
    planKey: 'monthly',
    amount: 49.99,
    currency: 'USD',
  });

  console.log('Default Subscription Created:');
  console.log(`- Category: ${transaction.category}`);  // 'subscription' (library default)
  console.log('');

  return { subscription, transaction };
}

// Purchase without custom category
async function createDefaultPurchase() {
  const { transaction } = await defaultRevenue.subscriptions.create({
    data: {
      organizationId: 'org_default',
      customerId: 'cust_default',
    },
    // No referenceModel specified
    monetizationType: MONETIZATION_TYPES.PURCHASE,
    amount: 99.99,
    currency: 'USD',
  });

  console.log('Default Purchase Created:');
  console.log(`- Category: ${transaction.category}`);  // 'purchase' (library default)
  console.log('');

  return { transaction };
}

// ========================================
// EXAMPLE 5: Renewal with Category Preservation
// ========================================

console.log('\n=== Example 5: Renewal Preserves Category ===\n');

async function demonstrateRenewal() {
  // Create initial subscription with custom category
  const { subscription: gymSub } = await gymRevenue.subscriptions.create({
    data: {
      organizationId: 'gym_001',
      customerId: 'member_renewal',
    },
    entity: 'Membership',
    monetizationType: MONETIZATION_TYPES.SUBSCRIPTION,
    planKey: 'monthly',
    amount: 59.99,
    currency: 'USD',
  });

  console.log(`Initial subscription created with metadata:`, gymSub.metadata);

  // Renew subscription - category is preserved from original
  const { transaction: renewalTxn } = await gymRevenue.subscriptions.renew(
    gymSub._id.toString(),
    {
      gateway: 'manual',
      metadata: {
        isAutoRenewal: true,
      },
    }
  );

  console.log('Renewal Transaction Created:');
  console.log(`- Category: ${renewalTxn.category}`);  // 'gym_membership' (preserved)
  console.log(`- Metadata:`, renewalTxn.metadata);
  console.log('');

  return { renewalTxn };
}

// ========================================
// RUN EXAMPLES
// ========================================

async function runExamples() {
  try {
    // E-commerce examples
    await createMealKitSubscription();
    await createElectronicsPurchase();

    // Gym examples
    await createGymMembership();
    await createPersonalTrainingPackage();
    await createFreeDayPass();

    // Learning platform examples
    await createCoursePurchase();
    await createAllAccessMembership();

    // Default examples
    await createDefaultSubscription();
    await createDefaultPurchase();

    // Renewal example
    await demonstrateRenewal();

    console.log('\n✅ All examples completed successfully!\n');
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Uncomment to run:
// runExamples();

export {
  createMealKitSubscription,
  createElectronicsPurchase,
  createGymMembership,
  createPersonalTrainingPackage,
  createFreeDayPass,
  createCoursePurchase,
  createAllAccessMembership,
  createDefaultSubscription,
  createDefaultPurchase,
  demonstrateRenewal,
};
