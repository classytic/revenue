/**
 * Revenue Error Classes
 * @classytic/revenue
 *
 * Typed errors with codes for better error handling
 */

/**
 * Base Revenue Error
 */
export class RevenueError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = options.retryable || false;
    this.metadata = options.metadata || {};
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      metadata: this.metadata,
    };
  }
}

/**
 * Configuration Errors
 */
export class ConfigurationError extends RevenueError {
  constructor(message, metadata = {}) {
    super(message, 'CONFIGURATION_ERROR', { retryable: false, metadata });
  }
}

export class ModelNotRegisteredError extends ConfigurationError {
  constructor(modelName) {
    super(
      `Model "${modelName}" is not registered. Register it via createRevenue({ models: { ${modelName}: ... } })`,
      { modelName }
    );
  }
}

/**
 * Provider Errors
 */
export class ProviderError extends RevenueError {
  constructor(message, code, options = {}) {
    super(message, code, options);
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(providerName, availableProviders = []) {
    super(
      `Payment provider "${providerName}" not found. Available: ${availableProviders.join(', ')}`,
      'PROVIDER_NOT_FOUND',
      { retryable: false, metadata: { providerName, availableProviders } }
    );
  }
}

export class ProviderCapabilityError extends ProviderError {
  constructor(providerName, capability) {
    super(
      `Provider "${providerName}" does not support ${capability}`,
      'PROVIDER_CAPABILITY_NOT_SUPPORTED',
      { retryable: false, metadata: { providerName, capability } }
    );
  }
}

export class PaymentIntentCreationError extends ProviderError {
  constructor(providerName, originalError) {
    super(
      `Failed to create payment intent with provider "${providerName}": ${originalError.message}`,
      'PAYMENT_INTENT_CREATION_FAILED',
      { retryable: true, metadata: { providerName, originalError: originalError.message } }
    );
  }
}

export class PaymentVerificationError extends ProviderError {
  constructor(paymentIntentId, reason) {
    super(
      `Payment verification failed for intent "${paymentIntentId}": ${reason}`,
      'PAYMENT_VERIFICATION_FAILED',
      { retryable: true, metadata: { paymentIntentId, reason } }
    );
  }
}

/**
 * Resource Not Found Errors
 */
export class NotFoundError extends RevenueError {
  constructor(message, code, metadata = {}) {
    super(message, code, { retryable: false, metadata });
  }
}

export class SubscriptionNotFoundError extends NotFoundError {
  constructor(subscriptionId) {
    super(
      `Subscription not found: ${subscriptionId}`,
      'SUBSCRIPTION_NOT_FOUND',
      { subscriptionId }
    );
  }
}

export class TransactionNotFoundError extends NotFoundError {
  constructor(transactionId) {
    super(
      `Transaction not found: ${transactionId}`,
      'TRANSACTION_NOT_FOUND',
      { transactionId }
    );
  }
}

/**
 * Validation Errors
 */
export class ValidationError extends RevenueError {
  constructor(message, metadata = {}) {
    super(message, 'VALIDATION_ERROR', { retryable: false, metadata });
  }
}

export class InvalidAmountError extends ValidationError {
  constructor(amount) {
    super(`Invalid amount: ${amount}. Amount must be non-negative`, { amount });
  }
}

export class MissingRequiredFieldError extends ValidationError {
  constructor(fieldName) {
    super(`Missing required field: ${fieldName}`, { fieldName });
  }
}

/**
 * State Errors
 */
export class StateError extends RevenueError {
  constructor(message, code, metadata = {}) {
    super(message, code, { retryable: false, metadata });
  }
}

export class AlreadyVerifiedError extends StateError {
  constructor(transactionId) {
    super(
      `Transaction ${transactionId} is already verified`,
      'ALREADY_VERIFIED',
      { transactionId }
    );
  }
}

export class InvalidStateTransitionError extends StateError {
  constructor(resourceType, resourceId, fromState, toState) {
    super(
      `Invalid state transition for ${resourceType} ${resourceId}: ${fromState} → ${toState}`,
      'INVALID_STATE_TRANSITION',
      { resourceType, resourceId, fromState, toState }
    );
  }
}

export class SubscriptionNotActiveError extends StateError {
  constructor(subscriptionId) {
    super(
      `Subscription ${subscriptionId} is not active`,
      'SUBSCRIPTION_NOT_ACTIVE',
      { subscriptionId }
    );
  }
}

/**
 * Operation Errors
 */
export class OperationError extends RevenueError {
  constructor(message, code, options = {}) {
    super(message, code, options);
  }
}

export class RefundNotSupportedError extends OperationError {
  constructor(providerName) {
    super(
      `Refunds are not supported by provider "${providerName}"`,
      'REFUND_NOT_SUPPORTED',
      { retryable: false, metadata: { providerName } }
    );
  }
}

export class RefundError extends OperationError {
  constructor(transactionId, reason) {
    super(
      `Refund failed for transaction ${transactionId}: ${reason}`,
      'REFUND_FAILED',
      { retryable: true, metadata: { transactionId, reason } }
    );
  }
}

/**
 * Error Code Constants
 */
export const ERROR_CODES = {
  // Configuration
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  MODEL_NOT_REGISTERED: 'MODEL_NOT_REGISTERED',

  // Provider
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_CAPABILITY_NOT_SUPPORTED: 'PROVIDER_CAPABILITY_NOT_SUPPORTED',
  PAYMENT_INTENT_CREATION_FAILED: 'PAYMENT_INTENT_CREATION_FAILED',
  PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',

  // Not Found
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',

  // State
  ALREADY_VERIFIED: 'ALREADY_VERIFIED',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  SUBSCRIPTION_NOT_ACTIVE: 'SUBSCRIPTION_NOT_ACTIVE',

  // Operations
  REFUND_NOT_SUPPORTED: 'REFUND_NOT_SUPPORTED',
  REFUND_FAILED: 'REFUND_FAILED',
};

/**
 * Check if error is retryable
 */
export function isRetryable(error) {
  return error instanceof RevenueError && error.retryable;
}

/**
 * Check if error is from revenue package
 */
export function isRevenueError(error) {
  return error instanceof RevenueError;
}
