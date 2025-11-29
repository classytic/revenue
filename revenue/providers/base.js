/**
 * Payment Provider Base Class
 * @classytic/revenue
 *
 * Abstract base class for all payment providers
 * Inspired by: Vercel AI SDK, Stripe SDK
 */

/**
 * Payment Intent - standardized response from createIntent
 */
export class PaymentIntent {
  constructor(data) {
    this.id = data.id;
    this.sessionId = data.sessionId || null;
    this.paymentIntentId = data.paymentIntentId || null;
    this.provider = data.provider;
    this.status = data.status;
    this.amount = data.amount;
    this.currency = data.currency || 'BDT';
    this.metadata = data.metadata || {};
    this.clientSecret = data.clientSecret;
    this.paymentUrl = data.paymentUrl;
    this.instructions = data.instructions;
    this.raw = data.raw;
  }
}

/**
 * Payment Result - standardized response from verifyPayment
 */
export class PaymentResult {
  constructor(data) {
    this.id = data.id;
    this.provider = data.provider;
    this.status = data.status; // 'succeeded', 'failed', 'processing'
    this.amount = data.amount;
    this.currency = data.currency || 'BDT';
    this.paidAt = data.paidAt;
    this.metadata = data.metadata || {};
    this.raw = data.raw;
  }
}

/**
 * Refund Result - standardized response from refund
 */
export class RefundResult {
  constructor(data) {
    this.id = data.id;
    this.provider = data.provider;
    this.status = data.status; // 'succeeded', 'failed', 'processing'
    this.amount = data.amount;
    this.currency = data.currency || 'BDT';
    this.refundedAt = data.refundedAt;
    this.reason = data.reason;
    this.metadata = data.metadata || {};
    this.raw = data.raw;
  }
}

/**
 * Webhook Event - standardized webhook event
 */
export class WebhookEvent {
  constructor(data) {
    this.id = data.id;
    this.provider = data.provider;
    this.type = data.type; // 'payment.succeeded', 'payment.failed', 'refund.succeeded', etc.
    this.data = data.data;
    this.createdAt = data.createdAt;
    this.raw = data.raw;
  }
}

/**
 * Base Payment Provider
 * All payment providers must extend this class
 */
export class PaymentProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base'; // Override in subclass
  }

  /**
   * Create a payment intent
   * @param {Object} params - Payment parameters
   * @param {number} params.amount - Amount in smallest currency unit
   * @param {string} params.currency - Currency code
   * @param {Object} params.metadata - Additional metadata
   * @returns {Promise<PaymentIntent>}
   */
  async createIntent(params) {
    throw new Error(`${this.constructor.name}: createIntent() must be implemented`);
  }

  /**
   * Verify a payment
   * @param {string} intentId - Payment intent ID
   * @returns {Promise<PaymentResult>}
   */
  async verifyPayment(intentId) {
    throw new Error(`${this.constructor.name}: verifyPayment() must be implemented`);
  }

  /**
   * Get payment status
   * @param {string} intentId - Payment intent ID
   * @returns {Promise<PaymentResult>}
   */
  async getStatus(intentId) {
    throw new Error(`${this.constructor.name}: getStatus() must be implemented`);
  }

  /**
   * Refund a payment
   * @param {string} paymentId - Payment ID
   * @param {number} amount - Amount to refund (optional, full refund if not provided)
   * @param {Object} options - Refund options
   * @returns {Promise<RefundResult>}
   */
  async refund(paymentId, amount, options = {}) {
    throw new Error(`${this.constructor.name}: refund() must be implemented`);
  }

  /**
   * Handle webhook from provider
   * @param {Object} payload - Webhook payload
   * @param {Object} headers - Request headers (for signature verification)
   * @returns {Promise<WebhookEvent>}
   */
  async handleWebhook(payload, headers = {}) {
    throw new Error(`${this.constructor.name}: handleWebhook() must be implemented`);
  }

  /**
   * Verify webhook signature (optional)
   * @param {Object} payload - Webhook payload
   * @param {string} signature - Webhook signature
   * @returns {boolean}
   */
  verifyWebhookSignature(payload, signature) {
    // Override in subclass if provider supports webhook signatures
    return true;
  }

  /**
   * Get provider capabilities
   * @returns {Object}
   */
  getCapabilities() {
    return {
      supportsWebhooks: false,
      supportsRefunds: false,
      supportsPartialRefunds: false,
      requiresManualVerification: true,
    };
  }
}

export default PaymentProvider;
