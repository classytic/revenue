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
  ProviderError,
  AlreadyVerifiedError,
  PaymentVerificationError,
  RefundNotSupportedError,
  RefundError,
  ProviderCapabilityError,
  ValidationError,
  InvalidStateTransitionError,
} from '../../core/errors.js';
import { reverseCommission } from '../../shared/utils/calculators/commission.js';
import { TRANSACTION_FLOW } from '../../enums/transaction.enums.js';
import { TRANSACTION_STATE_MACHINE } from '../../core/state-machine/index.js';
import { appendAuditEvent } from '../../infrastructure/audit/index.js';
import { retry, type RetryConfig, type CircuitBreaker } from '../../shared/utils/resilience/retry.js';
import { nanoid } from 'nanoid';
import type { Container } from '../../core/container.js';
import type { EventBus } from '../../core/events.js';
import type { PluginManager, PluginContext } from '../../core/plugin.js';
import type {
  ModelsRegistry,
  ProvidersRegistry,
  RevenueConfig,
  Logger,
  TransactionDocument,
  PaymentVerifyOptions,
  PaymentVerifyResult,
  PaymentStatusResult,
  RefundOptions,
  PaymentRefundResult,
  WebhookResult,
  ListOptions,
  PaymentResultData,
  PaymentProviderInterface,
  TransactionFlowValue,
  MongooseModel,
} from '../../shared/types/index.js';

/**
 * Payment Service
 * Uses DI container for all dependencies
 *
 * Architecture:
 * - PluginManager: Wraps operations with lifecycle hooks (before/after)
 * - EventBus: Fire-and-forget notifications for completed operations
 */
export class PaymentService {
  private readonly models: ModelsRegistry;
  private readonly providers: ProvidersRegistry;
  private readonly config: RevenueConfig;
  private readonly plugins: PluginManager;
  private readonly logger: Logger;
  private readonly events: EventBus;
  private readonly retryConfig: Partial<RetryConfig>;
  private readonly circuitBreaker: CircuitBreaker | null;

  constructor(container: Container) {
    this.models = container.get<ModelsRegistry>('models');
    this.providers = container.get<ProvidersRegistry>('providers');
    this.config = container.get<RevenueConfig>('config');
    this.plugins = container.get<PluginManager>('plugins');
    this.logger = container.get<Logger>('logger');
    this.events = container.get<EventBus>('events');
    this.retryConfig = container.get<Partial<RetryConfig>>('retryConfig');
    this.circuitBreaker = container.get<CircuitBreaker | null>('circuitBreaker');
  }

  /**
   * Create plugin context for hook execution
   * @private
   */
  private getPluginContext(idempotencyKey?: string): PluginContext {
    return {
      events: this.events,
      logger: this.logger,
      storage: new Map(),
      meta: {
        idempotencyKey,
        requestId: nanoid(),
        timestamp: new Date(),
      },
    };
  }

  /**
   * Execute provider call with retry and circuit breaker protection
   * @private
   */
  private async executeProviderCall<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    // Wrap with circuit breaker if configured
    const withCircuitBreaker = this.circuitBreaker
      ? () => this.circuitBreaker!.execute(operation)
      : operation;

    // Wrap with retry if configured
    if (this.retryConfig && Object.keys(this.retryConfig).length > 0) {
      return retry(withCircuitBreaker, {
        ...this.retryConfig,
        onRetry: (error, attempt, delay) => {
          this.logger.warn(
            `[${operationName}] Retry attempt ${attempt} after ${delay}ms:`,
            error
          );
          this.retryConfig.onRetry?.(error, attempt, delay);
        },
      });
    }

