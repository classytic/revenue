export class RevenueError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RevenueError';
  }
}

export class ValidationError extends RevenueError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends RevenueError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', details);
    this.name = 'ConfigurationError';
  }
}

export class ProviderNotFoundError extends RevenueError {
  constructor(providerName: string) {
    super(`Payment provider '${providerName}' not found`, 'PROVIDER_NOT_FOUND', { providerName });
    this.name = 'ProviderNotFoundError';
  }
}

export class TransactionNotFoundError extends RevenueError {
  constructor(transactionId: string) {
    super(`Transaction '${transactionId}' not found`, 'TRANSACTION_NOT_FOUND', { transactionId });
    this.name = 'TransactionNotFoundError';
  }
}

export class SubscriptionNotFoundError extends RevenueError {
  constructor(subscriptionId: string) {
    super(`Subscription '${subscriptionId}' not found`, 'SUBSCRIPTION_NOT_FOUND', { subscriptionId });
    this.name = 'SubscriptionNotFoundError';
  }
}

export class SettlementNotFoundError extends RevenueError {
  constructor(settlementId: string) {
    super(`Settlement '${settlementId}' not found`, 'SETTLEMENT_NOT_FOUND', { settlementId });
    this.name = 'SettlementNotFoundError';
  }
}

export class PaymentIntentCreationError extends RevenueError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PAYMENT_INTENT_CREATION_ERROR', details);
    this.name = 'PaymentIntentCreationError';
  }
}

export class ProviderCapabilityError extends RevenueError {
  constructor(provider: string, capability: string) {
    super(`Provider '${provider}' does not support '${capability}'`, 'PROVIDER_CAPABILITY_ERROR', { provider, capability });
    this.name = 'ProviderCapabilityError';
  }
}

export class InvalidStateTransitionError extends RevenueError {
  constructor(resourceType: string, resourceId: string, from: string, to: string) {
    super(
      `Invalid ${resourceType} state transition: ${from} → ${to} (resource: ${resourceId})`,
      'INVALID_STATE_TRANSITION',
      { resourceType, resourceId, from, to },
    );
    this.name = 'InvalidStateTransitionError';
  }
}

export class AlreadyVerifiedError extends RevenueError {
  constructor(transactionId: string) {
    super(`Transaction '${transactionId}' is already verified`, 'ALREADY_VERIFIED', { transactionId });
    this.name = 'AlreadyVerifiedError';
  }
}

export class RefundNotSupportedError extends RevenueError {
  constructor(provider: string) {
    super(`Provider '${provider}' does not support refunds`, 'REFUND_NOT_SUPPORTED', { provider });
    this.name = 'RefundNotSupportedError';
  }
}

export class PaymentVerificationError extends RevenueError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PAYMENT_VERIFICATION_ERROR', details);
    this.name = 'PaymentVerificationError';
  }
}
