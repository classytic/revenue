/**
 * Escrow Service
 * @classytic/revenue
 *
 * Platform-as-intermediary payment flow
 * Hold funds → Verify → Split/Deduct → Release to organization
 */

import { nanoid } from 'nanoid';
import { TransactionNotFoundError, InvalidStateTransitionError, ValidationError } from '../../core/errors.js';
import { HOLD_STATUS, RELEASE_REASON, HOLD_REASON } from '../../enums/escrow.enums.js';
import { TRANSACTION_STATUS } from '../../enums/transaction.enums.js';
import { SPLIT_STATUS } from '../../enums/split.enums.js';
import { TRANSACTION_STATE_MACHINE, HOLD_STATE_MACHINE } from '../../core/state-machine/index.js';
import { appendAuditEvent } from '../../infrastructure/audit/index.js';
import { calculateSplits, calculateOrganizationPayout } from '../../shared/utils/calculators/commission-split.js';
import type { Container } from '../../core/container.js';
import type { EventBus } from '../../core/events.js';
import type { PluginManager, PluginContext } from '../../core/plugin.js';
import type {
  ModelsRegistry,
  Logger,
  TransactionDocument,
  HoldOptions,
  ReleaseOptions,
  ReleaseResult,
  CancelHoldOptions,
  SplitResult,
  EscrowStatusResult,
  SplitRule,
  SplitInfo,
} from '../../shared/types/index.js';

/**
 * Escrow Service
 * Uses DI container for all dependencies
 *
 * Architecture:
 * - PluginManager: Wraps operations with lifecycle hooks (before/after)
 * - EventBus: Fire-and-forget notifications for completed operations
 */
export class EscrowService {
  private readonly models: ModelsRegistry;
  private readonly plugins: PluginManager;
  private readonly logger: Logger;
  private readonly events: EventBus;

