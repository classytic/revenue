/**
 * Escrow Service
 * @classytic/revenue
 *
 * Platform-as-intermediary payment flow
 * Hold funds → Verify → Split/Deduct → Release to organization
 */

import { TransactionNotFoundError } from '../core/errors.js';
import { HOLD_STATUS, RELEASE_REASON, HOLD_REASON } from '../enums/escrow.enums.js';
import { TRANSACTION_TYPE, TRANSACTION_STATUS } from '../enums/transaction.enums.js';
import { SPLIT_STATUS } from '../enums/split.enums.js';
import { triggerHook } from '../utils/hooks.js';
import { calculateSplits, calculateOrganizationPayout } from '../utils/commission-split.js';

export class EscrowService {
  constructor(container) {
    this.container = container;
    this.models = container.get('models');
    this.providers = container.get('providers');
    this.config = container.get('config');
    this.hooks = container.get('hooks');
    this.logger = container.get('logger');
  }

  /**
   * Hold funds in escrow
   *
   * @param {String} transactionId - Transaction to hold
   * @param {Object} options - Hold options
   * @returns {Promise<Object>} Updated transaction
   */
  async hold(transactionId, options = {}) {
    const {
      reason = HOLD_REASON.PAYMENT_VERIFICATION,
      holdUntil = null,
      metadata = {},
    } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (transaction.status !== TRANSACTION_STATUS.VERIFIED) {
      throw new Error(`Cannot hold transaction with status: ${transaction.status}. Must be verified.`);
    }

    transaction.hold = {
      status: HOLD_STATUS.HELD,
      heldAmount: transaction.amount,
      releasedAmount: 0,
      reason,
      heldAt: new Date(),
      ...(holdUntil && { holdUntil }),
      releases: [],
      metadata,
    };

    await transaction.save();

    this._triggerHook('escrow.held', {
      transaction,
      heldAmount: transaction.amount,
      reason,
    });

    return transaction;
  }

  /**
   * Release funds from escrow to recipient
   *
   * @param {String} transactionId - Transaction to release
   * @param {Object} options - Release options
   * @returns {Promise<Object>} { transaction, releaseTransaction }
   */
  async release(transactionId, options = {}) {
    const {
      amount = null,
      recipientId,
      recipientType = 'organization',
      reason = RELEASE_REASON.PAYMENT_VERIFIED,
      releasedBy = null,
      createTransaction = true,
      metadata = {},
    } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new Error(`Transaction is not in held status. Current: ${transaction.hold?.status || 'none'}`);
    }

    if (!recipientId) {
      throw new Error('recipientId is required for release');
    }

    const releaseAmount = amount || (transaction.hold.heldAmount - transaction.hold.releasedAmount);
    const availableAmount = transaction.hold.heldAmount - transaction.hold.releasedAmount;

    if (releaseAmount > availableAmount) {
      throw new Error(`Release amount (${releaseAmount}) exceeds available held amount (${availableAmount})`);
    }

    const releaseRecord = {
      amount: releaseAmount,
      recipientId,
      recipientType,
      releasedAt: new Date(),
      releasedBy,
      reason,
      metadata,
    };

    transaction.hold.releases.push(releaseRecord);
    transaction.hold.releasedAmount += releaseAmount;

    const isFullRelease = transaction.hold.releasedAmount >= transaction.hold.heldAmount;
    const isPartialRelease = transaction.hold.releasedAmount > 0 && transaction.hold.releasedAmount < transaction.hold.heldAmount;

    if (isFullRelease) {
      transaction.hold.status = HOLD_STATUS.RELEASED;
      transaction.hold.releasedAt = new Date();
      transaction.status = TRANSACTION_STATUS.COMPLETED;
    } else if (isPartialRelease) {
      transaction.hold.status = HOLD_STATUS.PARTIALLY_RELEASED;
    }

    await transaction.save();

    let releaseTransaction = null;
    if (createTransaction) {
      releaseTransaction = await TransactionModel.create({
        organizationId: transaction.organizationId,
        customerId: recipientId,
        amount: releaseAmount,
        currency: transaction.currency,
        category: transaction.category,
        type: TRANSACTION_TYPE.INCOME,
        method: transaction.method,
        status: TRANSACTION_STATUS.COMPLETED,
        gateway: transaction.gateway,
        referenceId: transaction.referenceId,
        referenceModel: transaction.referenceModel,
        metadata: {
          ...metadata,
          isRelease: true,
          heldTransactionId: transaction._id.toString(),
          releaseReason: reason,
          recipientType,
        },
        idempotencyKey: `release_${transaction._id}_${Date.now()}`,
      });
    }