    return withCircuitBreaker();
  }

  /**
   * Verify a payment
   *
   * @param paymentIntentId - Payment intent ID, session ID, or transaction ID
   * @param options - Verification options
   * @returns { transaction, status }
   */
  async verify(
    paymentIntentId: string,
    options: PaymentVerifyOptions = {}
  ): Promise<PaymentVerifyResult> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'payment.verify.before',
      this.getPluginContext(),
      { id: paymentIntentId, ...options },
      async () => {
        const { verifiedBy = null } = options;

        const TransactionModel = this.models.Transaction;
        const transaction = await this._findTransaction(TransactionModel, paymentIntentId);

        if (!transaction) {
          throw new TransactionNotFoundError(paymentIntentId);
        }

        if (transaction.status === 'verified' || transaction.status === 'completed') {
          throw new AlreadyVerifiedError(transaction._id.toString());
        }

        // Get provider for verification
        const gatewayType = transaction.gateway?.type ?? 'manual';
        const provider = this.providers[gatewayType];

        if (!provider) {
          throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
        }

        // Verify payment with provider
        let paymentResult: PaymentResultData | null = null;
        try {
          const actualIntentId = transaction.gateway?.paymentIntentId || transaction.gateway?.sessionId || paymentIntentId;
          paymentResult = await this.executeProviderCall(
            () => provider.verifyPayment(actualIntentId),
            `${gatewayType}.verifyPayment`
          );
        } catch (error) {
          this.logger.error('Payment verification failed:', error);

          const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
            transaction.status,
            'failed',
            transaction._id.toString(),
            {
              changedBy: 'system',
              reason: `Payment verification failed: ${(error as Error).message}`,
              metadata: { error: (error as Error).message }
            }
          );

          transaction.status = 'failed';
          transaction.failureReason = (error as Error).message;
          Object.assign(transaction, appendAuditEvent(transaction, auditEvent));
          transaction.metadata = {
            ...transaction.metadata,
            verificationError: (error as Error).message,
            failedAt: new Date().toISOString(),
          };
          await transaction.save();

          this.events.emit('payment.failed', {
            transaction,
            error: (error as Error).message,
            provider: gatewayType,
            paymentIntentId,
          });

          throw new PaymentVerificationError(paymentIntentId, (error as Error).message);
        }

        // Validate amount and currency match
        if (paymentResult.amount && paymentResult.amount !== transaction.amount) {
          throw new ValidationError(
            `Amount mismatch: expected ${transaction.amount}, got ${paymentResult.amount}`,
            { expected: transaction.amount, actual: paymentResult.amount }
          );
        }

        if (paymentResult.currency && paymentResult.currency.toUpperCase() !== transaction.currency.toUpperCase()) {
          throw new ValidationError(
            `Currency mismatch: expected ${transaction.currency}, got ${paymentResult.currency}`,
            { expected: transaction.currency, actual: paymentResult.currency }
          );
        }

        // Update transaction based on verification result
        const newStatus = paymentResult.status === 'succeeded' ? 'verified' : paymentResult.status;

        const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
          transaction.status,
          newStatus,
          transaction._id.toString(),
          {
            changedBy: verifiedBy ?? 'system',
            reason: `Payment verification ${paymentResult.status === 'succeeded' ? 'succeeded' : 'resulted in status: ' + newStatus}`,
            metadata: { paymentResult: paymentResult.metadata }
          }
        );

        transaction.status = newStatus;
        transaction.verifiedAt = paymentResult.paidAt ?? new Date();
        transaction.verifiedBy = verifiedBy;
        transaction.gateway = {
          ...transaction.gateway,
          type: transaction.gateway?.type ?? 'manual',
          verificationData: paymentResult.metadata,
        };
        Object.assign(transaction, appendAuditEvent(transaction, auditEvent));
        await transaction.save();

        // Emit appropriate event based on actual status
        if (newStatus === 'verified') {
          this.events.emit('payment.verified', {
            transaction,
            paymentResult,
            verifiedBy: verifiedBy || undefined,
          });
        } else if (newStatus === 'failed') {
          this.events.emit('payment.failed', {
            transaction,
            error: paymentResult.metadata?.errorMessage as string || 'Payment verification failed',
            provider: gatewayType,
            paymentIntentId: transaction.gateway?.paymentIntentId || transaction.gateway?.sessionId || paymentIntentId,
          });
        } else if (newStatus === 'requires_action') {
          this.events.emit('payment.requires_action', {
            transaction,
            paymentResult,
            action: paymentResult.metadata?.requiredAction as string | Record<string, unknown> | undefined,
          });
        } else if (newStatus === 'processing') {
          this.events.emit('payment.processing', {
            transaction,
            paymentResult,
          });
        }

        const result = {
          transaction,
          paymentResult,
          status: transaction.status,
        };

        // Execute after hooks
        return this.plugins.executeHook(
          'payment.verify.after',
          this.getPluginContext(),
          { id: paymentIntentId, ...options },
          async () => result
        );
      }
    );
  }

  /**
   * Get payment status
   *
   * @param paymentIntentId - Payment intent ID, session ID, or transaction ID
   * @returns { transaction, status }
   */
  async getStatus(paymentIntentId: string): Promise<PaymentStatusResult> {
    const TransactionModel = this.models.Transaction;
    const transaction = await this._findTransaction(TransactionModel, paymentIntentId);

    if (!transaction) {
      throw new TransactionNotFoundError(paymentIntentId);
    }

    // Get provider
    const gatewayType = transaction.gateway?.type ?? 'manual';
    const provider = this.providers[gatewayType];

    if (!provider) {
      throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
    }

    // Get status from provider
    let paymentResult: PaymentResultData | null = null;
    try {
      // Use the actual payment intent ID from the transaction's gateway info
      const actualIntentId = transaction.gateway?.paymentIntentId || transaction.gateway?.sessionId || paymentIntentId;
      paymentResult = await this.executeProviderCall(
        () => provider.getStatus(actualIntentId),
        `${gatewayType}.getStatus`
      );
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
   * @param paymentId - Payment intent ID, session ID, or transaction ID
   * @param amount - Amount to refund (optional, full refund if not provided)
   * @param options - Refund options
   * @returns { transaction, refundResult }
   */
  async refund(
    paymentId: string,
    amount: number | null = null,
    options: RefundOptions = {}
  ): Promise<PaymentRefundResult> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'payment.refund.before',
      this.getPluginContext(),
      { transactionId: paymentId, amount, ...options },
      async () => {
        const { reason = null } = options;

        const TransactionModel = this.models.Transaction;
        const transaction = await this._findTransaction(TransactionModel, paymentId);

        if (!transaction) {
          throw new TransactionNotFoundError(paymentId);
        }

        if (
          transaction.status !== 'verified' &&
          transaction.status !== 'completed' &&
          transaction.status !== 'partially_refunded'
        ) {
          throw new InvalidStateTransitionError(
            'transaction',
            transaction._id.toString(),
            transaction.status,
            'verified, completed, or partially_refunded'
          );
        }

        // Get provider
        const gatewayType = transaction.gateway?.type ?? 'manual';
        const provider = this.providers[gatewayType];

        if (!provider) {
          throw new ProviderNotFoundError(gatewayType, Object.keys(this.providers));
        }

        // Check if provider supports refunds
        const capabilities = provider.getCapabilities();
        if (!capabilities.supportsRefunds) {
          throw new RefundNotSupportedError(gatewayType);
        }

        // Calculate refundable amount
        const refundedSoFar = transaction.refundedAmount ?? 0;
        const refundableAmount = transaction.amount - refundedSoFar;
        const refundAmount = amount ?? refundableAmount;

        if (refundAmount <= 0) {
          throw new ValidationError(`Refund amount must be positive, got ${refundAmount}`);
        }

        if (refundAmount > refundableAmount) {
          throw new ValidationError(
            `Refund amount (${refundAmount}) exceeds refundable balance (${refundableAmount})`,
            { refundAmount, refundableAmount, alreadyRefunded: refundedSoFar }
          );
        }

        // Refund via provider
        let refundResult;
        try {
          const actualIntentId = transaction.gateway?.paymentIntentId || transaction.gateway?.sessionId || paymentId;
          refundResult = await this.executeProviderCall(
            () => provider.refund(actualIntentId, refundAmount, { reason: reason ?? undefined }),
            `${gatewayType}.refund`
          );
        } catch (error) {
          this.logger.error('Refund failed:', error);
          throw new RefundError(paymentId, (error as Error).message);
        }

        // Create separate refund transaction for proper accounting
        const refundFlow: TransactionFlowValue =
          this.config.transactionTypeMapping?.refund ?? TRANSACTION_FLOW.OUTFLOW;

        const refundCommission = transaction.commission
          ? reverseCommission(transaction.commission, transaction.amount, refundAmount)
          : null;

        let refundTaxAmount = 0;
        if (transaction.tax && transaction.tax > 0 && transaction.amount > 0) {
          const ratio = refundAmount / transaction.amount;
          refundTaxAmount = Math.round(transaction.tax * ratio);
        }

        const refundFeeAmount = refundCommission?.gatewayFeeAmount || 0;
        const refundNetAmount = refundAmount - refundFeeAmount - refundTaxAmount;

        const refundTransaction = await TransactionModel.create({
          organizationId: transaction.organizationId,
          customerId: transaction.customerId,
          type: 'refund',
          flow: refundFlow,
          tags: ['refund'],
          amount: refundAmount,
          currency: transaction.currency,
          fee: refundFeeAmount,
          tax: refundTaxAmount,
          net: refundNetAmount,
          ...(transaction.taxDetails && { taxDetails: transaction.taxDetails }),
          method: transaction.method ?? 'manual',
          status: 'completed',
          gateway: {
            provider: transaction.gateway?.provider ?? 'manual',
            paymentIntentId: refundResult.id,
            chargeId: refundResult.id,
          },
          paymentDetails: transaction.paymentDetails,
          ...(refundCommission && { commission: refundCommission }),
          ...(transaction.sourceId && { sourceId: transaction.sourceId }),
          ...(transaction.sourceModel && { sourceModel: transaction.sourceModel }),
          relatedTransactionId: transaction._id,
          metadata: {
            ...transaction.metadata,
            isRefund: true,
            originalTransactionId: transaction._id.toString(),
            refundReason: reason,
            refundResult: refundResult.metadata,
          },
          idempotencyKey: `refund_${transaction._id}_${Date.now()}`,
        }) as TransactionDocument;

        // Update original transaction status
        const isPartialRefund = refundAmount < refundableAmount;
        const refundStatus = isPartialRefund ? 'partially_refunded' : 'refunded';

        const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
          transaction.status,
          refundStatus,
          transaction._id.toString(),
          {
            changedBy: 'system',
            reason: `Refund processed: ${isPartialRefund ? 'partial' : 'full'} refund of ${refundAmount}${reason ? ' - ' + reason : ''}`,
            metadata: {
              refundAmount,
              isPartialRefund,
              refundTransactionId: refundTransaction._id.toString()
            }
          }
        );

        transaction.status = refundStatus;
        transaction.refundedAmount = (transaction.refundedAmount ?? 0) + refundAmount;
        transaction.refundedAt = refundResult.refundedAt ?? new Date();
        Object.assign(transaction, appendAuditEvent(transaction, auditEvent));
        transaction.metadata = {
          ...transaction.metadata,
          refundTransactionId: refundTransaction._id.toString(),
          refundReason: reason,
        };
        await transaction.save();

        // Emit payment.refunded event
        this.events.emit('payment.refunded', {
          transaction,
          refundTransaction,
          refundResult: {
            ...refundResult,
            currency: refundResult.currency ?? 'USD',
            metadata: refundResult.metadata ?? {},
          },
          refundAmount,
          reason: reason ?? undefined,
          isPartialRefund,
        });

        const result = {
          transaction,
          refundTransaction,
          refundResult,
          status: transaction.status,
        };

        // Execute after hooks
        return this.plugins.executeHook(
          'payment.refund.after',
          this.getPluginContext(),
          { transactionId: paymentId, amount, ...options },
          async () => result
        );
      }
    );
  }

  /**
   * Handle webhook from payment provider
   *
   * @param provider - Provider name
   * @param payload - Webhook payload
   * @param headers - Request headers
   * @returns { event, transaction }
   */
  async handleWebhook(
    providerName: string,
    payload: unknown,
    headers: Record<string, string> = {}
  ): Promise<WebhookResult> {
    const provider = this.providers[providerName];

    if (!provider) {
      throw new ProviderNotFoundError(providerName, Object.keys(this.providers));
    }

    // Check if provider supports webhooks
    const capabilities = provider.getCapabilities();
    if (!capabilities.supportsWebhooks) {
      throw new ProviderCapabilityError(providerName, 'webhooks');
    }

    // Process webhook via provider
    let webhookEvent;
    try {
      webhookEvent = await this.executeProviderCall(
        () => provider.handleWebhook(payload, headers),
        `${providerName}.handleWebhook`
      );
    } catch (error) {
      this.logger.error('Webhook processing failed:', error);
      throw new ProviderError(
        `Webhook processing failed for ${providerName}: ${(error as Error).message}`,
        'WEBHOOK_PROCESSING_FAILED',
        { retryable: false }
      );
    }

    // Validate webhook event structure
    if (!webhookEvent?.data?.sessionId && !webhookEvent?.data?.paymentIntentId) {
      throw new ValidationError(
        `Invalid webhook event structure from ${providerName}: missing sessionId or paymentIntentId`,
        { provider: providerName, eventType: webhookEvent?.type }
      );
    }

    // Find transaction by sessionId first (for checkout flows), then paymentIntentId
    const TransactionModel = this.models.Transaction;
    let transaction: TransactionDocument | null = null;

    if (webhookEvent.data.sessionId) {
      transaction = await (TransactionModel as unknown as {
        findOne(filter: object): Promise<TransactionDocument | null>;
      }).findOne({
        'gateway.sessionId': webhookEvent.data.sessionId,
      });
    }

    if (!transaction && webhookEvent.data.paymentIntentId) {
      transaction = await (TransactionModel as unknown as {
        findOne(filter: object): Promise<TransactionDocument | null>;
      }).findOne({
        'gateway.paymentIntentId': webhookEvent.data.paymentIntentId,
      });
    }

    if (!transaction) {
      this.logger.warn('Transaction not found for webhook event', {
        provider: providerName,
        eventId: webhookEvent.id,
        sessionId: webhookEvent.data.sessionId,
        paymentIntentId: webhookEvent.data.paymentIntentId,
      });
      throw new TransactionNotFoundError(
        webhookEvent.data.sessionId ?? webhookEvent.data.paymentIntentId ?? 'unknown'
      );
    }

    // Update gateway with complete information from webhook
    if (webhookEvent.data.sessionId && !transaction.gateway?.sessionId) {
      transaction.gateway = {
        ...transaction.gateway,
        type: transaction.gateway?.type ?? 'manual',
        sessionId: webhookEvent.data.sessionId,
      };
    }
    if (webhookEvent.data.paymentIntentId && !transaction.gateway?.paymentIntentId) {
      transaction.gateway = {
        ...transaction.gateway,
        type: transaction.gateway?.type ?? 'manual',
        paymentIntentId: webhookEvent.data.paymentIntentId,
      };
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

    // Determine new status based on webhook type
    let newStatus = transaction.status;
    if (webhookEvent.type === 'payment.succeeded') {
      newStatus = 'verified';
    } else if (webhookEvent.type === 'payment.failed') {
      newStatus = 'failed';
    } else if (webhookEvent.type === 'refund.succeeded') {
      newStatus = 'refunded';
    }

    // Validate state transition and create audit event
    if (newStatus !== transaction.status) {
      const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
        transaction.status,
        newStatus,
        transaction._id.toString(),
        {
          changedBy: 'webhook',
          reason: `Webhook event: ${webhookEvent.type}`,
          metadata: {
            webhookId: webhookEvent.id,
            webhookType: webhookEvent.type,
            webhookData: webhookEvent.data,
          }
        }
      );

      transaction.status = newStatus;

      // Set appropriate timestamp fields
      if (newStatus === 'verified') {
        transaction.verifiedAt = webhookEvent.createdAt;
      } else if (newStatus === 'refunded') {
        transaction.refundedAt = webhookEvent.createdAt;
      } else if (newStatus === 'failed') {
        transaction.failedAt = webhookEvent.createdAt;
      }

      // Append audit event to metadata
      Object.assign(transaction, appendAuditEvent(transaction, auditEvent));

      // Note: We don't emit payment lifecycle events from webhooks because
      // webhookEvent.data doesn't contain all required fields (PaymentResult, RefundResult, etc.)
      // Consumers should listen to 'webhook.processed' if they need webhook-driven updates
    }

    await transaction.save();

    // Emit typed webhook event
    this.events.emit('webhook.processed', {
      webhookType: webhookEvent.type,
      provider: webhookEvent.provider,
      event: webhookEvent,
      transaction,
      processedAt: new Date(),
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
   * @param filters - Query filters
   * @param options - Query options (limit, skip, sort)
   * @returns Transactions
   */
  async list(
    filters: Record<string, unknown> = {},
    options: ListOptions = {}
  ): Promise<TransactionDocument[]> {
    const TransactionModel = this.models.Transaction;
    const { limit = 50, skip = 0, sort = { createdAt: -1 } } = options;

    const transactions = await (TransactionModel as unknown as {
      find(filter: object): { limit(n: number): { skip(n: number): { sort(s: object): Promise<TransactionDocument[]> } } };
    })
      .find(filters)
      .limit(limit)
      .skip(skip)
      .sort(sort);

    return transactions;
  }

  /**
   * Get payment/transaction by ID
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
   * Get provider instance
   *
   * @param providerName - Provider name
   * @returns Provider instance
   */
  getProvider(providerName: string): PaymentProviderInterface {
    const provider = this.providers[providerName];
    if (!provider) {
      throw new ProviderNotFoundError(providerName, Object.keys(this.providers));
    }
    return provider;
  }

  /**
   * Find transaction by sessionId, paymentIntentId, or transaction ID
   * @private
   */
  private async _findTransaction(
    TransactionModel: MongooseModel<TransactionDocument>,
    identifier: string
  ): Promise<TransactionDocument | null> {
    let transaction = await (TransactionModel as unknown as {
      findOne(filter: object): Promise<TransactionDocument | null>;
    }).findOne({
      'gateway.sessionId': identifier,
    });

    if (!transaction) {
      transaction = await (TransactionModel as unknown as {
        findOne(filter: object): Promise<TransactionDocument | null>;
      }).findOne({
        'gateway.paymentIntentId': identifier,
      });
    }

    if (!transaction) {
      transaction = await TransactionModel.findById(identifier) as TransactionDocument | null;
    }

    return transaction;
  }
}

export default PaymentService;
