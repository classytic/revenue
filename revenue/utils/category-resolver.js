/**
 * Category Resolver Utility
 * @classytic/revenue
 *
 * Resolves transaction category based on referenceModel and categoryMappings
 */

import { LIBRARY_CATEGORIES } from '../enums/transaction.enums.js';

/**
 * Resolve category for a transaction based on entity and monetizationType
 *
 * Resolution Logic:
 * 1. If categoryMappings[entity] exists → use it
 * 2. Otherwise → fall back to default library category
 *
 * @param {String} entity - The logical entity/identifier (e.g., 'Order', 'PlatformSubscription', 'Membership')
 *                          NOTE: This is NOT a database model name - it's just a logical identifier
 * @param {String} monetizationType - The monetization type ('subscription', 'purchase', 'free')
 * @param {Object} categoryMappings - User-defined category mappings from config
 * @returns {String} Category name for the transaction
 *
 * @example
 * // With mapping defined
 * resolveCategory('Order', 'subscription', { Order: 'order_subscription' })
 * // Returns: 'order_subscription'
 *
 * @example
 * // Without mapping, falls back to library default
 * resolveCategory('Order', 'subscription', {})
 * // Returns: 'subscription'
 *
 * @example
 * // Different entities with different mappings
 * const mappings = {
 *   Order: 'order_subscription',
 *   PlatformSubscription: 'platform_subscription',
 *   TenantUpgrade: 'tenant_upgrade',
 *   Membership: 'gym_membership',
 *   Enrollment: 'course_enrollment',
 * };
 * resolveCategory('PlatformSubscription', 'subscription', mappings)
 * // Returns: 'platform_subscription'
 */
export function resolveCategory(entity, monetizationType, categoryMappings = {}) {
  // If user has defined a custom mapping for this entity, use it
  if (entity && categoryMappings[entity]) {
    return categoryMappings[entity];
  }

  // Otherwise, fall back to library default based on monetization type
  switch (monetizationType) {
    case 'subscription':
      return LIBRARY_CATEGORIES.SUBSCRIPTION; // 'subscription'
    case 'purchase':
      return LIBRARY_CATEGORIES.PURCHASE; // 'purchase'
    default:
      return LIBRARY_CATEGORIES.SUBSCRIPTION; // Default to subscription
  }
}

/**
 * Validate that a category is defined in user's Transaction model enum
 * This is informational - actual validation happens at Mongoose schema level
 *
 * @param {String} category - Category to validate
 * @param {Array<String>} allowedCategories - List of allowed categories
 * @returns {Boolean} Whether category is valid
 */
export function isCategoryValid(category, allowedCategories = []) {
  return allowedCategories.includes(category);
}

export default resolveCategory;
