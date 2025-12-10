/**
 * Monetization Enums
 * @classytic/revenue
 *
 * General monetization enums and constants
 */

// ============ MONETIZATION TYPES ============
export const MONETIZATION_TYPES = {
  FREE: 'free',
  PURCHASE: 'purchase',
  SUBSCRIPTION: 'subscription',
} as const;

export type MonetizationTypes = typeof MONETIZATION_TYPES;
export type MonetizationTypeValue = MonetizationTypes[keyof MonetizationTypes];
export const MONETIZATION_TYPE_VALUES = Object.values(MONETIZATION_TYPES);