  constructor(container: Container) {
    this.models = container.get<ModelsRegistry>('models');
    this.plugins = container.get<PluginManager>('plugins');
    this.logger = container.get<Logger>('logger');
    this.events = container.get<EventBus>('events');
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
   * Hold funds in escrow
   *
   * @param transactionId - Transaction to hold
   * @param options - Hold options
   * @returns Updated transaction
   */
  async hold(
    transactionId: string,
    options: HoldOptions = {}
  ): Promise<TransactionDocument> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'escrow.hold.before',
      this.getPluginContext(),
      { transactionId, ...options },
      async () => {
        const {
          reason = HOLD_REASON.PAYMENT_VERIFICATION,
          holdUntil = null,
          metadata = {},
        } = options;

        const TransactionModel = this.models.Transaction;
        const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (transaction.status !== TRANSACTION_STATUS.VERIFIED) {
      throw new InvalidStateTransitionError(
        'transaction',
        transaction._id.toString(),
        transaction.status,
        TRANSACTION_STATUS.VERIFIED
      );
    }

    // Calculate held amount (base amount only, tax is tracked separately in transaction.tax)
    const heldAmount = transaction.amount;

    transaction.hold = {
      status: HOLD_STATUS.HELD,
      heldAmount,
      releasedAmount: 0,
      reason,
      heldAt: new Date(),
      ...(holdUntil && { holdUntil }),
      releases: [],
      metadata,
    };

        await transaction.save();

        this.events.emit('escrow.held', {
          transaction,
          heldAmount,
          reason,
        });

        // Execute after hooks
        return this.plugins.executeHook(
          'escrow.hold.after',
          this.getPluginContext(),
          { transactionId, ...options },
          async () => transaction
        );
      }
    );
  }

  /**
   * Release funds from escrow to recipient
   *
   * @param transactionId - Transaction to release
   * @param options - Release options
   * @returns { transaction, releaseTransaction }
   */
  async release(
    transactionId: string,
    options: ReleaseOptions
  ): Promise<ReleaseResult> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'escrow.release.before',
      this.getPluginContext(),
      { transactionId, ...options },
      async () => {
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
        const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new InvalidStateTransitionError(
        'escrow_hold',
        transaction._id.toString(),
        transaction.hold?.status ?? 'none',
        HOLD_STATUS.HELD
      );
    }

    if (!recipientId) {
      throw new ValidationError('recipientId is required for release', { transactionId });
    }

    const releaseAmount = amount ?? (transaction.hold.heldAmount - transaction.hold.releasedAmount);
    const availableAmount = transaction.hold.heldAmount - transaction.hold.releasedAmount;

    if (releaseAmount > availableAmount) {
      throw new ValidationError(
        `Release amount (${releaseAmount}) exceeds available held amount (${availableAmount})`,
        { releaseAmount, availableAmount, transactionId }
      );
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
      // Validate hold state transition and create audit event
      const holdAuditEvent = HOLD_STATE_MACHINE.validateAndCreateAuditEvent(
        transaction.hold.status,
        HOLD_STATUS.RELEASED,
        transaction._id.toString(),
        {
          changedBy: releasedBy ?? 'system',
          reason: `Escrow hold fully released: ${releaseAmount} to ${recipientId}${reason ? ' - ' + reason : ''}`,
          metadata: { releaseAmount, recipientId, releaseReason: reason }
        }
      );

      transaction.hold.status = HOLD_STATUS.RELEASED;
      transaction.hold.releasedAt = new Date();

      // Validate transaction state transition and create audit event
      const transactionAuditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
        transaction.status,
        TRANSACTION_STATUS.COMPLETED,
        transaction._id.toString(),
        {
          changedBy: releasedBy ?? 'system',
          reason: `Transaction completed after full escrow release`,
          metadata: { releaseAmount, recipientId }
        }
      );

      transaction.status = TRANSACTION_STATUS.COMPLETED;

      // Append both audit events to metadata
      Object.assign(transaction, appendAuditEvent(transaction, holdAuditEvent));
      Object.assign(transaction, appendAuditEvent(transaction, transactionAuditEvent));
    } else if (isPartialRelease) {
      // Validate hold state transition and create audit event
      const auditEvent = HOLD_STATE_MACHINE.validateAndCreateAuditEvent(
        transaction.hold.status,
        HOLD_STATUS.PARTIALLY_RELEASED,
        transaction._id.toString(),
        {
          changedBy: releasedBy ?? 'system',
          reason: `Partial escrow release: ${releaseAmount} of ${transaction.hold.heldAmount} to ${recipientId}${reason ? ' - ' + reason : ''}`,
          metadata: {
            releaseAmount,
            recipientId,
            releaseReason: reason,
            remainingHeld: transaction.hold.heldAmount - transaction.hold.releasedAmount
          }
        }
      );

      transaction.hold.status = HOLD_STATUS.PARTIALLY_RELEASED;

      // Append audit event to metadata
      Object.assign(transaction, appendAuditEvent(transaction, auditEvent));
    }

    if ('markModified' in transaction) {
      (transaction as { markModified: (path: string) => void }).markModified('hold');
    }

    await transaction.save();

    // ✅ UNIFIED TRANSACTION: Calculate proportional tax for release
    let releaseTaxAmount = 0;

    if (transaction.tax && transaction.tax > 0) {
      // Calculate tax for release
      // Check if this is a full release (releaseAmount equals available held amount)
      if (releaseAmount === availableAmount && !amount) {
        // Full release - release all remaining tax
        const releasedTaxSoFar = transaction.hold.releasedTaxAmount ?? 0;
        releaseTaxAmount = transaction.tax - releasedTaxSoFar;
      } else {
        // Partial release - releaseAmount includes both base + tax
        // Extract tax proportionally from total release amount
        const totalAmount = transaction.amount + transaction.tax;
        if (totalAmount > 0) {
          const taxRatio = transaction.tax / totalAmount;
          releaseTaxAmount = Math.round(releaseAmount * taxRatio);
        }
      }
    }

    // Calculate net (no gateway fees on escrow releases)
    const releaseNetAmount = releaseAmount - releaseTaxAmount;

    let releaseTransaction: TransactionDocument | null = null;
    if (createTransaction) {
      releaseTransaction = await TransactionModel.create({
        organizationId: transaction.organizationId,
        customerId: recipientId,

        // ✅ UNIFIED: Use 'escrow_release' as type, inflow
        type: 'escrow_release',
        flow: 'inflow',
        tags: ['escrow', 'release'],

        // ✅ UNIFIED: Amount structure
        amount: releaseAmount,
        currency: transaction.currency,
        fee: 0, // No processing fees on releases
        tax: releaseTaxAmount, // ✅ Top-level number
        net: releaseNetAmount,

        // Copy tax details from original transaction
        ...(transaction.taxDetails && {
          taxDetails: transaction.taxDetails
        }),

        method: transaction.method,
        status: 'completed',
        gateway: transaction.gateway,

        // ✅ UNIFIED: Source reference (link to held transaction)
        sourceId: transaction._id,
        sourceModel: 'Transaction',
        relatedTransactionId: transaction._id,

        metadata: {
          ...metadata,
          isRelease: true,
          heldTransactionId: transaction._id.toString(),
          releaseReason: reason,
          recipientType,
          // Store original category for reference
          originalCategory: transaction.category,
        },
        idempotencyKey: `release_${transaction._id}_${Date.now()}`,
      }) as TransactionDocument;
    }

        this.events.emit('escrow.released', {
          transaction,
          releaseTransaction,
          releaseAmount,
          recipientId,
          recipientType,
          reason,
          isFullRelease,
          isPartialRelease,
        });

        const result = {
          transaction,
          releaseTransaction,
          releaseAmount,
          isFullRelease,
          isPartialRelease,
        };

        // Execute after hooks
        return this.plugins.executeHook(
          'escrow.release.after',
          this.getPluginContext(),
          { transactionId, ...options },
          async () => result
        );
      }
    );
  }

  /**
   * Cancel hold and release back to customer
   *
   * @param transactionId - Transaction to cancel hold
   * @param options - Cancel options
   * @returns Updated transaction
   */
  async cancel(
    transactionId: string,
    options: CancelHoldOptions = {}
  ): Promise<TransactionDocument> {
    const { reason = 'Hold cancelled', metadata = {} } = options;

    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new InvalidStateTransitionError(
        'escrow_hold',
        transaction._id.toString(),
        transaction.hold?.status ?? 'none',
        HOLD_STATUS.HELD
      );
    }

    // Validate hold state transition and create audit event
    const holdAuditEvent = HOLD_STATE_MACHINE.validateAndCreateAuditEvent(
      transaction.hold.status,
      HOLD_STATUS.CANCELLED,
      transaction._id.toString(),
      {
        changedBy: 'system',
        reason: `Escrow hold cancelled${reason ? ': ' + reason : ''}`,
        metadata: { cancelReason: reason, ...metadata }
      }
    );

    transaction.hold.status = HOLD_STATUS.CANCELLED;
    transaction.hold.cancelledAt = new Date();
    transaction.hold.metadata = {
      ...transaction.hold.metadata,
      ...metadata,
      cancelReason: reason,
    };

    // Validate transaction state transition and create audit event
    const transactionAuditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
      transaction.status,
      TRANSACTION_STATUS.CANCELLED,
      transaction._id.toString(),
      {
        changedBy: 'system',
        reason: `Transaction cancelled due to escrow hold cancellation`,
        metadata: { cancelReason: reason }
      }
    );

    transaction.status = TRANSACTION_STATUS.CANCELLED;

    // Append both audit events to metadata
    Object.assign(transaction, appendAuditEvent(transaction, holdAuditEvent));
    Object.assign(transaction, appendAuditEvent(transaction, transactionAuditEvent));

    if ('markModified' in transaction) {
      (transaction as { markModified: (path: string) => void }).markModified('hold');
    }

    await transaction.save();

    this.events.emit('escrow.cancelled', {
      transaction,
      reason,
    });

    return transaction;
  }

  /**
   * Split payment to multiple recipients
   * Deducts splits from held amount and releases remainder to organization
   *
   * @param transactionId - Transaction to split
   * @param splitRules - Split configuration
   * @returns { transaction, splitTransactions, organizationTransaction }
   */
  async split(
    transactionId: string,
    splitRules: SplitRule[] = []
  ): Promise<SplitResult> {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    if (!transaction.hold || transaction.hold.status !== HOLD_STATUS.HELD) {
      throw new InvalidStateTransitionError(
        'escrow_hold',
        transaction._id.toString(),
        transaction.hold?.status ?? 'none',
        HOLD_STATUS.HELD
      );
    }

    if (!splitRules || splitRules.length === 0) {
      throw new ValidationError('splitRules cannot be empty', { transactionId });
    }

    const splits = calculateSplits(
      transaction.amount,
      splitRules,
      transaction.commission?.gatewayFeeRate ?? 0
    );

    transaction.splits = splits;
    await transaction.save();

    const splitTransactions: TransactionDocument[] = [];
    const totalTax = transaction.tax ?? 0;
    const totalBaseAmount = transaction.amount;
    let allocatedTaxAmount = 0;
    const splitTaxAmounts = splits.map((split) => {
      if (!totalTax || totalBaseAmount <= 0) {
        return 0;
      }
      const ratio = split.grossAmount / totalBaseAmount;
      const taxAmount = Math.round(totalTax * ratio);
      allocatedTaxAmount += taxAmount;
      return taxAmount;
    });

    for (const [index, split] of splits.entries()) {
      // ✅ UNIFIED: Tax amount as number (proportional to split)
      const splitTaxAmount = totalTax > 0 ? splitTaxAmounts[index] ?? 0 : 0;

      // ✅ UNIFIED: Calculate net = gross - fee - tax
      const splitNetAmount = split.grossAmount - split.gatewayFeeAmount - splitTaxAmount;

      const splitTransaction = await TransactionModel.create({
        organizationId: transaction.organizationId,
        customerId: split.recipientId,

        // ✅ UNIFIED: Use split type directly (commission, platform_fee, etc.)
        type: split.type,
        flow: 'outflow', // Splits are money going out
        tags: ['split', 'commission'],

        // ✅ UNIFIED: Amount structure (gross, fee, tax, net)
        amount: split.grossAmount, // ✅ Gross amount (before deductions)
        currency: transaction.currency,
        fee: split.gatewayFeeAmount,
        tax: splitTaxAmount, // ✅ Top-level number
        net: splitNetAmount, // ✅ Net = gross - fee - tax

        // Copy tax details from original transaction (if applicable)
        ...(transaction.taxDetails && splitTaxAmount > 0 && {
          taxDetails: transaction.taxDetails
        }),

        method: transaction.method,
        status: 'completed',
        gateway: transaction.gateway,

        // ✅ UNIFIED: Source reference (link to original transaction)
        sourceId: transaction._id,
        sourceModel: 'Transaction',
        relatedTransactionId: transaction._id,

        metadata: {
          isSplit: true,
          splitType: split.type,
          recipientType: split.recipientType,
          originalTransactionId: transaction._id.toString(),
          // Store split details for reference
          splitGrossAmount: split.grossAmount,
          splitNetAmount: split.netAmount, // Original calculation
          gatewayFeeAmount: split.gatewayFeeAmount,
        },
        idempotencyKey: `split_${transaction._id}_${split.recipientId}_${Date.now()}`,
      }) as TransactionDocument;

      (split as SplitInfo & { payoutTransactionId?: string }).payoutTransactionId = splitTransaction._id.toString();
      split.status = SPLIT_STATUS.PAID;
      (split as SplitInfo & { paidDate?: Date }).paidDate = new Date();

      splitTransactions.push(splitTransaction);
    }

    await transaction.save();

    const organizationPayout = calculateOrganizationPayout(transaction.amount, splits);
    const organizationTaxAmount = totalTax > 0
      ? Math.max(0, totalTax - allocatedTaxAmount)
      : 0;
    const organizationPayoutTotal = totalTax > 0
      ? organizationPayout + organizationTaxAmount
      : organizationPayout;

    const organizationTransaction = await this.release(transactionId, {
      amount: organizationPayoutTotal,
      recipientId: transaction.organizationId?.toString() ?? '',
      recipientType: 'organization',
      reason: RELEASE_REASON.PAYMENT_VERIFIED,
      createTransaction: true,
      metadata: {
        afterSplits: true,
        totalSplits: splits.length,
        totalSplitAmount: transaction.amount - organizationPayout,
      },
    });

    this.events.emit('escrow.split', {
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
   * @param transactionId - Transaction ID
   * @returns Escrow status
   */
  async getStatus(transactionId: string): Promise<EscrowStatusResult> {
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.findById(transactionId) as TransactionDocument | null;

    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }

    return {
      transaction,
      hold: transaction.hold ?? null,
      splits: transaction.splits ?? [],
      hasHold: !!transaction.hold,
      hasSplits: transaction.splits ? transaction.splits.length > 0 : false,
    };
  }

}

export default EscrowService;
