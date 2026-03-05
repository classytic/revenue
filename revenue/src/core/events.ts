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

// ============ BASE & UTILITY ============

/**
 * Base event with auto-injected fields (type + timestamp added by EventBus)
 */
export interface BaseEvent {
  readonly type: string;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
}

/** Derive a full event type from its data type */
type EventOf<K extends string, D> = D & BaseEvent & { readonly type: K };

// ============ EVENT DATA (single source of truth) ============
// These are the clean types that services emit (without type/timestamp).
// Full event types are derived below — no duplication.

// Payment
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

// Monetization
export interface MonetizationCreatedEventData {
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction?: TransactionDocument;
  paymentIntent?: PaymentIntentData;
}

export interface PurchaseCreatedEventData {
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction: TransactionDocument;
  paymentIntent?: PaymentIntentData;
}

export interface FreeCreatedEventData {
  monetizationType: string;
  subscription?: SubscriptionDocument;
  transaction?: TransactionDocument;
  paymentIntent?: PaymentIntentData;
}

// Subscription
export interface SubscriptionCreatedEventData {
  subscriptionId: string;
  subscription: SubscriptionDocument;
  transactionId?: string;
}

export interface SubscriptionActivatedEventData {
  subscription: SubscriptionDocument;
  activatedAt: Date;
}

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

// Transaction
export interface TransactionUpdatedEventData {
  transaction: TransactionDocument;
  updates: Partial<TransactionDocument>;
}

// Escrow
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

// Settlement
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

// Webhook
export interface WebhookProcessedEventData {
  webhookType: string;
  provider: string;
  event: WebhookEventData;
  transaction: TransactionDocument;
  processedAt: Date;
}

// ============ DERIVED EVENT TYPES ============
// Full event = EventData + BaseEvent + { type: literal }

export type PaymentVerifiedEvent = EventOf<'payment.verified', PaymentVerifiedEventData>;
export type PaymentFailedEvent = EventOf<'payment.failed', PaymentFailedEventData>;
export type PaymentRefundedEvent = EventOf<'payment.refunded', PaymentRefundedEventData>;
export type PaymentRequiresActionEvent = EventOf<'payment.requires_action', PaymentRequiresActionEventData>;
export type PaymentProcessingEvent = EventOf<'payment.processing', PaymentProcessingEventData>;

export type MonetizationCreatedEvent = EventOf<'monetization.created', MonetizationCreatedEventData>;
export type PurchaseCreatedEvent = EventOf<'purchase.created', PurchaseCreatedEventData>;
export type FreeCreatedEvent = EventOf<'free.created', FreeCreatedEventData>;

export type SubscriptionCreatedEvent = EventOf<'subscription.created', SubscriptionCreatedEventData>;
export type SubscriptionActivatedEvent = EventOf<'subscription.activated', SubscriptionActivatedEventData>;
export type SubscriptionRenewedEvent = EventOf<'subscription.renewed', SubscriptionRenewedEventData>;
export type SubscriptionCancelledEvent = EventOf<'subscription.cancelled', SubscriptionCancelledEventData>;
export type SubscriptionPausedEvent = EventOf<'subscription.paused', SubscriptionPausedEventData>;
export type SubscriptionResumedEvent = EventOf<'subscription.resumed', SubscriptionResumedEventData>;

export type TransactionUpdatedEvent = EventOf<'transaction.updated', TransactionUpdatedEventData>;

export type EscrowHeldEvent = EventOf<'escrow.held', EscrowHeldEventData>;
export type EscrowReleasedEvent = EventOf<'escrow.released', EscrowReleasedEventData>;
export type EscrowCancelledEvent = EventOf<'escrow.cancelled', EscrowCancelledEventData>;
export type EscrowSplitEvent = EventOf<'escrow.split', EscrowSplitEventData>;

export type SettlementCreatedEvent = EventOf<'settlement.created', SettlementCreatedEventData>;
export type SettlementScheduledEvent = EventOf<'settlement.scheduled', SettlementScheduledEventData>;
export type SettlementProcessingEvent = EventOf<'settlement.processing', SettlementProcessingEventData>;
export type SettlementCompletedEvent = EventOf<'settlement.completed', SettlementCompletedEventData>;
export type SettlementFailedEvent = EventOf<'settlement.failed', SettlementFailedEventData>;

export type WebhookProcessedEvent = EventOf<'webhook.processed', WebhookProcessedEventData>;

// ============ EVENT DATA MAP ============

/**
 * Maps event names to their data types (what you pass to emit).
 * EventBus auto-injects type + timestamp.
 */
export interface EventDataMap {
  'payment.verified': PaymentVerifiedEventData;
  'payment.failed': PaymentFailedEventData;
  'payment.refunded': PaymentRefundedEventData;
  'payment.requires_action': PaymentRequiresActionEventData;
  'payment.processing': PaymentProcessingEventData;

  'monetization.created': MonetizationCreatedEventData;
  'purchase.created': PurchaseCreatedEventData;
  'free.created': FreeCreatedEventData;

  'subscription.created': SubscriptionCreatedEventData;
  'subscription.activated': SubscriptionActivatedEventData;
  'subscription.renewed': SubscriptionRenewedEventData;
  'subscription.cancelled': SubscriptionCancelledEventData;
  'subscription.paused': SubscriptionPausedEventData;
  'subscription.resumed': SubscriptionResumedEventData;

  'transaction.updated': TransactionUpdatedEventData;

  'escrow.held': EscrowHeldEventData;
  'escrow.released': EscrowReleasedEventData;
  'escrow.cancelled': EscrowCancelledEventData;
  'escrow.split': EscrowSplitEventData;

  'settlement.created': SettlementCreatedEventData;
  'settlement.scheduled': SettlementScheduledEventData;
  'settlement.processing': SettlementProcessingEventData;
  'settlement.completed': SettlementCompletedEventData;
  'settlement.failed': SettlementFailedEventData;

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

