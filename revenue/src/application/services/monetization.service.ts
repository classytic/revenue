/**
 * Monetization Service
 * @classytic/revenue
 *
 * Framework-agnostic monetization management service with DI
 * Handles purchases, subscriptions, and free items using provider system
 */

import { nanoid } from 'nanoid';
import {
  MissingRequiredFieldError,
  InvalidAmountError,
  ProviderNotFoundError,
  SubscriptionNotFoundError,
  ModelNotRegisteredError,
  SubscriptionNotActiveError,
  PaymentIntentCreationError,
  InvalidStateTransitionError,
} from '../../core/errors.js';
import { retry, type RetryConfig, type CircuitBreaker } from '../../shared/utils/resilience/retry.js';
import { resolveCategory } from '../../shared/utils/validators/category-resolver.js';
import { calculateCommission } from '../../shared/utils/calculators/commission.js';
import { getCommissionRate, getGatewayFeeRate } from '../../infrastructure/config/resolver.js';
import { MONETIZATION_TYPES } from '../../enums/monetization.enums.js';
import { TRANSACTION_FLOW } from '../../enums/transaction.enums.js';
import { SUBSCRIPTION_STATE_MACHINE } from '../../core/state-machine/index.js';
import { appendAuditEvent } from '../../infrastructure/audit/index.js';
import type { Container } from '../../core/container.js';
import type { EventBus } from '../../core/events.js';
import type { PluginManager, PluginContext } from '../../core/plugin.js';
import type {
  ModelsRegistry,
  ProvidersRegistry,
  RevenueConfig,
  Logger,
  MonetizationCreateParams,
  MonetizationCreateResult,
  ActivateOptions,
  RenewalParams,
  CancelOptions,
  PauseOptions,
  ResumeOptions,
  ListOptions,
  SubscriptionDocument,
  TransactionDocument,
  PaymentIntentData,
  TransactionFlowValue,
} from '../../shared/types/index.js';

/**
 * Monetization Service
 * Uses DI container for all dependencies
 *
 * Architecture:
 * - PluginManager: Wraps operations with lifecycle hooks (before/after)
 * - EventBus: Fire-and-forget notifications for completed operations
 */
