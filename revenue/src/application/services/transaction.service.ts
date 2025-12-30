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

import { nanoid } from 'nanoid';
import { TransactionNotFoundError } from '../../core/errors.js';
import type { Container } from '../../core/container.js';
import type { EventBus } from '../../core/events.js';
import type { PluginManager, PluginContext } from '../../core/plugin.js';
import type {
  ModelsRegistry,
  TransactionDocument,
  TransactionListResult,
  ListOptions,
  Logger,
} from '../../shared/types/index.js';

/**
 * Transaction Service
 * Focused on core transaction lifecycle operations
 *
 * Architecture:
 * - PluginManager: Wraps operations with lifecycle hooks (before/after)
 * - EventBus: Fire-and-forget notifications for completed operations
 */
export class TransactionService {
  private readonly models: ModelsRegistry;
  private readonly plugins: PluginManager;
  private readonly events: EventBus;
  private readonly logger: Logger;

  constructor(container: Container) {
    this.models = container.get<ModelsRegistry>('models');
    this.plugins = container.get<PluginManager>('plugins');
    this.events = container.get<EventBus>('events');
    this.logger = container.get<Logger>('logger');
  }

  /**
   * Create plugin context for hook execution
   * @private
   */
  private getPluginContext(): PluginContext {
    return {
      events: this.events,
      logger: this.logger,
      storage: new Map(),
      meta: {
        requestId: nanoid(),
        timestamp: new Date(),
      },
    };
  }

  /**
   * Get transaction by ID
   *
   * @param transactionId - Transaction ID
   * @returns Transaction
   */
  async get(transactionId: string): Promise<TransactionDocument> {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    return transaction;
  }

  /**
   * List transactions with filters
   *
   * @param filters - Query filters
   * @param options - Query options (limit, skip, sort, populate)
   * @returns { transactions, total, page, limit }
   */
  async list(
    filters: Record<string, unknown> = {},
    options: ListOptions = {}
  ): Promise<TransactionListResult> {
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
    type QueryBuilder = {
      find(filter: object): QueryBuilder;
      limit(n: number): QueryBuilder;
      skip(n: number): QueryBuilder;
      sort(s: object): QueryBuilder;
      populate(field: string): QueryBuilder;
      then<T>(resolve: (value: TransactionDocument[]) => T): Promise<T>;
    };

    let query = (TransactionModel as unknown as {
      find(filter: object): QueryBuilder;
    }).find(filters)
      .limit(limit)
      .skip(actualSkip)
      .sort(sort);

    // Apply population if supported
    if (populate.length > 0 && typeof query.populate === 'function') {
      populate.forEach((field) => {
        query = query.populate(field);
      });
    }

    const transactions = await query as unknown as TransactionDocument[];

    // Count documents (works with both Mongoose and Repository)
    type ModelWithCount = {
      countDocuments?(filter: object): Promise<number>;
      count?(filter: object): Promise<number>;
    };

    const model = TransactionModel as unknown as ModelWithCount;
    const total = await (model.countDocuments
      ? model.countDocuments(filters)
      : model.count?.(filters)) ?? 0;

    return {
      transactions,
      total,
      page: page ?? Math.floor(actualSkip / limit) + 1,
      limit,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Update transaction
   *
   * @param transactionId - Transaction ID
   * @param updates - Fields to update
   * @returns Updated transaction
   */
  async update(
    transactionId: string,
    updates: Partial<TransactionDocument>
  ): Promise<TransactionDocument> {
    const hookInput = { transactionId, updates };

    return this.plugins.executeHook(
      'transaction.update.before',
      this.getPluginContext(),
      hookInput,
      async () => {
        const TransactionModel = this.models.Transaction;
        const effectiveUpdates = hookInput.updates;

        // Support both Repository pattern and Mongoose
        type ModelWithUpdate = {
          update?(id: string, data: object): Promise<TransactionDocument | null>;
          findByIdAndUpdate?(id: string, data: object, options?: object): Promise<TransactionDocument | null>;
        };

        const model = TransactionModel as unknown as ModelWithUpdate;
        let transaction: TransactionDocument | null;

        if (typeof model.update === 'function') {
          // Repository pattern
          transaction = await model.update(transactionId, effectiveUpdates);
        } else if (typeof model.findByIdAndUpdate === 'function') {
          // Plain Mongoose
          transaction = await model.findByIdAndUpdate(
            transactionId,
            { $set: effectiveUpdates },
            { new: true }
          );
        } else {
          throw new Error('Transaction model does not support update operations');
        }

        if (!transaction) {
          throw new TransactionNotFoundError(transactionId);
        }

        // Emit event (fire-and-forget, non-blocking)
        this.events.emit('transaction.updated', {
          transaction,
          updates: effectiveUpdates,
        });

        return this.plugins.executeHook(
          'transaction.update.after',
          this.getPluginContext(),
          { transactionId, updates: effectiveUpdates },
          async () => transaction as TransactionDocument
        );
      }
    );
  }
}

export default TransactionService;
