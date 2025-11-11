/**
 * @classytic/revenue - Centralized Enums
 * All enums for the revenue management system
 *
 * This file serves as the single source of truth for all enum values
 * used across monetization and payment subsystems.
 *
 * @module @classytic/revenue/enums
 */

// Re-export all enums
export * from './transaction.enums.js';
export * from './payment.enums.js';
export * from './subscription.enums.js';
export * from './monetization.enums.js';

// Default export for convenience
import {
  TRANSACTION_TYPE,
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS,
  TRANSACTION_STATUS_VALUES,
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_VALUES,
} from './transaction.enums.js';

import {
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_GATEWAY_TYPE,
  PAYMENT_GATEWAY_TYPE_VALUES,
  GATEWAY_TYPES,
  GATEWAY_TYPE_VALUES,
} from './payment.enums.js';

import {
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,
  PLAN_KEYS,
  PLAN_KEY_VALUES,
} from './subscription.enums.js';

import {
  MONETIZATION_TYPES,
  MONETIZATION_TYPE_VALUES,
} from './monetization.enums.js';

export default {
  // Transaction enums
  TRANSACTION_TYPE,
  TRANSACTION_TYPE_VALUES,
  TRANSACTION_STATUS,
  TRANSACTION_STATUS_VALUES,
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_VALUES,

  // Payment enums
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_GATEWAY_TYPE,
  PAYMENT_GATEWAY_TYPE_VALUES,
  GATEWAY_TYPES,
  GATEWAY_TYPE_VALUES,

  // Subscription enums
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_VALUES,
  PLAN_KEYS,
  PLAN_KEY_VALUES,

  // Monetization enums
  MONETIZATION_TYPES,
  MONETIZATION_TYPE_VALUES,
};
