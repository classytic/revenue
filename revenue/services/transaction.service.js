/**
 * Transaction Service
 * @classytic/revenue
 *
 * Thin, focused transaction service for core operations
 * Users handle their own analytics, exports, and complex queries
 *
 * Works with ANY model implementation:
 * - Plain Mongoose models
 * - @classytic/mongokit Repository instances
 * - Any other abstraction with compatible interface
 */

import { TransactionNotFoundError } from '../core/errors.js';
import { triggerHook } from '../utils/hooks.js';

/**
 * Transaction Service
 * Focused on core transaction lifecycle operations
 */
export class TransactionService {
  constructor(container) {
    this.container = container;
    this.models = container.get('models');
    this.hooks = container.get('hooks');
    this.logger = container.get('logger');
  }

  /**
   * Get transaction by ID
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
   * List transactions with filters
   *
   * @param {Object} filters - Query filters
   * @param {Object} options - Query options (limit, skip, sort, populate)
   * @returns {Promise<Object>} { transactions, total, page, limit }
   */
  async list(filters = {}, options = {}) {
    const TransactionModel = this.models.Transaction;
    const {
      limit = 50,
      skip = 0,
      page = null,
      sort = { createdAt: -1 },
      populate = [],
    } = options;

    // Calculate pagination
    const actualSkip = page ? (page - 1) * limit : skip;

    // Build query
    let query = TransactionModel.find(filters)
      .limit(limit)
      .skip(actualSkip)
      .sort(sort);

    // Apply population if supported
    if (populate.length > 0 && typeof query.populate === 'function') {
      populate.forEach(field => {
        query = query.populate(field);
      });
    }

    const transactions = await query;

    // Count documents (works with both Mongoose and Repository)
    const total = await (TransactionModel.countDocuments
      ? TransactionModel.countDocuments(filters)
      : TransactionModel.count(filters));

    return {
      transactions,
      total,
      page: page || Math.floor(actualSkip / limit) + 1,
      limit,
      pages: Math.ceil(total / limit),
    };
  }


  /**
   * Update transaction
   *
   * @param {String} transactionId - Transaction ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated transaction
   */
  async update(transactionId, updates) {
    const TransactionModel = this.models.Transaction;

    // Support both Repository pattern and Mongoose
    let transaction;
    if (typeof TransactionModel.update === 'function') {
      // Repository pattern
      transaction = await TransactionModel.update(transactionId, updates);
    } else {
      // Plain Mongoose
      transaction = await TransactionModel.findByIdAndUpdate(
        transactionId,
        { $set: updates },
        { new: true }
      );
    }

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    // Trigger hook (fire-and-forget, non-blocking)
    this._triggerHook('transaction.updated', {
      transaction,
      updates,
    });

    return transaction;
  }

  /**
   * Trigger event hook (fire-and-forget, non-blocking)
   * @private
   */
  _triggerHook(event, data) {
    triggerHook(this.hooks, event, data, this.logger);
  }
}

export default TransactionService;
