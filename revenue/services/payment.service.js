/**
 * Payment Service
 * @classytic/revenue
 *
 * Framework-agnostic payment verification and management service with DI
 * Handles payment verification, refunds, and status updates
 */

import {
  TransactionNotFoundError,
  ProviderNotFoundError,
  AlreadyVerifiedError,
  PaymentVerificationError,
  RefundNotSupportedError,
  RefundError,
  ProviderCapabilityError,
} from '../core/errors.js';
import { triggerHook } from '../utils/hooks.js';
import { TRANSACTION_TYPE } from '../enums/transaction.enums.js';

/**
 * Payment Service
 * Uses DI container for all dependencies
 */
export class PaymentService {
  constructor(container) {
    this.container = container;
    this.models = container.get('models');
    this.providers = container.get('providers');
    this.config = container.get('config');
    this.hooks = container.get('hooks');
    this.logger = container.get('logger');
  }

  /**
   * Verify a payment
   *
   * @param {String} paymentIntentId - Payment intent ID or transaction ID
   * @param {Object} options - Verification options
   * @param {String} options.verifiedBy - User ID who verified (for manual verification)
   * @returns {Promise<Object>} { transaction, status }
   */
  async verify(paymentIntentId, options = {}) {
    const { verifiedBy = null } = options;

    const TransactionModel = this.models.Transaction;

    // Find transaction by payment intent ID or transaction ID
    let transaction = await TransactionModel.findOne({
      'gateway.paymentIntentId': paymentIntentId,
    });

    if (!transaction) {
      // Try finding by transaction ID directly
      transaction = await TransactionModel.findById(paymentIntentId);
    }

    if (!transaction) {
      throw new TransactionNotFoundError(paymentIntentId);
    }

    if (transaction.status === 'verified' || transaction.status === 'completed') {
      throw new AlreadyVerifiedError(transaction._id);
    }

    // Get provider for verification
    const gatewayType = transaction.gateway?.type || 'manual';
    const provider = this.providers[gatewayType];

    if (!provider) {
      throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
    }

    // Verify payment with provider
    let paymentResult = null;
    try {
      paymentResult = await provider.verifyPayment(paymentIntentId);
    } catch (error) {
      this.logger.error('Payment verification failed:', error);

      // Update transaction as failed
      transaction.status = 'failed';
      transaction.metadata = {
        ...transaction.metadata,
        verificationError: error.message,
      };
      await transaction.save();

      throw new PaymentVerificationError(paymentIntentId, error.message);
    }

    // Update transaction based on verification result
    transaction.status = paymentResult.status === 'succeeded' ? 'verified' : paymentResult.status;
    transaction.verifiedAt = paymentResult.paidAt || new Date();
    transaction.verifiedBy = verifiedBy;
    transaction.gateway = {
      ...transaction.gateway,
      verificationData: paymentResult.metadata,
    };

    await transaction.save();

    // Trigger hook
    this._triggerHook('payment.verified', {
      transaction,
      paymentResult,
      verifiedBy,
    });

    return {
      transaction,
      paymentResult,
      status: 'verified',
    };
  }

  /**
   * Get payment status
   *
   * @param {String} paymentIntentId - Payment intent ID or transaction ID
   * @returns {Promise<Object>} { transaction, status }
   */
  async getStatus(paymentIntentId) {
    const TransactionModel = this.models.Transaction;

    // Find transaction
    let transaction = await TransactionModel.findOne({
      'gateway.paymentIntentId': paymentIntentId,
    });

    if (!transaction) {
      transaction = await TransactionModel.findById(paymentIntentId);
    }

    if (!transaction) {
      throw new TransactionNotFoundError(paymentIntentId);
    }

    // Get provider
    const gatewayType = transaction.gateway?.type || 'manual';
    const provider = this.providers[gatewayType];

    if (!provider) {
      throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
    }

    // Get status from provider
    let paymentResult = null;
    try {
      paymentResult = await provider.getStatus(paymentIntentId);
    } catch (error) {
      this.logger.warn('Failed to get payment status from provider:', error);
      // Return transaction status as fallback
      return {
        transaction,
        status: transaction.status,
        provider: gatewayType,
      };
    }

    return {
      transaction,
      paymentResult,
      status: paymentResult.status,
      provider: gatewayType,
    };
  }

