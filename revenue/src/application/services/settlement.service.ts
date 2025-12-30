/**
 * Settlement Service
 * @classytic/revenue
 *
 * Tracks payouts from platform to vendors/affiliates/partners
 * Manages the flow: Transaction → Split → Settlement → Bank Transfer
 */

import type { Container } from '../../core/container.js';
import type { EventBus } from '../../core/events.js';
import type { PluginManager } from '../../core/plugin.js';
import type {
  ModelsRegistry,
  Logger,
  TransactionDocument,
} from '../../shared/types/index.js';
import {
  ModelNotRegisteredError,
  TransactionNotFoundError,
  InvalidStateTransitionError,
  ValidationError,
} from '../../core/errors.js';
import { SETTLEMENT_STATUS, SETTLEMENT_TYPE } from '../../enums/settlement.enums.js';
import { SETTLEMENT_STATE_MACHINE } from '../../core/state-machine/index.js';
import { appendAuditEvent } from '../../infrastructure/audit/index.js';
import type { SettlementDocument } from '../../schemas/settlement/settlement.schema.js';

// ============ TYPES ============

export interface CreateFromSplitsOptions {
  scheduledAt?: Date;
  payoutMethod?: 'bank_transfer' | 'mobile_wallet' | 'platform_balance' | 'crypto' | 'manual';
  metadata?: Record<string, unknown>;
}

export interface ScheduleSettlementParams {
  organizationId: string;
  recipientId: string;
  recipientType: 'platform' | 'organization' | 'user' | 'affiliate' | 'partner';
  type: 'split_payout' | 'platform_withdrawal' | 'manual_payout' | 'escrow_release';
  amount: number;
  currency?: string;
  payoutMethod: 'bank_transfer' | 'mobile_wallet' | 'platform_balance' | 'crypto' | 'manual';
  sourceTransactionIds?: string[];
  sourceSplitIds?: string[];
  scheduledAt?: Date;
  bankTransferDetails?: {
    accountNumber?: string;
    accountName?: string;
    bankName?: string;
    routingNumber?: string;
    swiftCode?: string;
    iban?: string;
  };
  mobileWalletDetails?: {
    provider?: string;
    phoneNumber?: string;
    accountNumber?: string;
  };
  cryptoDetails?: {
    network?: string;
    walletAddress?: string;
  };
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface ProcessOptions {
  limit?: number;
  organizationId?: string;
  payoutMethod?: string;
  dryRun?: boolean;
}

export interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  settlements: SettlementDocument[];
  errors: Array<{ settlementId: string; error: string }>;
}

export interface CompletionDetails {
  transferReference?: string;
  transferredAt?: Date;
  transactionHash?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface SettlementFilters {
  organizationId?: string;
  recipientId?: string;
  status?: string | string[];
  type?: string;
  payoutMethod?: string;
  scheduledAfter?: Date;
  scheduledBefore?: Date;
  limit?: number;
  skip?: number;
  sort?: Record<string, 1 | -1>;
}

export interface SummaryOptions {
  organizationId?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface SettlementSummary {
  recipientId: string;
  totalPending: number;
  totalProcessing: number;
  totalCompleted: number;
  totalFailed: number;
  amountPending: number;
  amountCompleted: number;
  amountFailed: number;
  currency: string;
  lastSettlementDate?: Date;
  settlements: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
}

// ============ SERVICE ============

/**
 * Settlement Service
 *
 * Handles payout tracking after splits are released from escrow:
 *
 * Flow:
 * 1. Transaction has splits → 2. Escrow released → 3. Create settlements → 4. Process payouts → 5. Mark complete
 *
 * @example
 * ```typescript
 * // Auto-create settlements from transaction splits
 * await revenue.settlement.createFromSplits(transactionId);
 *
 * // Schedule a manual payout
 * await revenue.settlement.schedule({
 *   recipientId: vendorId,
 *   amount: 8500,
 *   payoutMethod: 'bank_transfer',
 * });
 *
 * // Process pending payouts
 * const result = await revenue.settlement.processPending({ limit: 100 });
 *
 * // Mark as completed after bank confirms
 * await revenue.settlement.complete(settlementId, { transferReference: 'TRF123' });
 * ```
 */
/**
 * Settlement Service
 * Uses DI container for all dependencies
 *
 * Architecture:
 * - PluginManager: Wraps operations with lifecycle hooks (before/after)
 * - EventBus: Fire-and-forget notifications for completed operations
 */
export class SettlementService {
  private readonly models: ModelsRegistry;
  private readonly plugins: PluginManager;
  private readonly logger: Logger;
  private readonly events: EventBus;

