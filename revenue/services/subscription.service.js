/**
 * Subscription Service
 * @classytic/revenue
 *
 * Framework-agnostic subscription management service with DI
 * Handles complete subscription lifecycle using provider system
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
} from '../core/errors.js';
import { triggerHook } from '../utils/hooks.js';
import { resolveCategory } from '../utils/category-resolver.js';
import { calculateCommission } from '../utils/commission.js';
import { MONETIZATION_TYPES } from '../enums/monetization.enums.js';
import { TRANSACTION_TYPE } from '../enums/transaction.enums.js';

/**
 * Subscription Service
 * Uses DI container for all dependencies
 */
export class SubscriptionService {
  constructor(container) {
    this.container = container;
    this.models = container.get('models');
    this.providers = container.get('providers');
    this.config = container.get('config');
    this.hooks = container.get('hooks');
    this.logger = container.get('logger');
  }

  /**
   * Create a new subscription
   *
   * @param {Object} params - Subscription parameters
   * @param {Object} params.data - Subscription data (organizationId, customerId, referenceId, referenceModel, etc.)
   * @param {String} params.planKey - Plan key ('monthly', 'quarterly', 'yearly')
   * @param {Number} params.amount - Subscription amount
   * @param {String} params.currency - Currency code (default: 'BDT')
   * @param {String} params.gateway - Payment gateway to use (default: 'manual')
   * @param {String} params.entity - Logical entity identifier (e.g., 'Order', 'PlatformSubscription', 'Membership')
   *                                 NOTE: This is NOT a database model name - it's just a logical identifier for categoryMappings
   * @param {String} params.monetizationType - Monetization type ('free', 'subscription', 'purchase')
   * @param {Object} params.paymentData - Payment method details
   * @param {Object} params.metadata - Additional metadata
   * @param {String} params.idempotencyKey - Idempotency key for duplicate prevention
   * 
   * @example
   * // With polymorphic reference (recommended)
   * await revenue.subscriptions.create({
   *   data: {
   *     organizationId: '...',
   *     customerId: '...',
   *     referenceId: subscription._id,      // Links to entity
   *     referenceModel: 'Subscription',     // Model name
   *   },
   *   amount: 1500,
   *   // ...
   * });
   * 
   * @returns {Promise<Object>} { subscription, transaction, paymentIntent }
   */
  async create(params) {
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
    if (!data.organizationId) {
      throw new MissingRequiredFieldError('organizationId');
    }

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
    let paymentIntent = null;
    let transaction = null;

    if (!isFree) {
      // Create payment intent via provider
      try {
        paymentIntent = await provider.createIntent({
          amount,
          currency,
          metadata: {
            ...metadata,
            type: 'subscription',
            planKey,
          },
        });
      } catch (error) {
        throw new PaymentIntentCreationError(gateway, error);
      }

      // Resolve category based on entity and monetizationType
      const category = resolveCategory(entity, monetizationType, this.config.categoryMappings);

      // Resolve transaction type using config mapping or default to 'income'
      const transactionType = this.config.transactionTypeMapping?.subscription 
        || this.config.transactionTypeMapping?.[monetizationType]
        || TRANSACTION_TYPE.INCOME;

      // Calculate commission if configured
      const commissionRate = this.config.commissionRates?.[category] || 0;
      const gatewayFeeRate = this.config.gatewayFeeRates?.[gateway] || 0;
      const commission = calculateCommission(amount, commissionRate, gatewayFeeRate);

      // Create transaction record
      const TransactionModel = this.models.Transaction;
      transaction = await TransactionModel.create({
        organizationId: data.organizationId,
        customerId: data.customerId || null,
        amount,
        currency,
        category,
        type: transactionType,
        method: paymentData?.method || 'manual',
        status: paymentIntent.status === 'succeeded' ? 'verified' : 'pending',
        gateway: {
          type: gateway,
          paymentIntentId: paymentIntent.id,
          provider: paymentIntent.provider,
        },
        paymentDetails: {
          provider: gateway,
          ...paymentData,
        },
        ...(commission && { commission }), // Only include if commission exists
        // Polymorphic reference (top-level, not metadata)
        ...(data.referenceId && { referenceId: data.referenceId }),
        ...(data.referenceModel && { referenceModel: data.referenceModel }),
        metadata: {
          ...metadata,
          planKey,
          entity,
          monetizationType,
          paymentIntentId: paymentIntent.id,
        },
        idempotencyKey: idempotencyKey || `sub_${nanoid(16)}`,
      });
    }

    // Create subscription record (if Subscription model exists)
    let subscription = null;
    if (this.models.Subscription) {
      const SubscriptionModel = this.models.Subscription;

      // Create subscription with proper reference tracking
      const subscriptionData = {
        organizationId: data.organizationId,
        customerId: data.customerId || null,
        planKey,
        amount,
        currency,
        status: isFree ? 'active' : 'pending',
        isActive: isFree,
        gateway,
        transactionId: transaction?._id || null,
        paymentIntentId: paymentIntent?.id || null,
        metadata: {
          ...metadata,
          isFree,
          entity,
          monetizationType,
        },
        ...data,
      };

      // Remove referenceId/referenceModel from subscription (they're for transactions)
      delete subscriptionData.referenceId;
      delete subscriptionData.referenceModel;

      subscription = await SubscriptionModel.create(subscriptionData);
    }

    // Trigger hook
    this._triggerHook('subscription.created', {
      subscription,
      transaction,
      paymentIntent,
      isFree,
    });

    return {
      subscription,
      transaction,
      paymentIntent,
    };
  }

