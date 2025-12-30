/**
 * Event System - Type-safe pub/sub
 * @classytic/revenue
 *
 * Strongly typed events with async handlers
 * Inspired by: Node.js EventEmitter, mitt, EventTarget
 */

import type {
  TransactionDocument,
  SubscriptionDocument,
  PaymentResultData,
  PaymentIntentData,
  SplitInfo,
  WebhookEventData,
} from '../shared/types/index.js';
import type { PaymentResult, RefundResult } from '../providers/base.js';
import type { SettlementDocument } from '../schemas/settlement/settlement.schema.js';

// ============ EVENT DEFINITIONS ============

/**
 * All revenue events with their payload types
 */
export interface RevenueEvents {
  // Payment events
  'payment.verified': PaymentVerifiedEvent;
  'payment.failed': PaymentFailedEvent;
  'payment.refunded': PaymentRefundedEvent;
  'payment.requires_action': PaymentRequiresActionEvent;
  'payment.processing': PaymentProcessingEvent;

  // Monetization events
  'monetization.created': MonetizationCreatedEvent;
  'purchase.created': PurchaseCreatedEvent;
  'free.created': FreeCreatedEvent;

  // Subscription events
  'subscription.created': SubscriptionCreatedEvent;
  'subscription.activated': SubscriptionActivatedEvent;
  'subscription.renewed': SubscriptionRenewedEvent;
  'subscription.cancelled': SubscriptionCancelledEvent;
  'subscription.paused': SubscriptionPausedEvent;
  'subscription.resumed': SubscriptionResumedEvent;

  // Transaction events
  'transaction.updated': TransactionUpdatedEvent;

  // Escrow events
  'escrow.held': EscrowHeldEvent;
  'escrow.released': EscrowReleasedEvent;
  'escrow.cancelled': EscrowCancelledEvent;
  'escrow.split': EscrowSplitEvent;

  // Settlement events
  'settlement.created': SettlementCreatedEvent;
  'settlement.scheduled': SettlementScheduledEvent;
  'settlement.processing': SettlementProcessingEvent;
  'settlement.completed': SettlementCompletedEvent;
  'settlement.failed': SettlementFailedEvent;

  // Webhook events
  'webhook.processed': WebhookProcessedEvent;

  // Wildcard - catches all events
  '*': BaseEvent;
}

// ============ EVENT PAYLOADS ============

/**
 * Base event with auto-injected fields
 */