  constructor(container: Container) {
    this.models = container.get<ModelsRegistry>('models');
    this.plugins = container.get<PluginManager>('plugins');
    this.logger = container.get<Logger>('logger');
    this.events = container.get<EventBus>('events');

    // Settlements don't have hooks yet - future enhancement
    void this.plugins;
  }

  /**
   * Create settlements from transaction splits
   * Typically called after escrow is released
   *
   * @param transactionId - Transaction ID with splits
   * @param options - Creation options
   * @returns Array of created settlements
   */
  async createFromSplits(
    transactionId: string,
    options: CreateFromSplitsOptions = {}
  ): Promise<SettlementDocument[]> {
    const {
      scheduledAt = new Date(),
      payoutMethod = 'bank_transfer',
      metadata = {},
    } = options;

    // Get Settlement model
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    // Get transaction
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    // Check if transaction has splits
    if (!transaction.splits || transaction.splits.length === 0) {
      throw new ValidationError('Transaction has no splits to settle', { transactionId });
    }

    // Create a settlement for each split
    const SettlementModel = this.models.Settlement;
    const settlements: SettlementDocument[] = [];

    for (const split of transaction.splits) {
      // Skip if already paid
      if (split.status === 'paid') {
        this.logger.info('Split already paid, skipping', { splitId: split._id });
        continue;
      }

      const settlement = await SettlementModel.create({
        organizationId: transaction.organizationId,
        recipientId: split.recipientId,
        recipientType: split.recipientType,
        type: SETTLEMENT_TYPE.SPLIT_PAYOUT,
        status: SETTLEMENT_STATUS.PENDING,
        payoutMethod,
        amount: split.netAmount,
        currency: transaction.currency,
        sourceTransactionIds: [transaction._id],
        sourceSplitIds: [split._id?.toString() || ''],
        scheduledAt,
        metadata: {
          ...metadata,
          splitType: split.type,
          transactionCategory: transaction.category,
        },
      }) as SettlementDocument;

      settlements.push(settlement);
    }

    // Trigger hook
    this.events.emit('settlement.created', {
      settlements,
      transactionId,
      count: settlements.length,
    });

    this.logger.info('Created settlements from splits', {
      transactionId,
      count: settlements.length,
    });

    return settlements;
  }

  /**
   * Schedule a payout
   *
   * @param params - Settlement parameters
   * @returns Created settlement
   */
  async schedule(params: ScheduleSettlementParams): Promise<SettlementDocument> {
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    const {
      organizationId,
      recipientId,
      recipientType,
      type,
      amount,
      currency = 'USD',
      payoutMethod,
      sourceTransactionIds = [],
      sourceSplitIds = [],
      scheduledAt = new Date(),
      bankTransferDetails,
      mobileWalletDetails,
      cryptoDetails,
      notes,
      metadata = {},
    } = params;

    // Validate amount
    if (amount <= 0) {
      throw new ValidationError('Settlement amount must be positive', { amount });
    }

    const SettlementModel = this.models.Settlement;
    const settlement = await SettlementModel.create({
      organizationId,
      recipientId,
      recipientType,
      type,
      status: SETTLEMENT_STATUS.PENDING,
      payoutMethod,
      amount,
      currency,
      sourceTransactionIds,
      sourceSplitIds,
      scheduledAt,
      bankTransferDetails,
      mobileWalletDetails,
      cryptoDetails,
      notes,
      metadata,
    }) as SettlementDocument;

    // Trigger hook
    this.events.emit('settlement.scheduled', {
      settlement,
      scheduledAt,
    });

    this.logger.info('Settlement scheduled', {
      settlementId: settlement._id,
      recipientId,
      amount,
    });

    return settlement;
  }

