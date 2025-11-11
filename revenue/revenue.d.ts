/**
 * TypeScript definitions for @classytic/revenue
 * Enterprise Revenue Management System
 *
 * Thin, focused, production-ready library with smart defaults.
 *
 * @version 1.0.0
 */

import { Schema, Model, Document } from 'mongoose';

// ============ CORE API ============

// Container
export class Container {
  register(name: string, implementation: any, options?: { singleton?: boolean; factory?: boolean }): this;
  singleton(name: string, implementation: any): this;
  transient(name: string, factory: Function): this;
  get(name: string): any;
  has(name: string): boolean;
  keys(): string[];
  clear(): void;
  createScope(): Container;
}

// Provider System
export interface PaymentIntentParams {
  amount: number;
  currency?: string;
  metadata?: Record<string, any>;
}

export class PaymentIntent {
  id: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, any>;
  clientSecret?: string;
  paymentUrl?: string;
  instructions?: string;
  raw?: any;
}

export class PaymentResult {
  id: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  paidAt?: Date;
  metadata: Record<string, any>;
  raw?: any;
}

export class RefundResult {
  id: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  refundedAt?: Date;
  reason?: string;
  metadata: Record<string, any>;
  raw?: any;
}

export class WebhookEvent {
  id: string;
  provider: string;
  type: string;
  data: any;
  createdAt: Date;
  raw?: any;
}

export abstract class PaymentProvider {
  name: string;
  config: any;

  createIntent(params: PaymentIntentParams): Promise<PaymentIntent>;
  verifyPayment(intentId: string): Promise<PaymentResult>;
  getStatus(intentId: string): Promise<PaymentResult>;
  refund(paymentId: string, amount?: number, options?: any): Promise<RefundResult>;
  handleWebhook(payload: any, headers?: any): Promise<WebhookEvent>;
  verifyWebhookSignature(payload: any, signature: string): boolean;
  getCapabilities(): {
    supportsWebhooks: boolean;
    supportsRefunds: boolean;
    supportsPartialRefunds: boolean;
    requiresManualVerification: boolean;
  };
}

// Note: ManualProvider moved to @classytic/revenue-manual (separate package)

// Services
export class SubscriptionService {
  constructor(container: Container);

  create(params: {
    data: any;
    planKey: string;
    amount: number;
    currency?: string;
    gateway?: string;
    entity?: string;
    monetizationType?: 'free' | 'subscription' | 'purchase';
    paymentData?: any;
    metadata?: Record<string, any>;
    idempotencyKey?: string;
  }): Promise<{ subscription: any; transaction: any; paymentIntent: PaymentIntent | null }>;

  activate(subscriptionId: string, options?: { timestamp?: Date }): Promise<any>;
  renew(subscriptionId: string, params?: {
    gateway?: string;
    entity?: string;
    paymentData?: any;
    metadata?: Record<string, any>;
    idempotencyKey?: string;
  }): Promise<{ subscription: any; transaction: any; paymentIntent: PaymentIntent }>;
  cancel(subscriptionId: string, options?: { immediate?: boolean; reason?: string }): Promise<any>;
  pause(subscriptionId: string, options?: { reason?: string }): Promise<any>;
  resume(subscriptionId: string, options?: { extendPeriod?: boolean }): Promise<any>;
  list(filters?: any, options?: any): Promise<any[]>;
  get(subscriptionId: string): Promise<any>;
}

export class PaymentService {
  constructor(container: Container);

  verify(paymentIntentId: string, options?: { verifiedBy?: string }): Promise<{ transaction: any; paymentResult: PaymentResult; status: string }>;
  getStatus(paymentIntentId: string): Promise<{ transaction: any; paymentResult: PaymentResult; status: string; provider: string }>;
  refund(paymentId: string, amount?: number, options?: { reason?: string }): Promise<{ transaction: any; refundTransaction: any; refundResult: RefundResult; status: string }>;
  handleWebhook(providerName: string, payload: any, headers?: any): Promise<{ event: WebhookEvent; transaction: any; status: string }>;
  list(filters?: any, options?: any): Promise<any[]>;
  get(transactionId: string): Promise<any>;
  getProvider(providerName: string): PaymentProvider;
}

export class TransactionService {
  constructor(container: Container);

  get(transactionId: string): Promise<any>;
  list(filters?: any, options?: any): Promise<{ transactions: any[]; total: number; page: number; limit: number; pages: number }>;
  update(transactionId: string, updates: any): Promise<any>;
}

// Error Classes
export class RevenueError extends Error {
  code: string;
  retryable: boolean;
  metadata: Record<string, any>;
  toJSON(): { name: string; message: string; code: string; retryable: boolean; metadata: Record<string, any> };
}

