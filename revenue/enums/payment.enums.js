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
 * Common gateway type constants for convenience
 *
 * ⚠️ IMPORTANT: These are NOT restrictions - just common reference values
 *
 * You can register ANY custom gateway provider by passing it to createRevenue():
 *
 * @example
 * ```javascript
 * const revenue = createRevenue({
 *   providers: {
 *     manual: new ManualProvider(),
 *     bkash: new BkashProvider(),      // ✅ Custom gateway
 *     nagad: new NagadProvider(),      // ✅ Custom gateway
 *     stripe: new StripeProvider(),    // ✅ Custom gateway
 *     paypal: new PaypalProvider(),    // ✅ Any gateway you want
 *   }
 * });
 *
 * // Use by name
 * await revenue.subscriptions.create({ gateway: 'bkash', ... });
 * ```
 *
 * Reference values:
 * - MANUAL: Built-in manual provider (@classytic/revenue-manual)
 * - STRIPE: Stripe provider (build with @classytic/revenue-stripe)
 * - SSLCOMMERZ: SSLCommerz provider (build with @classytic/revenue-sslcommerz)
 *
 * Add your own: bkash, nagad, rocket, paypal, razorpay, flutterwave, etc.
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