  /**
   * Process pending settlements
   * Batch process settlements that are due
   *
   * @param options - Processing options
   * @returns Processing result
   */
  async processPending(options: ProcessOptions = {}): Promise<ProcessResult> {
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    const {
      limit = 100,
      organizationId,
      payoutMethod,
      dryRun = false,
    } = options;

    const SettlementModel = this.models.Settlement;

    // Build query
    const query: Record<string, unknown> = {
      status: SETTLEMENT_STATUS.PENDING,
      scheduledAt: { $lte: new Date() },
    };

    if (organizationId) query.organizationId = organizationId;
    if (payoutMethod) query.payoutMethod = payoutMethod;

    // Get pending settlements
    const settlements = await (SettlementModel as unknown as {
      find(filter: object): { limit(n: number): { sort(s: object): Promise<SettlementDocument[]> } };
    })
      .find(query)
      .limit(limit)
      .sort({ scheduledAt: 1 });

    const result: ProcessResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      settlements: [],
      errors: [],
    };

    if (dryRun) {
      this.logger.info('Dry run: would process settlements', { count: settlements.length });
      result.settlements = settlements;
      return result;
    }

    // Process each settlement
    for (const settlement of settlements) {
      result.processed++;

      try {
        // Validate state transition and create audit event
        const auditEvent = SETTLEMENT_STATE_MACHINE.validateAndCreateAuditEvent(
          settlement.status,
          SETTLEMENT_STATUS.PROCESSING,
          settlement._id.toString(),
          {
            changedBy: 'system',
            reason: 'Settlement processing started',
            metadata: { recipientId: settlement.recipientId, amount: settlement.amount }
          }
        );

        // Update to processing
        settlement.status = SETTLEMENT_STATUS.PROCESSING;
        settlement.processedAt = new Date();

        // Append audit event to metadata
        Object.assign(settlement, appendAuditEvent(settlement, auditEvent));

        await settlement.save();

        // Here you would integrate with your payout provider
        // For now, we just mark as processing
        // In production: call bank API, wallet API, etc.

        result.succeeded++;
        result.settlements.push(settlement);

        this.events.emit('settlement.processing', {
          settlement,
          processedAt: settlement.processedAt,
        });
      } catch (error) {
        result.failed++;
        result.errors.push({
          settlementId: settlement._id.toString(),
          error: (error as Error).message,
        });

        this.logger.error('Failed to process settlement', {
          settlementId: settlement._id,
          error,
        });
      }
    }

    this.logger.info('Processed settlements', result);

    return result;
  }