  /**
   * Refund a payment
   *
   * @param {String} paymentId - Payment intent ID or transaction ID
   * @param {Number} amount - Amount to refund (optional, full refund if not provided)
   * @param {Object} options - Refund options
   * @param {String} options.reason - Refund reason
   * @returns {Promise<Object>} { transaction, refundResult }
   */
  async refund(paymentId, amount = null, options = {}) {
    const { reason = null } = options;

    const TransactionModel = this.models.Transaction;

    // Find transaction
    let transaction = await TransactionModel.findOne({
      'gateway.paymentIntentId': paymentId,
    });

    if (!transaction) {
      transaction = await TransactionModel.findById(paymentId);
    }

    if (!transaction) {
      throw new TransactionNotFoundError(paymentId);
    }

    if (transaction.status !== 'verified' && transaction.status !== 'completed') {
      throw new RefundError(transaction._id, 'Only verified/completed transactions can be refunded');
    }

    // Get provider
    const gatewayType = transaction.gateway?.type || 'manual';
    const provider = this.providers[gatewayType];

    if (!provider) {
      throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
    }

    // Check if provider supports refunds
    const capabilities = provider.getCapabilities();
    if (!capabilities.supportsRefunds) {
      throw new RefundNotSupportedError(gatewayType);
    }

    // Refund via provider
    const refundAmount = amount || transaction.amount;
    let refundResult = null;

    try {
      refundResult = await provider.refund(paymentId, refundAmount, { reason });
    } catch (error) {
      this.logger.error('Refund failed:', error);
      throw new RefundError(paymentId, error.message);
    }

    // Create separate refund transaction (EXPENSE) for proper accounting
    const refundTransactionType = this.config.transactionTypeMapping?.refund || TRANSACTION_TYPE.EXPENSE;
    
    const refundTransaction = await TransactionModel.create({
      organizationId: transaction.organizationId,
      customerId: transaction.customerId,
      amount: refundAmount,
      currency: transaction.currency,
      category: transaction.category,
      type: refundTransactionType,  // EXPENSE - money going out
      method: transaction.method || 'manual',
      status: 'completed',
      gateway: {
        type: transaction.gateway?.type || 'manual',
        paymentIntentId: refundResult.id,
        provider: refundResult.provider,
      },
      paymentDetails: transaction.paymentDetails,
      metadata: {
        ...transaction.metadata,
        isRefund: true,
        originalTransactionId: transaction._id.toString(),
        refundReason: reason,
        refundResult: refundResult.metadata,
      },
      idempotencyKey: `refund_${transaction._id}_${Date.now()}`,
    });

    // Update original transaction status
    const isPartialRefund = refundAmount < transaction.amount;
    transaction.status = isPartialRefund ? 'partially_refunded' : 'refunded';
    transaction.refundedAmount = (transaction.refundedAmount || 0) + refundAmount;
    transaction.refundedAt = refundResult.refundedAt || new Date();
    transaction.metadata = {
      ...transaction.metadata,
      refundTransactionId: refundTransaction._id.toString(),
      refundReason: reason,
    };

    await transaction.save();

    // Trigger hook
    this._triggerHook('payment.refunded', {
      transaction,
      refundTransaction,
      refundResult,
      refundAmount,
      reason,
      isPartialRefund,
    });

    return {
      transaction,
      refundTransaction,
      refundResult,
      status: transaction.status,
    };
  }

  /**
   * Handle webhook from payment provider
   *
   * @param {String} provider - Provider name
   * @param {Object} payload - Webhook payload
   * @param {Object} headers - Request headers
   * @returns {Promise<Object>} { event, transaction }
   */
  async handleWebhook(providerName, payload, headers = {}) {
    const provider = this.providers[providerName];

    if (!provider) {
      throw new ProviderNotFoundError(providerName, Object.keys(this.providers));
    }

    // Process webhook via provider
    let webhookEvent = null;
    try {
      webhookEvent = await provider.handleWebhook(payload, headers);
    } catch (error) {
      this.logger.error('Webhook processing failed:', error);
      throw new ProviderError(providerName, `Webhook processing failed: ${error.message}`);
    }

    // Find transaction by payment intent ID from webhook
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findOne({
      'gateway.paymentIntentId': webhookEvent.data.paymentIntentId,
    });

    if (!transaction) {
      this.logger.warn('Transaction not found for webhook event', {
        provider: providerName,
        eventId: webhookEvent.id,
        paymentIntentId: webhookEvent.data.paymentIntentId,
      });
      throw new TransactionNotFoundError(webhookEvent.data.paymentIntentId);
    }

    // Check for duplicate webhook processing (idempotency)
    if (transaction.webhook?.eventId === webhookEvent.id && transaction.webhook?.processedAt) {
      this.logger.warn('Webhook already processed', {
        transactionId: transaction._id,
        eventId: webhookEvent.id,
      });
      return {
        event: webhookEvent,
        transaction,
        status: 'already_processed',
      };
    }

    // Update transaction based on webhook event
    transaction.webhook = {
      eventId: webhookEvent.id,
      eventType: webhookEvent.type,
      receivedAt: new Date(),
      processedAt: new Date(),
      data: webhookEvent.data,
    };

    // Update status based on webhook type
    if (webhookEvent.type === 'payment.succeeded') {
      transaction.status = 'verified';
      transaction.verifiedAt = webhookEvent.createdAt;
    } else if (webhookEvent.type === 'payment.failed') {
      transaction.status = 'failed';
    } else if (webhookEvent.type === 'refund.succeeded') {
      transaction.status = 'refunded';
      transaction.refundedAt = webhookEvent.createdAt;
    }

    await transaction.save();

    // Trigger hook
    this._triggerHook(`payment.webhook.${webhookEvent.type}`, {
      event: webhookEvent,
      transaction,
    });

    return {
      event: webhookEvent,
      transaction,
      status: 'processed',
    };
  }

  /**
   * List payments/transactions with filters
   *
   * @param {Object} filters - Query filters
   * @param {Object} options - Query options (limit, skip, sort)
   * @returns {Promise<Array>} Transactions
   */
  async list(filters = {}, options = {}) {
    const TransactionModel = this.models.Transaction;
    const { limit = 50, skip = 0, sort = { createdAt: -1 } } = options;

    const transactions = await TransactionModel
      .find(filters)
      .limit(limit)
      .skip(skip)
      .sort(sort);

    return transactions;
  }

  /**
   * Get payment/transaction by ID
   *
   * @param {String} transactionId - Transaction ID
   * @returns {Promise<Object>} Transaction
   */
  async get(transactionId) {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    return transaction;
  }

  /**
   * Get provider instance
   *
   * @param {String} providerName - Provider name
   * @returns {Object} Provider instance
   */
  getProvider(providerName) {
    const provider = this.providers[providerName];
    if (!provider) {
      throw new ProviderNotFoundError(providerName, Object.keys(this.providers));
    }
    return provider;
  }

  /**
   * Trigger event hook (fire-and-forget, non-blocking)
   * @private
   */
  _triggerHook(event, data) {
    triggerHook(this.hooks, event, data, this.logger);
  }
}

export default PaymentService;
