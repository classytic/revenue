/**
 * Manual Payment Provider
 * @classytic/revenue-manual
 *
 * Reference implementation for building payment providers
 * Perfect for: Cash, bank transfers, mobile money without API
 *
 * Use this as a template for building:
 * - @classytic/revenue-stripe
 * - @classytic/revenue-sslcommerz
 * - @classytic/revenue-bkash
 * - Your custom provider
 */

import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult } from '@classytic/revenue';
import { nanoid } from 'nanoid';

export class ManualProvider extends PaymentProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'manual';
  }

  /**
   * Create manual payment intent
   * Returns instructions for manual payment
   */
  async createIntent(params) {
    const intentId = `manual_${nanoid(16)}`;

    return new PaymentIntent({
      id: intentId,
      provider: 'manual',
      status: 'pending',
      amount: params.amount,
      currency: params.currency || 'BDT',
      metadata: params.metadata || {},
      instructions: this._getPaymentInstructions(params),
      raw: params,
    });
  }

  /**
   * Verify manual payment
   * Note: This is called by admin after checking payment proof
   */
  async verifyPayment(intentId) {
    // Manual verification doesn't auto-verify
    // Admin must explicitly call payment verification endpoint
    return new PaymentResult({
      id: intentId,
      provider: 'manual',
      status: 'requires_manual_approval',
      amount: 0, // Amount will be filled by transaction
      currency: 'BDT',
      metadata: {
        message: 'Manual payment requires admin verification',
      },
    });
  }

  /**
   * Get payment status
   */
  async getStatus(intentId) {
    return this.verifyPayment(intentId);
  }

  /**
   * Refund manual payment
   */
  async refund(paymentId, amount, options = {}) {
    const refundId = `refund_${nanoid(16)}`;

    return new RefundResult({
      id: refundId,
      provider: 'manual',
      status: 'succeeded', // Manual refunds are immediately marked as succeeded
      amount: amount,
      currency: options.currency || 'BDT',
      refundedAt: new Date(),
      reason: options.reason || 'Manual refund',
      metadata: options.metadata || {},
    });
  }

  /**
   * Manual provider doesn't support webhooks
   */
  async handleWebhook(payload, headers) {
    throw new Error('Manual provider does not support webhooks');
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      supportsWebhooks: false,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: true,
    };
  }

  /**
   * Generate payment instructions for customer
   * @private
   */
  _getPaymentInstructions(params) {
    const { paymentInfo, paymentInstructions } = params.metadata || {};

    // If user provided custom instructions, use them
    if (paymentInstructions) {
      return paymentInstructions;
    }

    // Generic fallback
    if (!paymentInfo) {
      return `Payment Amount: ${params.amount} ${params.currency || 'BDT'}\n\nPlease contact the organization for payment details.`;
    }

    // Build instructions from paymentInfo
    const lines = [`Payment Amount: ${params.amount} ${params.currency || 'BDT'}`, ``];

    // Add all payment info fields generically
    Object.entries(paymentInfo).forEach(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'number') {
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`${key}:`);
        Object.entries(value).forEach(([subKey, subValue]) => {
          lines.push(`  ${subKey}: ${subValue}`);
        });
      }
    });

    return lines.join('\n');
  }
}

export default ManualProvider;