  /**
   * Mark settlement as completed
   * Call this after bank confirms the transfer
   *
   * @param settlementId - Settlement ID
   * @param details - Completion details
   * @returns Updated settlement
   */
  async complete(
    settlementId: string,
    details: CompletionDetails = {}
  ): Promise<SettlementDocument> {
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    const SettlementModel = this.models.Settlement;
    const settlement = await SettlementModel.findById(settlementId) as SettlementDocument | null;

    if (!settlement) {
      throw new ValidationError('Settlement not found', { settlementId });
    }

    // Validate state transition
    if (settlement.status !== SETTLEMENT_STATUS.PROCESSING && settlement.status !== SETTLEMENT_STATUS.PENDING) {
      throw new InvalidStateTransitionError(
        'complete',
        SETTLEMENT_STATUS.PROCESSING,
        settlement.status,
        'Only processing or pending settlements can be completed'
      );
    }

    const {
      transferReference,
      transferredAt = new Date(),
      transactionHash,
      notes,
      metadata = {},
    } = details;

    // Validate state transition and create audit event
    const auditEvent = SETTLEMENT_STATE_MACHINE.validateAndCreateAuditEvent(
      settlement.status,
      SETTLEMENT_STATUS.COMPLETED,
      settlement._id.toString(),
      {
        changedBy: 'system',
        reason: 'Settlement completed successfully',
        metadata: {
          transferReference,
          transferredAt,
          transactionHash,
          payoutMethod: settlement.payoutMethod,
          amount: settlement.amount
        }
      }
    );

    // Update settlement
    settlement.status = SETTLEMENT_STATUS.COMPLETED;
    settlement.completedAt = new Date();

    // Update payout method details
    if (settlement.payoutMethod === 'bank_transfer' && transferReference) {
      settlement.bankTransferDetails = {
        ...settlement.bankTransferDetails,
        transferReference,
        transferredAt,
      };
    } else if (settlement.payoutMethod === 'crypto' && transactionHash) {
      settlement.cryptoDetails = {
        ...settlement.cryptoDetails,
        transactionHash,
        transferredAt,
      };
    } else if (settlement.payoutMethod === 'mobile_wallet') {
      settlement.mobileWalletDetails = {
        ...settlement.mobileWalletDetails,
        transferredAt,
      };
    } else if (settlement.payoutMethod === 'platform_balance') {
      settlement.platformBalanceDetails = {
        ...settlement.platformBalanceDetails,
        appliedAt: transferredAt,
      };
    }

    if (notes) settlement.notes = notes;
    settlement.metadata = { ...settlement.metadata, ...metadata };

    // Append audit event to metadata
    Object.assign(settlement, appendAuditEvent(settlement, auditEvent));

    await settlement.save();

    // Trigger hook
    this.events.emit('settlement.completed', {
      settlement,
      completedAt: settlement.completedAt,
    });

    this.logger.info('Settlement completed', {
      settlementId: settlement._id,
      recipientId: settlement.recipientId,
      amount: settlement.amount,
    });

    return settlement;
  }

  /**
   * Mark settlement as failed
   *
   * @param settlementId - Settlement ID
   * @param reason - Failure reason
   * @returns Updated settlement
   */
  async fail(
    settlementId: string,
    reason: string,
    options: { code?: string; retry?: boolean } = {}
  ): Promise<SettlementDocument> {
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    const SettlementModel = this.models.Settlement;
    const settlement = await SettlementModel.findById(settlementId) as SettlementDocument | null;

    if (!settlement) {
      throw new ValidationError('Settlement not found', { settlementId });
    }

    const { code, retry = false } = options;

    // Update settlement
    if (retry) {
      // Validate state transition to pending (for retry) and create audit event
      const auditEvent = SETTLEMENT_STATE_MACHINE.validateAndCreateAuditEvent(
        settlement.status,
        SETTLEMENT_STATUS.PENDING,
        settlement._id.toString(),
        {
          changedBy: 'system',
          reason: `Settlement failed, retrying: ${reason}`,
          metadata: {
            failureReason: reason,
            failureCode: code,
            retryCount: (settlement.retryCount || 0) + 1,
            scheduledAt: new Date(Date.now() + 60 * 60 * 1000)
          }
        }
      );

      // Reset to pending for retry
      settlement.status = SETTLEMENT_STATUS.PENDING;
      settlement.retryCount = (settlement.retryCount || 0) + 1;
      settlement.scheduledAt = new Date(Date.now() + 60 * 60 * 1000); // Retry in 1 hour

      // Append audit event to metadata
      Object.assign(settlement, appendAuditEvent(settlement, auditEvent));
    } else {
      // Validate state transition to failed and create audit event
      const auditEvent = SETTLEMENT_STATE_MACHINE.validateAndCreateAuditEvent(
        settlement.status,
        SETTLEMENT_STATUS.FAILED,
        settlement._id.toString(),
        {
          changedBy: 'system',
          reason: `Settlement failed: ${reason}`,
          metadata: {
            failureReason: reason,
            failureCode: code
          }
        }
      );

      settlement.status = SETTLEMENT_STATUS.FAILED;
      settlement.failedAt = new Date();

      // Append audit event to metadata
      Object.assign(settlement, appendAuditEvent(settlement, auditEvent));
    }

    settlement.failureReason = reason;
    if (code) settlement.failureCode = code;

    await settlement.save();

    // Trigger hook
    this.events.emit('settlement.failed', {
      settlement,
      reason,
      code,
      retry,
    });

    this.logger.warn('Settlement failed', {
      settlementId: settlement._id,
      reason,
      retry,
    });

    return settlement;
  }

