/**
 * Manual Payment Provider
 * @classytic/revenue
 *
 * Built-in provider for manual payment verification
 * Perfect for: Cash, bank transfers, mobile money without API
 */

import { PaymentProvider, PaymentIntent, PaymentResult, RefundResult } from './base.js';
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
      supportedMethods: ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'manual'],
    };
  }

  /**
   * Generate payment instructions for customer
   * @private
   */
  _getPaymentInstructions(params) {
    const { organizationPaymentInfo, method } = params.metadata || {};

    if (!organizationPaymentInfo) {
      return 'Please contact the organization for payment details.';
    }

    const instructions = [];

    // Add method-specific instructions
    switch (method) {
      case 'bkash':
      case 'nagad':
      case 'rocket':
        if (organizationPaymentInfo[`${method}Number`]) {
          instructions.push(
            `Send money via ${method.toUpperCase()}:`,
            `Number: ${organizationPaymentInfo[`${method}Number`]}`,
            `Amount: ${params.amount} ${params.currency || 'BDT'}`,
            ``,
            `After payment, provide the transaction ID/reference number.`
          );
        }
        break;

      case 'bank':
        if (organizationPaymentInfo.bankAccount) {
          const bank = organizationPaymentInfo.bankAccount;
          instructions.push(
            `Bank Transfer Details:`,
            `Bank: ${bank.bankName || 'N/A'}`,
            `Account: ${bank.accountNumber || 'N/A'}`,
            `Account Name: ${bank.accountName || 'N/A'}`,
            `Amount: ${params.amount} ${params.currency || 'BDT'}`,
            ``,
            `After payment, upload proof and provide reference.`
          );
        }
        break;

      case 'cash':
        instructions.push(
          `Cash Payment:`,
          `Amount: ${params.amount} ${params.currency || 'BDT'}`,
          ``,
          `Pay at the organization's office and get a receipt.`
        );
        break;

      default:
        instructions.push(
          `Payment Amount: ${params.amount} ${params.currency || 'BDT'}`,
          ``,
          `Contact the organization for payment details.`
        );
    }

    // Add custom instructions if provided
    if (organizationPaymentInfo.paymentInstructions) {
      instructions.push(``, `Additional Instructions:`, organizationPaymentInfo.paymentInstructions);
    }

    return instructions.join('\n');
  }
}

export default ManualProvider;