  /**
   * Activate subscription after payment verification
   *
   * @param {String} subscriptionId - Subscription ID or transaction ID
   * @param {Object} options - Activation options
   * @returns {Promise<Object>} Updated subscription
   */
  async activate(subscriptionId, options = {}) {
    const { timestamp = new Date() } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId);

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    if (subscription.isActive) {
      this.logger.warn('Subscription already active', { subscriptionId });
      return subscription;
    }

    // Calculate period dates based on plan
    const periodEnd = this._calculatePeriodEnd(subscription.planKey, timestamp);

    // Update subscription
    subscription.isActive = true;
    subscription.status = 'active';
    subscription.startDate = timestamp;
    subscription.endDate = periodEnd;
    subscription.activatedAt = timestamp;

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.activated', {
      subscription,
      activatedAt: timestamp,
    });

    return subscription;
  }

  /**
   * Renew subscription
   *
   * @param {String} subscriptionId - Subscription ID
   * @param {Object} params - Renewal parameters
   * @param {String} params.gateway - Payment gateway to use (default: 'manual')
   * @param {String} params.entity - Logical entity identifier (optional, inherits from subscription)
   * @param {Object} params.paymentData - Payment method details
   * @param {Object} params.metadata - Additional metadata
   * @param {String} params.idempotencyKey - Idempotency key for duplicate prevention
   * @returns {Promise<Object>} { subscription, transaction, paymentIntent }
   */
  async renew(subscriptionId, params = {}) {
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
    const subscription = await SubscriptionModel.findById(subscriptionId);

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
    let paymentIntent = null;
    try {
      paymentIntent = await provider.createIntent({
        amount: subscription.amount,
        currency: subscription.currency || 'BDT',
        metadata: {
          ...metadata,
          type: 'subscription_renewal',
          subscriptionId: subscription._id.toString(),
        },
      });
    } catch (error) {
      this.logger.error('Failed to create payment intent for renewal:', error);
      throw new PaymentIntentCreationError(gateway, error);
    }

    // Resolve category - use provided entity or inherit from subscription metadata
    const effectiveEntity = entity || subscription.metadata?.entity;
    const effectiveMonetizationType = subscription.metadata?.monetizationType || MONETIZATION_TYPES.SUBSCRIPTION;
    const category = resolveCategory(effectiveEntity, effectiveMonetizationType, this.config.categoryMappings);

    // Resolve transaction type using config mapping or default to 'income'
    const transactionType = this.config.transactionTypeMapping?.subscription_renewal
      || this.config.transactionTypeMapping?.subscription
      || this.config.transactionTypeMapping?.[effectiveMonetizationType]
      || TRANSACTION_TYPE.INCOME;

    // Calculate commission if configured
    const commissionRate = this.config.commissionRates?.[category] || 0;
    const gatewayFeeRate = this.config.gatewayFeeRates?.[gateway] || 0;
    const commission = calculateCommission(subscription.amount, commissionRate, gatewayFeeRate);

    // Create transaction
    const TransactionModel = this.models.Transaction;
    const transaction = await TransactionModel.create({
      organizationId: subscription.organizationId,
      customerId: subscription.customerId,
      amount: subscription.amount,
      currency: subscription.currency || 'BDT',
      category,
      type: transactionType,
      method: paymentData?.method || 'manual',
      status: paymentIntent.status === 'succeeded' ? 'verified' : 'pending',
      gateway: {
        type: gateway,
        paymentIntentId: paymentIntent.id,
        provider: paymentIntent.provider,
      },
      paymentDetails: {
        provider: gateway,
        ...paymentData,
      },
      ...(commission && { commission }), // Only include if commission exists
      // Polymorphic reference to subscription
      referenceId: subscription._id,
      referenceModel: 'Subscription',
      metadata: {
        ...metadata,
        subscriptionId: subscription._id.toString(), // Keep for backward compat
        entity: effectiveEntity,
        monetizationType: effectiveMonetizationType,
        isRenewal: true,
        paymentIntentId: paymentIntent.id,
      },
      idempotencyKey: idempotencyKey || `renewal_${nanoid(16)}`,
    });

    // Update subscription
    subscription.status = 'pending_renewal';
    subscription.renewalTransactionId = transaction._id;
    subscription.renewalCount = (subscription.renewalCount || 0) + 1;
    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.renewed', {
      subscription,
      transaction,
      paymentIntent,
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
   * @param {String} subscriptionId - Subscription ID
   * @param {Object} options - Cancellation options
   * @param {Boolean} options.immediate - Cancel immediately vs at period end
   * @param {String} options.reason - Cancellation reason
   * @returns {Promise<Object>} Updated subscription
   */
  async cancel(subscriptionId, options = {}) {
    const { immediate = false, reason = null } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId);

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    const now = new Date();

    if (immediate) {
      subscription.isActive = false;
      subscription.status = 'cancelled';
      subscription.canceledAt = now;
      subscription.cancellationReason = reason;
    } else {
      // Schedule cancellation at period end
      subscription.cancelAt = subscription.endDate || now;
      subscription.cancellationReason = reason;
    }

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.cancelled', {
      subscription,
      immediate,
      reason,
      canceledAt: immediate ? now : subscription.cancelAt,
    });

    return subscription;
  }

  /**
   * Pause subscription
   *
   * @param {String} subscriptionId - Subscription ID
   * @param {Object} options - Pause options
   * @returns {Promise<Object>} Updated subscription
   */
  async pause(subscriptionId, options = {}) {
    const { reason = null } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId);

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    if (!subscription.isActive) {
      throw new SubscriptionNotActiveError(subscriptionId, 'Only active subscriptions can be paused');
    }

    const pausedAt = new Date();
    subscription.isActive = false;
    subscription.status = 'paused';
    subscription.pausedAt = pausedAt;
    subscription.pauseReason = reason;

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.paused', {
      subscription,
      reason,
      pausedAt,
    });

    return subscription;
  }

  /**
   * Resume subscription
   *
   * @param {String} subscriptionId - Subscription ID
   * @param {Object} options - Resume options
   * @returns {Promise<Object>} Updated subscription
   */
  async resume(subscriptionId, options = {}) {
    const { extendPeriod = false } = options;

    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId);

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
    const pauseDuration = now - pausedAt;

    subscription.isActive = true;
    subscription.status = 'active';
    subscription.pausedAt = null;
    subscription.pauseReason = null;

    // Optionally extend period by pause duration
    if (extendPeriod && subscription.endDate) {
      const currentEnd = new Date(subscription.endDate);
      subscription.endDate = new Date(currentEnd.getTime() + pauseDuration);
    }

    await subscription.save();

    // Trigger hook
    this._triggerHook('subscription.resumed', {
      subscription,
      extendPeriod,
      pauseDuration,
      resumedAt: now,
    });

    return subscription;
  }

  /**
   * List subscriptions with filters
   *
   * @param {Object} filters - Query filters
   * @param {Object} options - Query options (limit, skip, sort)
   * @returns {Promise<Array>} Subscriptions
   */
  async list(filters = {}, options = {}) {
    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const { limit = 50, skip = 0, sort = { createdAt: -1 } } = options;

    const subscriptions = await SubscriptionModel
      .find(filters)
      .limit(limit)
      .skip(skip)
      .sort(sort);

    return subscriptions;
  }

  /**
   * Get subscription by ID
   *
   * @param {String} subscriptionId - Subscription ID
   * @returns {Promise<Object>} Subscription
   */
  async get(subscriptionId) {
    if (!this.models.Subscription) {
      throw new ModelNotRegisteredError('Subscription');
    }

    const SubscriptionModel = this.models.Subscription;
    const subscription = await SubscriptionModel.findById(subscriptionId);

    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriptionId);
    }

    return subscription;
  }

  /**
   * Calculate period end date based on plan key
   * @private
   */
  _calculatePeriodEnd(planKey, startDate = new Date()) {
    const start = new Date(startDate);
    let end = new Date(start);

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

  /**
   * Trigger event hook (fire-and-forget, non-blocking)
   * @private
   */
  _triggerHook(event, data) {
    triggerHook(this.hooks, event, data, this.logger);
  }
}

export default SubscriptionService;