export class MonetizationService {
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
  private getPluginContext(idempotencyKey?: string | null): PluginContext {
    return {
      events: this.events,
      logger: this.logger,
      storage: new Map(),
      meta: {
        idempotencyKey: idempotencyKey ?? undefined,
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
   * Create a new monetization (purchase, subscription, or free item)
   *
   * @param params - Monetization parameters
   *
   * @example
   * // One-time purchase
   * await revenue.monetization.create({
   *   data: {
   *     organizationId: '...',
   *     customerId: '...',
   *     sourceId: order._id,
   *     sourceModel: 'Order',
   *   },
   *   planKey: 'one_time',
   *   monetizationType: 'purchase',
   *   gateway: 'bkash',
   *   amount: 1500,
   * });
   *
   * // Recurring subscription
   * await revenue.monetization.create({
   *   data: {
   *     organizationId: '...',
   *     customerId: '...',
   *     sourceId: subscription._id,
   *     sourceModel: 'Subscription',
   *   },
   *   planKey: 'monthly',
   *   monetizationType: 'subscription',
   *   gateway: 'stripe',
   *   amount: 2000,
   * });
   *
   * @returns Result with subscription, transaction, and paymentIntent
   */
  async create(params: MonetizationCreateParams): Promise<MonetizationCreateResult> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'monetization.create.before',
      this.getPluginContext(params.idempotencyKey),
      params,
      async () => {
        const {
          data,
          planKey,
          amount,
          currency = 'BDT',
          gateway = 'manual',
          entity = null,
          monetizationType = MONETIZATION_TYPES.SUBSCRIPTION,
          paymentData,
          metadata = {},
          idempotencyKey = null,
        } = params;

        // Validate required fields
        // Note: organizationId is OPTIONAL (only needed for multi-tenant)

        if (!planKey) {
          throw new MissingRequiredFieldError('planKey');
        }

        if (amount < 0) {
          throw new InvalidAmountError(amount);
        }

        const isFree = amount === 0;

    // Get provider
    const provider = this.providers[gateway];
    if (!provider) {
      throw new ProviderNotFoundError(gateway, Object.keys(this.providers));
    }

    // Create payment intent if not free
    let paymentIntent: PaymentIntentData | null = null;
    let transaction: TransactionDocument | null = null;

    if (!isFree) {
      // Create payment intent via provider
      try {
        paymentIntent = await this.executeProviderCall(
          () => provider.createIntent({
            amount,
            currency,
            metadata: {
              ...metadata,
              type: 'subscription',
              planKey,
            },
          }),
          `${gateway}.createIntent`
        );
      } catch (error) {
        throw new PaymentIntentCreationError(gateway, error as Error);
      }

      // Resolve category based on entity and monetizationType
      const category = resolveCategory(entity, monetizationType, this.config.categoryMappings);

      // Resolve transaction type using config mapping or default to 'income'
      const transactionFlow: TransactionFlowValue =
        this.config.transactionTypeMapping?.[category] ??
        this.config.transactionTypeMapping?.[monetizationType] ??
        TRANSACTION_FLOW.INFLOW;

      // Calculate commission using global defaults with category/gateway-specific overrides
      const commissionRate = getCommissionRate(this.config, category);
      const gatewayFeeRate = getGatewayFeeRate(this.config, gateway);
      const commission = calculateCommission(amount, commissionRate, gatewayFeeRate);

      // Read tax if injected by tax plugin (clean, type-safe access)
      const tax = params.tax;

      // Create transaction record with unified fields
      const TransactionModel = this.models.Transaction;

      // Calculate amounts for unified structure
      // When tax is inclusive, amount should be the base amount (not the total)
      const baseAmount = tax?.pricesIncludeTax ? tax.baseAmount : amount;
      const feeAmount = commission?.gatewayFeeAmount || 0;
      const taxAmount = tax?.taxAmount || 0;
      const netAmount = baseAmount - feeAmount - taxAmount;

      transaction = await TransactionModel.create({
        organizationId: data.organizationId,
        customerId: data.customerId ?? null,

        // ✅ UNIFIED: Use category as type directly
        type: category,  // 'subscription', 'purchase', etc.
        flow: transactionFlow,  // ✅ Use config-driven transaction type

        // Auto-tagging (middleware will handle, but we can set explicitly)
        tags: category === 'subscription' ? ['recurring', 'subscription'] : [],

        // ✅ UNIFIED: Amount structure
        // When prices include tax, use baseAmount (tax already extracted)
        amount: baseAmount,
        currency,
        fee: feeAmount,
        tax: taxAmount,
        net: netAmount,

        // ✅ UNIFIED: Tax details (if tax plugin used)
        ...(tax && {
          taxDetails: {
            type: tax.type === 'collected' ? 'sales_tax' : (tax.type === 'paid' ? 'vat' : 'none'),
            rate: tax.rate || 0,
            isInclusive: tax.pricesIncludeTax || false,
          }
        }),

        method: ((paymentData as Record<string, unknown>)?.method as string) ?? 'manual',
        status: paymentIntent.status === 'succeeded' ? 'verified' : 'pending',  // ✅ Map 'succeeded' to valid TransactionStatusValue

        gateway: {
          type: gateway,  // Gateway/provider type (e.g., 'stripe', 'manual')
          provider: gateway,
          sessionId: paymentIntent.sessionId,
          paymentIntentId: paymentIntent.paymentIntentId,
          chargeId: paymentIntent.id,
          metadata: paymentIntent.metadata,
        },

        paymentDetails: {
          ...paymentData,
        },

        // Commission (for marketplace/splits)
        ...(commission && { commission }),

        // ✅ UNIFIED: Source reference (renamed from reference)
        ...(data.sourceId && { sourceId: data.sourceId }),
        ...(data.sourceModel && { sourceModel: data.sourceModel }),

        metadata: {
          ...metadata,
          planKey,
          entity,
          monetizationType,
          paymentIntentId: paymentIntent.id,
        },

        idempotencyKey: idempotencyKey ?? `sub_${nanoid(16)}`,
      }) as TransactionDocument;
    }

    // Create subscription record (if Subscription model exists)
    let subscription: SubscriptionDocument | null = null;
    if (this.models.Subscription) {
      const SubscriptionModel = this.models.Subscription;

      // Execute subscription.create hooks
      const result = await this.plugins.executeHook(
        'subscription.create.before',
        this.getPluginContext(idempotencyKey),
        {
          subscriptionId: undefined, // Not yet created - populated in after hook
          planKey,
          customerId: data.customerId,
          organizationId: data.organizationId,
          entity,
        },
        async () => {
          // Create subscription with proper reference tracking
          const subscriptionData = {
            organizationId: data.organizationId,
            customerId: data.customerId ?? null,
            planKey,
            amount,
            currency,
            status: isFree ? 'active' : 'pending',
            isActive: isFree,
            gateway,
            transactionId: transaction?._id ?? null,
            paymentIntentId: paymentIntent?.id ?? null,
            metadata: {
              ...metadata,
              isFree,
              entity,
              monetizationType,
            },
            ...data,
          } as Record<string, unknown>;

          // Remove sourceId/sourceModel from subscription (they're for transactions)
          delete subscriptionData.sourceId;
          delete subscriptionData.sourceModel;

          const sub = await SubscriptionModel.create(subscriptionData) as SubscriptionDocument;

          // Execute after hooks
          await this.plugins.executeHook(
            'subscription.create.after',
            this.getPluginContext(idempotencyKey),
            {
              subscriptionId: sub._id.toString(),
              planKey,
              customerId: data.customerId,
              organizationId: data.organizationId,
              entity,
            },
            async () => ({ subscription: sub, transaction })
          );

          return { subscription: sub, transaction };
        }
      );

      subscription = result.subscription;
    }

    // Emit general monetization.created event (catch-all)
    this.events.emit('monetization.created', {
      monetizationType,
      subscription: subscription ?? undefined,
      transaction: transaction ?? undefined,
      paymentIntent: paymentIntent ?? undefined,
    });

    // Emit specific event based on monetization type
    if (monetizationType === MONETIZATION_TYPES.PURCHASE) {
      // Purchase always requires a transaction
      if (transaction) {
        this.events.emit('purchase.created', {
          monetizationType,
          subscription: subscription ?? undefined,
          transaction,
          paymentIntent: paymentIntent ?? undefined,
        });
      }
    } else if (monetizationType === MONETIZATION_TYPES.SUBSCRIPTION) {
      // Subscription event requires subscription to exist
      if (subscription) {
        this.events.emit('subscription.created', {
          subscriptionId: subscription._id.toString(),
          subscription,
          transactionId: transaction?._id?.toString(),
        });
      }
    } else if (monetizationType === MONETIZATION_TYPES.FREE) {
      // Free can emit even without transaction (amount === 0)
      this.events.emit('free.created', {
        monetizationType,
        subscription: subscription ?? undefined,
        transaction: transaction ?? undefined,
        paymentIntent: paymentIntent ?? undefined,
      });
    }

    const result = {
      subscription,
      transaction,
      paymentIntent,
    };

    // Execute after hooks
    return this.plugins.executeHook(
      'monetization.create.after',
      this.getPluginContext(params.idempotencyKey),
      params,
      async () => result
    );
      }
    );
  }

  /**
   * Activate subscription after payment verification
   *
   * @param subscriptionId - Subscription ID or transaction ID
   * @param options - Activation options
   * @returns Updated subscription
   */
  async activate(
    subscriptionId: string,
    options: ActivateOptions = {}
  ): Promise<SubscriptionDocument> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'subscription.activate.before',
      this.getPluginContext(),
      { subscriptionId, ...options },
      async () => {
        const { timestamp = new Date() } = options;

        if (!this.models.Subscription) {
          throw new ModelNotRegisteredError('Subscription');
        }

        const SubscriptionModel = this.models.Subscription;
        const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

        if (!subscription) {
          throw new SubscriptionNotFoundError(subscriptionId);
        }

        if (subscription.isActive) {
          this.logger.warn('Subscription already active', { subscriptionId });
          return subscription;
        }

        // Calculate period dates based on plan
        const periodEnd = this._calculatePeriodEnd(subscription.planKey, timestamp);

        // Validate state transition and create audit event
        const auditEvent = SUBSCRIPTION_STATE_MACHINE.validateAndCreateAuditEvent(
          subscription.status,
          'active',
          subscription._id.toString(),
          {
            changedBy: 'system',
            reason: `Subscription activated for plan: ${subscription.planKey}`,
            metadata: { planKey: subscription.planKey, startDate: timestamp, endDate: periodEnd }
          }
        );

        // Update subscription
        subscription.isActive = true;
        subscription.status = 'active';
        subscription.startDate = timestamp;
        subscription.endDate = periodEnd;
        subscription.activatedAt = timestamp;

        // Append audit event to metadata
        Object.assign(subscription, appendAuditEvent(subscription, auditEvent));

        await subscription.save();

        // Emit event
        this.events.emit('subscription.activated', {
          subscription,
          activatedAt: timestamp,
        });

        // Execute after hooks
        return this.plugins.executeHook(
          'subscription.activate.after',
          this.getPluginContext(),
          { subscriptionId, ...options },
          async () => subscription
        );
      }
    );
  }

  /**
   * Renew subscription
   *
   * @param subscriptionId - Subscription ID
   * @param params - Renewal parameters
   * @returns { subscription, transaction, paymentIntent }
   */
  async renew(
    subscriptionId: string,
    params: RenewalParams = {}
  ): Promise<MonetizationCreateResult> {
    const {
      gateway = 'manual',
      entity = null,
      paymentData,
      metadata = {},
      idempotencyKey = null,
    } = params;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    if (subscription.amount === 0) {
      throw new InvalidAmountError(0, 'Free subscriptions do not require renewal');
    }

    // Get provider
    const provider = this.providers[gateway];
    if (!provider) {
      throw new ProviderNotFoundError(gateway, Object.keys(this.providers));
    }

    // Create payment intent
    let paymentIntent: PaymentIntentData | null = null;
    try {
      paymentIntent = await provider.createIntent({
        amount: subscription.amount,
        currency: subscription.currency ?? 'BDT',
        metadata: {
          ...metadata,
          type: 'subscription_renewal',
          subscriptionId: subscription._id.toString(),
        },
      });
    } catch (error) {
      this.logger.error('Failed to create payment intent for renewal:', error);
      throw new PaymentIntentCreationError(gateway, error as Error);
    }

    // Resolve category - use provided entity or inherit from subscription metadata
    const effectiveEntity = entity ?? (subscription.metadata as Record<string, unknown>)?.entity as string | null;
    const effectiveMonetizationType = 
      ((subscription.metadata as Record<string, unknown>)?.monetizationType as string) ?? MONETIZATION_TYPES.SUBSCRIPTION;
    const category = resolveCategory(effectiveEntity, effectiveMonetizationType as 'subscription' | 'purchase' | 'free', this.config.categoryMappings);

    // Resolve transaction type using config mapping or default to 'income'
    const transactionFlow: TransactionFlowValue =
      this.config.transactionTypeMapping?.[category] ??
      this.config.transactionTypeMapping?.subscription_renewal ??
      this.config.transactionTypeMapping?.[effectiveMonetizationType] ??
      TRANSACTION_FLOW.INFLOW;

    // Calculate commission using global defaults with category/gateway-specific overrides
    const commissionRate = getCommissionRate(this.config, category);
    const gatewayFeeRate = getGatewayFeeRate(this.config, gateway);
    const commission = calculateCommission(subscription.amount, commissionRate, gatewayFeeRate);

    // Calculate amounts for unified structure
    const feeAmount = commission?.gatewayFeeAmount || 0;
    const netAmount = subscription.amount - feeAmount;

    // Create transaction with unified fields
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.create({
      organizationId: subscription.organizationId,
      customerId: subscription.customerId,

      // ✅ UNIFIED: Use category as type directly
      type: category,  // 'subscription', etc.
      flow: transactionFlow,  // ✅ Use config-driven transaction type
      tags: ['recurring', 'subscription', 'renewal'],

      // ✅ UNIFIED: Amount structure
      amount: subscription.amount,
      currency: subscription.currency ?? 'BDT',
      fee: feeAmount,
      tax: 0,  // Tax plugin would add this
      net: netAmount,

      method: ((paymentData as Record<string, unknown>)?.method as string) ?? 'manual',
      status: paymentIntent.status === 'succeeded' ? 'verified' : 'pending',  // ✅ Map 'succeeded' to valid TransactionStatusValue

      gateway: {
        provider: gateway,
        sessionId: paymentIntent.sessionId,
        paymentIntentId: paymentIntent.paymentIntentId,
        chargeId: paymentIntent.id,
        metadata: paymentIntent.metadata,
      },
      paymentDetails: {
        provider: gateway,
        ...paymentData,
      },
      // Commission (for marketplace/splits)
      ...(commission && { commission }),

      // ✅ UNIFIED: Source reference (renamed from reference)
      sourceId: subscription._id,
      sourceModel: 'Subscription',
      metadata: {
        ...metadata,
        subscriptionId: subscription._id.toString(), // Keep for backward compat
        entity: effectiveEntity,
        monetizationType: effectiveMonetizationType,
        isRenewal: true,
        paymentIntentId: paymentIntent.id,
      },
      idempotencyKey: idempotencyKey ?? `renewal_${nanoid(16)}`,
    }) as TransactionDocument;

    // Update subscription
    subscription.status = 'pending_renewal' as SubscriptionDocument['status'];
    subscription.renewalTransactionId = transaction._id;
    subscription.renewalCount = (subscription.renewalCount ?? 0) + 1;
    await subscription.save();

    // Emit event
    this.events.emit('subscription.renewed', {
      subscription,
      transaction,
      paymentIntent: paymentIntent ?? undefined,
      renewalCount: subscription.renewalCount,
    });

    return {
      subscription,
      transaction,
      paymentIntent,
    };
  }

  /**
   * Cancel subscription
   *
   * @param subscriptionId - Subscription ID
   * @param options - Cancellation options
   * @returns Updated subscription
   */
  async cancel(
    subscriptionId: string,
    options: CancelOptions = {}
  ): Promise<SubscriptionDocument> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'subscription.cancel.before',
      this.getPluginContext(),
      { subscriptionId, ...options },
      async () => {
        const { immediate = false, reason = null } = options;

        if (!this.models.Subscription) {
          throw new ModelNotRegisteredError('Subscription');
        }

        const SubscriptionModel = this.models.Subscription;
        const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

        if (!subscription) {
          throw new SubscriptionNotFoundError(subscriptionId);
        }

        const now = new Date();

        if (immediate) {
          // Validate state transition and create audit event
          const auditEvent = SUBSCRIPTION_STATE_MACHINE.validateAndCreateAuditEvent(
            subscription.status,
            'cancelled',
            subscription._id.toString(),
            {
              changedBy: 'system',
              reason: `Subscription cancelled immediately${reason ? ': ' + reason : ''}`,
              metadata: { cancellationReason: reason, immediate: true }
            }
          );

          subscription.isActive = false;
          subscription.status = 'cancelled';
          subscription.canceledAt = now;
          subscription.cancellationReason = reason;

          // Append audit event to metadata
          Object.assign(subscription, appendAuditEvent(subscription, auditEvent));
        } else {
          // Schedule cancellation at period end
          subscription.cancelAt = subscription.endDate ?? now;
          subscription.cancellationReason = reason;
        }

        await subscription.save();

        // Emit event
        this.events.emit('subscription.cancelled', {
          subscription,
          immediate,
          reason: reason ?? undefined,
          canceledAt: immediate ? now : subscription.cancelAt!,
        });

        // Execute after hooks
        return this.plugins.executeHook(
          'subscription.cancel.after',
          this.getPluginContext(),
          { subscriptionId, ...options },
          async () => subscription
        );
      }
    );
  }

  /**
   * Pause subscription
   *
   * @param subscriptionId - Subscription ID
   * @param options - Pause options
   * @returns Updated subscription
   */
  async pause(
    subscriptionId: string,
    options: PauseOptions = {}
  ): Promise<SubscriptionDocument> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'subscription.pause.before',
      this.getPluginContext(),
      { subscriptionId, ...options },
      async () => {
        const { reason = null } = options;

        if (!this.models.Subscription) {
          throw new ModelNotRegisteredError('Subscription');
        }

        const SubscriptionModel = this.models.Subscription;
        const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

        if (!subscription) {
          throw new SubscriptionNotFoundError(subscriptionId);
        }

        if (!subscription.isActive) {
          throw new SubscriptionNotActiveError(subscriptionId, 'Only active subscriptions can be paused');
        }

        const pausedAt = new Date();

        // Validate state transition and create audit event
        const auditEvent = SUBSCRIPTION_STATE_MACHINE.validateAndCreateAuditEvent(
          subscription.status,
          'paused',
          subscription._id.toString(),
          {
            changedBy: 'system',
            reason: `Subscription paused${reason ? ': ' + reason : ''}`,
            metadata: { pauseReason: reason, pausedAt }
          }
        );

        subscription.isActive = false;
        subscription.status = 'paused';
        subscription.pausedAt = pausedAt;
        subscription.pauseReason = reason;

        // Append audit event to metadata
        Object.assign(subscription, appendAuditEvent(subscription, auditEvent));

        await subscription.save();

        // Emit event
        this.events.emit('subscription.paused', {
          subscription,
          reason: reason ?? undefined,
          pausedAt,
        });

        // Execute after hooks
        return this.plugins.executeHook(
          'subscription.pause.after',
          this.getPluginContext(),
          { subscriptionId, ...options },
          async () => subscription
        );
      }
    );
  }

  /**
   * Resume subscription
   *
   * @param subscriptionId - Subscription ID
   * @param options - Resume options
   * @returns Updated subscription
   */
  async resume(
    subscriptionId: string,
    options: ResumeOptions = {}
  ): Promise<SubscriptionDocument> {
    // Execute before hooks, then operation, then after hooks
    return this.plugins.executeHook(
      'subscription.resume.before',
      this.getPluginContext(),
      { subscriptionId, ...options },
      async () => {
        const { extendPeriod = false } = options;

        if (!this.models.Subscription) {
          throw new ModelNotRegisteredError('Subscription');
        }

        const SubscriptionModel = this.models.Subscription;
        const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

        if (!subscription) {
          throw new SubscriptionNotFoundError(subscriptionId);
        }

        if (!subscription.pausedAt) {
          throw new InvalidStateTransitionError(
            'resume',
            'paused',
            subscription.status,
            'Only paused subscriptions can be resumed'
          );
        }

        const now = new Date();
        const pausedAt = new Date(subscription.pausedAt);
        const pauseDuration = now.getTime() - pausedAt.getTime();

        // Validate state transition and create audit event
        const auditEvent = SUBSCRIPTION_STATE_MACHINE.validateAndCreateAuditEvent(
          subscription.status,
          'active',
          subscription._id.toString(),
          {
            changedBy: 'system',
            reason: 'Subscription resumed from paused state',
            metadata: {
              pausedAt,
              pauseDuration,
              extendPeriod,
              newEndDate: extendPeriod && subscription.endDate ? new Date(new Date(subscription.endDate).getTime() + pauseDuration) : undefined
            }
          }
        );

        subscription.isActive = true;
        subscription.status = 'active';
        subscription.pausedAt = null;
        subscription.pauseReason = null;

        // Optionally extend period by pause duration
        if (extendPeriod && subscription.endDate) {
          const currentEnd = new Date(subscription.endDate);
          subscription.endDate = new Date(currentEnd.getTime() + pauseDuration);
        }

        // Append audit event to metadata
        Object.assign(subscription, appendAuditEvent(subscription, auditEvent));

        await subscription.save();

        // Emit event
        this.events.emit('subscription.resumed', {
          subscription,
          extendPeriod,
          pauseDuration,
          resumedAt: now,
        });

        // Execute after hooks
        return this.plugins.executeHook(
          'subscription.resume.after',
          this.getPluginContext(),
          { subscriptionId, ...options },
          async () => subscription
        );
      }
    );
  }

  /**
   * List subscriptions with filters
   *
   * @param filters - Query filters
   * @param options - Query options (limit, skip, sort)
   * @returns Subscriptions
   */
  async list(
    filters: Record<string, unknown> = {},
    options: ListOptions = {}
  ): Promise<SubscriptionDocument[]> {
    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const { limit = 50, skip = 0, sort = { createdAt: -1 } } = options;

    const subscriptions = await (SubscriptionModel as unknown as {
      find(filter: object): { limit(n: number): { skip(n: number): { sort(s: object): Promise<SubscriptionDocument[]> } } };
    })
      .find(filters)
      .limit(limit)
      .skip(skip)
      .sort(sort);

    return subscriptions;
  }

  /**
   * Get subscription by ID
   *
   * @param subscriptionId - Subscription ID
   * @returns Subscription
   */
  async get(subscriptionId: string): Promise<SubscriptionDocument> {
    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId) as SubscriptionDocument | null;

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    return subscription;
  }

  /**
   * Calculate period end date based on plan key
   * @private
   */
  private _calculatePeriodEnd(planKey: string, startDate: Date = new Date()): Date {
    const start = new Date(startDate);
    const end = new Date(start);

    switch (planKey) {
      case 'monthly':
        end.setMonth(end.getMonth() + 1);
        break;
      case 'quarterly':
        end.setMonth(end.getMonth() + 3);
        break;
      case 'yearly':
        end.setFullYear(end.getFullYear() + 1);
        break;
      default:
        // Default to 30 days
        end.setDate(end.getDate() + 30);
    }

    return end;
  }
}

export default MonetizationService;