  /**
   * List settlements with filters
   *
   * @param filters - Query filters
   * @returns Settlements
   */
  async list(filters: SettlementFilters = {}): Promise<SettlementDocument[]> {
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    const SettlementModel = this.models.Settlement;
    const {
      organizationId,
      recipientId,
      status,
      type,
      payoutMethod,
      scheduledAfter,
      scheduledBefore,
      limit = 50,
      skip = 0,
      sort = { createdAt: -1 },
    } = filters;

    // Build query
    const query: Record<string, unknown> = {};

    if (organizationId) query.organizationId = organizationId;
    if (recipientId) query.recipientId = recipientId;
    if (status) query.status = Array.isArray(status) ? { $in: status } : status;
    if (type) query.type = type;
    if (payoutMethod) query.payoutMethod = payoutMethod;

    if (scheduledAfter || scheduledBefore) {
      query.scheduledAt = {};
      if (scheduledAfter) (query.scheduledAt as Record<string, unknown>).$gte = scheduledAfter;
      if (scheduledBefore) (query.scheduledAt as Record<string, unknown>).$lte = scheduledBefore;
    }

    const settlements = await (SettlementModel as unknown as {
      find(filter: object): {
        limit(n: number): { skip(n: number): { sort(s: object): Promise<SettlementDocument[]> } };
      };
    })
      .find(query)
      .limit(limit)
      .skip(skip)
      .sort(sort);

    return settlements;
  }

  /**
   * Get payout summary for recipient
   *
   * @param recipientId - Recipient ID
   * @param options - Summary options
   * @returns Settlement summary
   */
  async getSummary(
    recipientId: string,
    options: SummaryOptions = {}
  ): Promise<SettlementSummary> {
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    const { organizationId, startDate, endDate } = options;

    const SettlementModel = this.models.Settlement;

    // Build query
    const query: Record<string, unknown> = { recipientId };
    if (organizationId) query.organizationId = organizationId;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) (query.createdAt as Record<string, unknown>).$gte = startDate;
      if (endDate) (query.createdAt as Record<string, unknown>).$lte = endDate;
    }

    // Get all settlements for recipient
    const settlements = await (SettlementModel as unknown as {
      find(filter: object): Promise<SettlementDocument[]>;
    }).find(query);

    // Calculate summary
    const summary: SettlementSummary = {
      recipientId,
      totalPending: 0,
      totalProcessing: 0,
      totalCompleted: 0,
      totalFailed: 0,
      amountPending: 0,
      amountCompleted: 0,
      amountFailed: 0,
      currency: settlements[0]?.currency || 'USD',
      settlements: {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    };

    for (const settlement of settlements) {
      summary.settlements[settlement.status as keyof typeof summary.settlements]++;

      if (settlement.status === SETTLEMENT_STATUS.PENDING) {
        summary.totalPending++;
        summary.amountPending += settlement.amount;
      } else if (settlement.status === SETTLEMENT_STATUS.PROCESSING) {
        summary.totalProcessing++;
      } else if (settlement.status === SETTLEMENT_STATUS.COMPLETED) {
        summary.totalCompleted++;
        summary.amountCompleted += settlement.amount;
        if (!summary.lastSettlementDate || settlement.completedAt! > summary.lastSettlementDate) {
          summary.lastSettlementDate = settlement.completedAt!;
        }
      } else if (settlement.status === SETTLEMENT_STATUS.FAILED) {
        summary.totalFailed++;
        summary.amountFailed += settlement.amount;
      }
    }

    return summary;
  }

  /**
   * Get settlement by ID
   *
   * @param settlementId - Settlement ID
   * @returns Settlement
   */
  async get(settlementId: string): Promise<SettlementDocument> {
    if (!this.models.Settlement) {
      throw new ModelNotRegisteredError('Settlement');
    }

    const SettlementModel = this.models.Settlement;
    const settlement = await SettlementModel.findById(settlementId) as SettlementDocument | null;

    if (!settlement) {
      throw new ValidationError('Settlement not found', { settlementId });
    }

    return settlement;
  }

}

export default SettlementService;
