export class RevenueError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
    /**
     * Suggested HTTP status. Hosts that surface RevenueError over HTTP
     * (Arc, raw Express) read this to set the response code. Optional —
     * defaults to 500 in the host's error mapper when unset.
     */
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'RevenueError';
  }
}

/**
 * Thrown when a host passes ctx.session but NO outbox is wired —
 * publishing mid-transaction leaks ghost events on rollback (§P8.1).
 * Session + outbox is legal durable-relay-only mode.
 */
export class UnmanagedSessionError extends RevenueError {
  constructor() {
    super(
      'ctx.session provided but no OutboxStore is wired — events would leak or be lost. ' +
        'Wire an outbox or drop the session.',
      'revenue.session.unmanaged',
      undefined,
      409,
    );
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

// ─── Bank feed / accounting feed (3.0) ───

export class BankFeedImportError extends RevenueError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'BANK_FEED_IMPORT_ERROR', details);
    this.name = 'BankFeedImportError';
  }
}

export class WrongTransactionKindError extends RevenueError {
  constructor(transactionId: string, expected: string, actual: string) {
    super(
      `Transaction '${transactionId}' is kind '${actual}', not '${expected}'`,
      'WRONG_TRANSACTION_KIND',
      { transactionId, expected, actual },
    );
    this.name = 'WrongTransactionKindError';
  }
}

/**
 * Thrown by `TransactionRepository.backfillMethodKind` when the existing
 * doc is NOT eligible for backfill (methodKind already specific, or
 * status no longer `'pending'`). 409 because the request is well-formed
 * but conflicts with the current resource state.
 */
export class MethodKindLockedError extends RevenueError {
  constructor(transactionId: string, currentMethodKind: string, currentStatus: string) {
    super(
      `Transaction '${transactionId}' methodKind is locked (current: '${currentMethodKind}', status: '${currentStatus}'). ` +
        `Backfill is allowed only when methodKind === 'other' AND status === 'pending'.`,
      'METHOD_KIND_LOCKED',
      { transactionId, currentMethodKind, currentStatus },
      409,
    );
    this.name = 'MethodKindLockedError';
  }
}

/**
 * Thrown by `TransactionRepository.handleWebhook` when the provider's
 * `verifyWebhookSignature` rejects the payload. 401 because the request
 * failed authentication of its origin.
 *
 * The base `PaymentProvider.verifyWebhookSignature` defaults to accept-all,
 * so providers that do NOT override it never produce this error — signature
 * enforcement is opt-in per provider (least-breaking). Real gateways
 * (Stripe/Razorpay/…) MUST override with HMAC/timing-safe verification, at
 * which point this gate fires before any transaction is mutated.
 */
export class WebhookSignatureError extends RevenueError {
  constructor(provider: string) {
    super(
      `Webhook signature verification failed for provider '${provider}'`,
      'WEBHOOK_SIGNATURE_INVALID',
      { provider },
      401,
    );
    this.name = 'WebhookSignatureError';
  }
}

export class BankFeedProviderNotFoundError extends RevenueError {
  constructor(providerName: string) {
    super(
      `Bank-feed provider '${providerName}' not registered. Use \`engine.bankFeedProviders.register(name, provider)\`.`,
      'BANK_FEED_PROVIDER_NOT_FOUND',
      { providerName },
    );
    this.name = 'BankFeedProviderNotFoundError';
  }
}

/**
 * A refund whose provider outcome was NEVER OBSERVED — a timeout, an abort, an
 * unclassifiable provider error.
 *
 * Distinct from a decline on purpose. A decline means no money moved and the caller may
 * retry; this means **we do not know**, the refund claim is deliberately still held, and a
 * retry could refund the customer twice.
 *
 * The correct response is reconciliation — ask the provider what actually happened — not a
 * retry. Callers that catch this must not release the claim themselves.
 */
export class RefundOutcomeUnknownError extends Error {
  readonly transactionId: string;
  readonly amount: number;
  readonly providerReference?: string;
  readonly causeCode?: string;

  constructor(
    transactionId: string,
    amount: number,
    details: { providerReference?: string; causeCode?: string } = {},
  ) {
    super(
      `Refund outcome UNKNOWN for transaction ${transactionId} (amount ${amount}). ` +
        'The provider did not confirm the reversal, but it may have processed it. The refund ' +
        'claim is intentionally retained to prevent a double refund — resolve by reconciling ' +
        'provider status, never by retrying.',
    );
    this.name = 'RefundOutcomeUnknownError';
    this.transactionId = transactionId;
    this.amount = amount;
    if (details.providerReference !== undefined) this.providerReference = details.providerReference;
    if (details.causeCode !== undefined) this.causeCode = details.causeCode;
  }
}

/**
 * A payment intent whose creation outcome was NEVER OBSERVED.
 *
 * The gateway may hold a live intent that we have no local record of, because the provider
 * call happens before the transaction is persisted. Distinct from a decline so a caller
 * cannot treat it as "nothing happened" and immediately retry.
 *
 * The idempotency key is what makes an eventual retry safe at the GATEWAY — Stripe and
 * peers replay the original response against it. Making the orphan visible to US is
 * `PaymentAttempt`'s job (phase 3).
 */
export class IntentOutcomeUnknownError extends Error {
  readonly idempotencyKey: string;
  readonly causeCode?: string;

  constructor(idempotencyKey: string, details: { causeCode?: string } = {}) {
    super(
      `Payment intent outcome UNKNOWN (idempotency key ${idempotencyKey}). The provider may ` +
        'have created an intent that was never recorded locally. Retry only with the SAME ' +
        'idempotency key, so the gateway replays rather than creating a second intent.',
    );
    this.name = 'IntentOutcomeUnknownError';
    this.idempotencyKey = idempotencyKey;
    if (details.causeCode !== undefined) this.causeCode = details.causeCode;
  }
}