export class ConfigurationError extends RevenueError {}
export class ModelNotRegisteredError extends ConfigurationError {}
export class ProviderError extends RevenueError {}
export class ProviderNotFoundError extends ProviderError {}
export class ProviderCapabilityError extends ProviderError {}
export class PaymentIntentCreationError extends ProviderError {}
export class PaymentVerificationError extends ProviderError {}
export class NotFoundError extends RevenueError {}
export class SubscriptionNotFoundError extends NotFoundError {}
export class TransactionNotFoundError extends NotFoundError {}
export class ValidationError extends RevenueError {}
export class InvalidAmountError extends ValidationError {}
export class MissingRequiredFieldError extends ValidationError {}
export class StateError extends RevenueError {}
export class AlreadyVerifiedError extends StateError {}
export class InvalidStateTransitionError extends StateError {}
export class SubscriptionNotActiveError extends StateError {}
export class OperationError extends RevenueError {}
export class RefundNotSupportedError extends OperationError {}
export class RefundError extends OperationError {}

export function isRetryable(error: Error): boolean;
export function isRevenueError(error: Error): boolean;

// Revenue Instance (Immutable)
export interface Revenue {
  readonly container: Container;
  readonly providers: Readonly<Record<string, PaymentProvider>>;
  readonly config: Readonly<any>;

  readonly subscriptions: SubscriptionService;
  readonly payments: PaymentService;
  readonly transactions: TransactionService;

  getProvider(name: string): PaymentProvider;
}

export interface RevenueOptions {
  models: {
    Transaction: Model<any>;
    Subscription?: Model<any>;
    [key: string]: Model<any> | undefined;
  };
  providers?: Record<string, PaymentProvider>;
  hooks?: Record<string, Function[]>;
  config?: {
    /**
     * Maps logical entity identifiers to custom transaction category names
     *
     * Entity identifiers are NOT database model names - they are logical identifiers
     * you choose to organize your business logic.
     *
     * @example
     * categoryMappings: {
     *   Order: 'order_subscription',              // Customer orders
     *   PlatformSubscription: 'platform_subscription',  // Tenant/org subscriptions
     *   TenantUpgrade: 'tenant_upgrade',          // Tenant upgrades
     *   Membership: 'gym_membership',              // User memberships
     *   Enrollment: 'course_enrollment',           // Course enrollments
     * }
     *
     * If not specified, falls back to library defaults: 'subscription' or 'purchase'
     */
    categoryMappings?: Record<string, string>;
    
    /**
     * Maps transaction types to income/expense for your accounting system
     * 
     * Allows you to control how different transaction types are recorded:
     * - 'income': Money coming in (payments, subscriptions)
     * - 'expense': Money going out (refunds)
     * 
     * @example
     * transactionTypeMapping: {
     *   subscription: 'income',
     *   subscription_renewal: 'income',
     *   purchase: 'income',
     *   refund: 'expense',
     * }
     * 
     * If not specified, library defaults to 'income' for all payment transactions
     */
    transactionTypeMapping?: Record<string, 'income' | 'expense'>;
    [key: string]: any;
  };
  logger?: Console | any;
}

export function createRevenue(options: RevenueOptions): Revenue;

// ============ ENUMS ============

export const TRANSACTION_TYPE: {
  INCOME: 'income';
  EXPENSE: 'expense';
};

export const TRANSACTION_STATUS: {
  PENDING: 'pending';
  PAYMENT_INITIATED: 'payment_initiated';
  PROCESSING: 'processing';
  REQUIRES_ACTION: 'requires_action';
  VERIFIED: 'verified';
  COMPLETED: 'completed';
  FAILED: 'failed';
  CANCELLED: 'cancelled';
  EXPIRED: 'expired';
  REFUNDED: 'refunded';
  PARTIALLY_REFUNDED: 'partially_refunded';
};

export const PAYMENT_GATEWAY_TYPE: {
  MANUAL: 'manual';
  STRIPE: 'stripe';
  SSLCOMMERZ: 'sslcommerz';
};

export const SUBSCRIPTION_STATUS: {
  ACTIVE: 'active';
  PAUSED: 'paused';
  CANCELLED: 'cancelled';
  EXPIRED: 'expired';
  PENDING: 'pending';
  INACTIVE: 'inactive';
};

export const PLAN_KEYS: {
  MONTHLY: 'monthly';
  QUARTERLY: 'quarterly';
  YEARLY: 'yearly';
};

export const MONETIZATION_TYPES: {
  FREE: 'free';
  PURCHASE: 'purchase';
  SUBSCRIPTION: 'subscription';
};

// ============ SCHEMAS ============

export const currentPaymentSchema: Schema;
export const paymentSummarySchema: Schema;
export const subscriptionInfoSchema: Schema;
export const subscriptionPlanSchema: Schema;
export const gatewaySchema: Schema;
export const commissionSchema: Schema;
export const paymentDetailsSchema: Schema;

// ============ UTILITIES ============

export const logger: Console | any;
export function setLogger(logger: Console | any): void;

// ============ DEFAULT EXPORT ============

declare const _default: {
  createRevenue: typeof createRevenue;
  PaymentProvider: typeof PaymentProvider;
  RevenueError: typeof RevenueError;
  Container: typeof Container;
};

export default _default;