export interface BaseEvent {
  readonly type: string;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Event data types (what services emit - without type/timestamp)
 * These are clean, explicit types that make it obvious what data to pass
 */
export interface PaymentVerifiedEventData {
  transaction: TransactionDocument;
  paymentResult: PaymentResult | PaymentResultData;
  verifiedBy?: string | null;
}

export interface PaymentFailedEventData {
  transaction: TransactionDocument;
  error: string;
  provider: string;
  paymentIntentId: string;
}

export interface PaymentRefundedEventData {
  transaction: TransactionDocument;
  refundTransaction: TransactionDocument;
  refundResult: RefundResult;
  refundAmount: number;
  reason?: string;
  isPartialRefund: boolean;
}

export interface PaymentRequiresActionEventData {
  transaction: TransactionDocument;
  paymentResult: PaymentResult | PaymentResultData;
  action?: string | Record<string, unknown>;
}

export interface PaymentProcessingEventData {
  transaction: TransactionDocument;
  paymentResult: PaymentResult | PaymentResultData;
}

export interface MonetizationCreatedEventData {
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction?: TransactionDocument;
  paymentIntent?: PaymentIntentData;
}

export interface SubscriptionActivatedEventData {
  subscription: SubscriptionDocument;
  activatedAt: Date;
}

export interface TransactionUpdatedEventData {
  transaction: TransactionDocument;
  updates: Partial<TransactionDocument>;
}

export interface PaymentVerifiedEvent extends BaseEvent {
  type: 'payment.verified';
  transaction: TransactionDocument;
  paymentResult: PaymentResult;
  verifiedBy?: string;
}

export interface PaymentFailedEvent extends BaseEvent {
  type: 'payment.failed';
  transaction: TransactionDocument;
  error: string;
  provider: string;
  paymentIntentId: string;
}

export interface PaymentRefundedEvent extends BaseEvent {
  type: 'payment.refunded';
  transaction: TransactionDocument;
  refundTransaction: TransactionDocument;
  refundResult: RefundResult;
  refundAmount: number;
  reason?: string;
  isPartialRefund: boolean;
}

export interface PaymentRequiresActionEvent extends BaseEvent {
  type: 'payment.requires_action';
  transaction: TransactionDocument;
  paymentResult: PaymentResult;
  action?: string | Record<string, unknown>;
}

export interface PaymentProcessingEvent extends BaseEvent {
  type: 'payment.processing';
  transaction: TransactionDocument;
  paymentResult: PaymentResult;
}

export interface MonetizationCreatedEvent extends BaseEvent {
  type: 'monetization.created';
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction?: TransactionDocument;
  paymentIntent?: PaymentIntentData;
}

export interface PurchaseCreatedEvent extends BaseEvent {
  type: 'purchase.created';
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction: TransactionDocument;
  paymentIntent?: PaymentIntentData;
}

export interface FreeCreatedEvent extends BaseEvent {
  type: 'free.created';
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction?: TransactionDocument; // Optional: free flows may not create transactions
  paymentIntent?: PaymentIntentData;
}

export interface SubscriptionCreatedEvent extends BaseEvent {
  type: 'subscription.created';
  subscriptionId: string;
  subscription: SubscriptionDocument;
  transactionId?: string;
}

export interface SubscriptionActivatedEvent extends BaseEvent {
  type: 'subscription.activated';
  subscription: SubscriptionDocument;
  activatedAt: Date;
}

export interface SubscriptionRenewedEvent extends BaseEvent {
  type: 'subscription.renewed';
  subscription: SubscriptionDocument;
  transaction: TransactionDocument;
  paymentIntent?: PaymentIntentData;
  renewalCount: number;
}

export interface SubscriptionCancelledEvent extends BaseEvent {
  type: 'subscription.cancelled';
  subscription: SubscriptionDocument;
  immediate: boolean;
  reason?: string;
  canceledAt: Date;
}

export interface SubscriptionPausedEvent extends BaseEvent {
  type: 'subscription.paused';
  subscription: SubscriptionDocument;
  reason?: string;
  pausedAt: Date;
}

export interface SubscriptionResumedEvent extends BaseEvent {
  type: 'subscription.resumed';
  subscription: SubscriptionDocument;
  extendPeriod: boolean;
  pauseDuration: number;
  resumedAt: Date;
}

export interface TransactionUpdatedEvent extends BaseEvent {
  type: 'transaction.updated';
  transaction: TransactionDocument;
  updates: Partial<TransactionDocument>;
}

export interface EscrowHeldEvent extends BaseEvent {
  type: 'escrow.held';
  transaction: TransactionDocument;
  heldAmount: number;
  reason: string;
}

export interface EscrowReleasedEvent extends BaseEvent {
  type: 'escrow.released';
  transaction: TransactionDocument;
  releaseTransaction: TransactionDocument | null;
  releaseAmount: number;
  recipientId: string;
  recipientType: string;
  reason: string;
  isFullRelease: boolean;
  isPartialRelease: boolean;
}

export interface EscrowCancelledEvent extends BaseEvent {
  type: 'escrow.cancelled';
  transaction: TransactionDocument;
  reason: string;
}

export interface EscrowSplitEvent extends BaseEvent {
  type: 'escrow.split';
  transaction: TransactionDocument;
  splits: SplitInfo[];
  splitTransactions: TransactionDocument[];
  organizationTransaction: TransactionDocument | null;
  organizationPayout: number;
}

export interface SettlementCreatedEvent extends BaseEvent {
  type: 'settlement.created';
  settlements: SettlementDocument[];
  transactionId: string;
  count: number;
}

export interface SettlementScheduledEvent extends BaseEvent {
  type: 'settlement.scheduled';
  settlement: SettlementDocument;
  scheduledAt: Date;
}

export interface SettlementProcessingEvent extends BaseEvent {
  type: 'settlement.processing';
  settlement: SettlementDocument;
  processedAt?: Date;
}

export interface SettlementCompletedEvent extends BaseEvent {
  type: 'settlement.completed';
  settlement: SettlementDocument;
  completedAt?: Date;
}

export interface SettlementFailedEvent extends BaseEvent {
  type: 'settlement.failed';
  settlement: SettlementDocument;
  reason: string;
  code?: string;
  retry: boolean;
}

export interface WebhookProcessedEvent extends BaseEvent {
  type: 'webhook.processed';
  webhookType: string;
  provider: string;
  event: WebhookEventData;
  transaction: TransactionDocument;
  processedAt: Date;
}

/**
 * Event data for free.created (transaction is optional)
 */
export interface FreeCreatedEventData {
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction?: TransactionDocument;
  paymentIntent?: PaymentIntentData;
}

/**
 * Event data for subscription.created
 */
export interface SubscriptionCreatedEventData {
  subscriptionId: string;
  subscription: SubscriptionDocument;
  transactionId?: string;
}

/**
 * Event data for subscription lifecycle events
 */
export interface SubscriptionRenewedEventData {
  subscription: SubscriptionDocument;
  transaction: TransactionDocument;
  paymentIntent?: PaymentIntentData;
  renewalCount: number;
}

export interface SubscriptionCancelledEventData {
  subscription: SubscriptionDocument;
  immediate: boolean;
  reason?: string;
  canceledAt: Date;
}

export interface SubscriptionPausedEventData {
  subscription: SubscriptionDocument;
  reason?: string;
  pausedAt: Date;
}

export interface SubscriptionResumedEventData {
  subscription: SubscriptionDocument;
  extendPeriod: boolean;
  pauseDuration: number;
  resumedAt: Date;
}

/**
 * Event data for escrow events
 */
export interface EscrowHeldEventData {
  transaction: TransactionDocument;
  heldAmount: number;
  reason: string;
}

export interface EscrowReleasedEventData {
  transaction: TransactionDocument;
  releaseTransaction: TransactionDocument | null;
  releaseAmount: number;
  recipientId: string;
  recipientType: string;
  reason: string;
  isFullRelease: boolean;
  isPartialRelease: boolean;
}

export interface EscrowCancelledEventData {
  transaction: TransactionDocument;
  reason: string;
}

export interface EscrowSplitEventData {
  transaction: TransactionDocument;
  splits: SplitInfo[];
  splitTransactions: TransactionDocument[];
  organizationTransaction: TransactionDocument | null;
  organizationPayout: number;
}

/**
 * Event data for settlement events
 */
export interface SettlementCreatedEventData {
  settlements: SettlementDocument[];
  transactionId: string;
  count: number;
}

export interface SettlementScheduledEventData {
  settlement: SettlementDocument;
  scheduledAt: Date;
}

export interface SettlementProcessingEventData {
  settlement: SettlementDocument;
  processedAt?: Date;
}

export interface SettlementCompletedEventData {
  settlement: SettlementDocument;
  completedAt?: Date;
}

export interface SettlementFailedEventData {
  settlement: SettlementDocument;
  reason: string;
  code?: string;
  retry: boolean;
}

/**
 * Event data for webhook events
 */
export interface WebhookProcessedEventData {
  webhookType: string;
  provider: string;
  event: WebhookEventData;
  transaction: TransactionDocument;
  processedAt: Date;
}

/**
 * Clean mapping of event names to their data types (what you emit)
 * This makes it crystal clear what data each event needs
 * Only includes events that are actually emitted in the codebase
 */
export interface EventDataMap {
  // Payment events
  'payment.verified': PaymentVerifiedEventData;
  'payment.failed': PaymentFailedEventData;
  'payment.refunded': PaymentRefundedEventData;
  'payment.requires_action': PaymentRequiresActionEventData;
  'payment.processing': PaymentProcessingEventData;