    this._triggerHook('escrow.released', {
      transaction,
      releaseTransaction,
      releaseAmount,
      recipientId,
      recipientType,
      reason,
      isFullRelease,
      isPartialRelease,
    });

    return {
      transaction,
      releaseTransaction,
      releaseAmount,
      isFullRelease,
      isPartialRelease,
    };
  }

  /**
   * Cancel hold and release back to customer
   *
   * @param {String} transactionId - Transaction to cancel hold
   * @param {Object} options - Cancel options
   * @returns {Promise<Object>} Updated transaction
   */
  async cancel(transactionId, options = {}) {
    const { reason = 'Hold cancelled', metadata = {} } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new Error(`Transaction is not in held status. Current: ${transaction.hold?.status || 'none'}`);
    }

    transaction.hold.status = HOLD_STATUS.CANCELLED;
    transaction.hold.cancelledAt = new Date();
    transaction.hold.metadata = {
      ...transaction.hold.metadata,
      ...metadata,
      cancelReason: reason,
    };

    transaction.status = TRANSACTION_STATUS.CANCELLED;

    await transaction.save();

    this._triggerHook('escrow.cancelled', {
      transaction,
      reason,
    });

    return transaction;
  }

  /**
   * Split payment to multiple recipients
   * Deducts splits from held amount and releases remainder to organization
   *
   * @param {String} transactionId - Transaction to split
   * @param {Array} splitRules - Split configuration
   * @returns {Promise<Object>} { transaction, splitTransactions, organizationTransaction }
   */
  async split(transactionId, splitRules = []) {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new Error(`Transaction must be held before splitting. Current: ${transaction.hold?.status || 'none'}`);
    }

    if (!splitRules || splitRules.length === 0) {
      throw new Error('splitRules cannot be empty');
    }

    const splits = calculateSplits(
      transaction.amount,
      splitRules,
      transaction.commission?.gatewayFeeRate || 0
    );

    transaction.splits = splits;
    await transaction.save();

    const splitTransactions = [];

    for (const split of splits) {
      const splitTransaction = await TransactionModel.create({
        organizationId: transaction.organizationId,
        customerId: split.recipientId,
        amount: split.netAmount,
        currency: transaction.currency,
        category: split.type,
        type: TRANSACTION_TYPE.EXPENSE,
        method: transaction.method,
        status: TRANSACTION_STATUS.COMPLETED,
        gateway: transaction.gateway,
        referenceId: transaction.referenceId,
        referenceModel: transaction.referenceModel,
        metadata: {
          isSplit: true,
          splitType: split.type,
          recipientType: split.recipientType,
          originalTransactionId: transaction._id.toString(),
          grossAmount: split.grossAmount,
          gatewayFeeAmount: split.gatewayFeeAmount,
        },
        idempotencyKey: `split_${transaction._id}_${split.recipientId}_${Date.now()}`,
      });

      split.payoutTransactionId = splitTransaction._id.toString();
      split.status = SPLIT_STATUS.PAID;
      split.paidDate = new Date();

      splitTransactions.push(splitTransaction);
    }

    await transaction.save();

    const organizationPayout = calculateOrganizationPayout(transaction.amount, splits);

    const organizationTransaction = await this.release(transactionId, {
      amount: organizationPayout,
      recipientId: transaction.organizationId,
      recipientType: 'organization',
      reason: RELEASE_REASON.PAYMENT_VERIFIED,
      createTransaction: true,
      metadata: {
        afterSplits: true,
        totalSplits: splits.length,
        totalSplitAmount: transaction.amount - organizationPayout,
      },
    });

    this._triggerHook('escrow.split', {
      transaction,
      splits,
      splitTransactions,
      organizationTransaction: organizationTransaction.releaseTransaction,
      organizationPayout,
    });

    return {
      transaction,
      splits,
      splitTransactions,
      organizationTransaction: organizationTransaction.releaseTransaction,
      organizationPayout,
    };
  }

  /**
   * Get escrow status
   *
   * @param {String} transactionId - Transaction ID
   * @returns {Promise<Object>} Escrow status
   */
  async getStatus(transactionId) {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    return {
      transaction,
      hold: transaction.hold || null,
      splits: transaction.splits || [],
      hasHold: !!transaction.hold,
      hasSplits: transaction.splits && transaction.splits.length > 0,
    };
  }

  _triggerHook(event, data) {
    triggerHook(this.hooks, event, data, this.logger);
  }
}

export default EscrowService;
