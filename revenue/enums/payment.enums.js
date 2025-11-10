/**
 * Payment Enums
 * @classytic/revenue
 *
 * Library-managed payment enums only.
 * Users define their own payment methods in their schema.
 */

// ============ PAYMENT STATUS ============
/**
 * Payment Status - Library-managed states
 */
export const PAYMENT_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
};

export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS);

// ============ PAYMENT GATEWAY TYPES ============
/**
 * Gateway types that providers can be built for
 *
 * MANUAL: Built-in manual provider
 * STRIPE: Stripe provider (build with @classytic/revenue-stripe)
 * SSLCOMMERZ: SSLCommerz provider (build with @classytic/revenue-sslcommerz)
 *
 * Users can register custom providers for any gateway type
 */
export const PAYMENT_GATEWAY_TYPE = {
  MANUAL: 'manual',
  STRIPE: 'stripe',
  SSLCOMMERZ: 'sslcommerz',
};

export const PAYMENT_GATEWAY_TYPE_VALUES = Object.values(PAYMENT_GATEWAY_TYPE);

// Backward compatibility alias
export const GATEWAY_TYPES = PAYMENT_GATEWAY_TYPE;
export const GATEWAY_TYPE_VALUES = PAYMENT_GATEWAY_TYPE_VALUES;