  // Monetization events
  'monetization.created': MonetizationCreatedEventData;
  'purchase.created': MonetizationCreatedEventData;
  'free.created': FreeCreatedEventData;

  // Subscription events
  'subscription.created': SubscriptionCreatedEventData;
  'subscription.activated': SubscriptionActivatedEventData;
  'subscription.renewed': SubscriptionRenewedEventData;
  'subscription.cancelled': SubscriptionCancelledEventData;
  'subscription.paused': SubscriptionPausedEventData;
  'subscription.resumed': SubscriptionResumedEventData;

  // Transaction events
  'transaction.updated': TransactionUpdatedEventData;

  // Escrow events
  'escrow.held': EscrowHeldEventData;
  'escrow.released': EscrowReleasedEventData;
  'escrow.cancelled': EscrowCancelledEventData;
  'escrow.split': EscrowSplitEventData;

  // Settlement events
  'settlement.created': SettlementCreatedEventData;
  'settlement.scheduled': SettlementScheduledEventData;
  'settlement.processing': SettlementProcessingEventData;
  'settlement.completed': SettlementCompletedEventData;
  'settlement.failed': SettlementFailedEventData;

  // Webhook events
  'webhook.processed': WebhookProcessedEventData;
}

// ============ EVENT BUS ============

type EventHandler<T> = (event: T) => void | Promise<void>;
type EventKey = keyof RevenueEvents;

/**
 * Type-safe event bus with clean, simple API
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler<any>>>();
  private onceHandlers = new Map<string, Set<EventHandler<any>>>();

  /**
   * Subscribe to an event
   */
  on<K extends EventKey>(
    event: K,
    handler: EventHandler<RevenueEvents[K]>
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    
    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once
   */
  once<K extends EventKey>(
    event: K,
    handler: EventHandler<RevenueEvents[K]>
  ): () => void {
    if (!this.onceHandlers.has(event)) {
      this.onceHandlers.set(event, new Set());
    }
    this.onceHandlers.get(event)!.add(handler);
    
    return () => this.onceHandlers.get(event)?.delete(handler);
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends EventKey>(
    event: K,
    handler: EventHandler<RevenueEvents[K]>
  ): void {
    this.handlers.get(event)?.delete(handler);
    this.onceHandlers.get(event)?.delete(handler);
  }

  /**
   * Emit an event (fire and forget, non-blocking)
   *
   * @example
   * ```typescript
   * events.emit('payment.verified', {
   *   transaction: txDoc,
   *   paymentResult: result,
   *   verifiedBy: 'admin_123'
   * });
   * ```
   */
  emit<K extends keyof EventDataMap>(event: K, data: EventDataMap[K]): void;
  emit<K extends EventKey>(event: K, data: any): void {
    const fullPayload = {
      ...data,
      type: event,
      timestamp: new Date(),
    } as RevenueEvents[K];

    // Regular handlers
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        // Fire and forget - don't await
        Promise.resolve(handler(fullPayload)).catch(err => {
          console.error(`[Revenue] Event handler error for "${event}":`, err);
        });
      }
    }

    // Once handlers
    const onceHandlers = this.onceHandlers.get(event);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        Promise.resolve(handler(fullPayload)).catch(err => {
          console.error(`[Revenue] Once handler error for "${event}":`, err);
        });
      }
      this.onceHandlers.delete(event);
    }

    // Wildcard handlers
    if (event !== '*') {
      const wildcardHandlers = this.handlers.get('*');
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          Promise.resolve(handler(fullPayload)).catch(err => {
            console.error(`[Revenue] Wildcard handler error:`, err);
          });
        }
      }
    }
  }

  /**
   * Emit and wait for all handlers to complete
   */
  async emitAsync<K extends EventKey>(
    event: K,
    payload: Omit<RevenueEvents[K], 'timestamp' | 'type'>
  ): Promise<void> {
    const fullPayload = {
      ...payload,
      type: event,
      timestamp: new Date(),
    } as RevenueEvents[K];

    const promises: Promise<void>[] = [];

    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        promises.push(Promise.resolve(handler(fullPayload)));
      }
    }

    const onceHandlers = this.onceHandlers.get(event);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        promises.push(Promise.resolve(handler(fullPayload)));
      }
      this.onceHandlers.delete(event);
    }

    if (event !== '*') {
      const wildcardHandlers = this.handlers.get('*');
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          promises.push(Promise.resolve(handler(fullPayload)));
        }
      }
    }

    await Promise.all(promises);
  }

  /**
   * Remove all handlers
   */
  clear(): void {
    this.handlers.clear();
    this.onceHandlers.clear();
  }

  /**
   * Get handler count for an event
   */
  listenerCount(event: EventKey): number {
    return (this.handlers.get(event)?.size ?? 0) + 
           (this.onceHandlers.get(event)?.size ?? 0);
  }
}

/**
 * Create a new event bus
 */
export function createEventBus(): EventBus {
  return new EventBus();
}

export default EventBus;

