import {
  defineStateMachine,
  type StateMachine as PrimitiveStateMachine,
} from '@classytic/primitives/state-machine';
import {
  HOLD_STATUS,
  type HoldStatusValue,
} from '../enums/escrow.enums.js';
import {
  SETTLEMENT_STATUS,
  type SettlementStatusValue,
} from '../enums/settlement.enums.js';
import {
  SPLIT_STATUS,
  type SplitStatusValue,
} from '../enums/split.enums.js';
import {
  SUBSCRIPTION_STATUS,
  type SubscriptionStatusValue,
} from '../enums/subscription.enums.js';
import {
  TRANSACTION_STATUS,
  type TransactionStatusValue,
} from '../enums/transaction.enums.js';
import { InvalidStateTransitionError } from './errors.js';

/**
 * Audit-trail event emitted by `validateAndCreateAuditEvent`.
 *
 * Revenue-specific shape — primitives' state-machine is intentionally
 * ledger-agnostic, so the audit envelope stays here next to the consumers.
 */
export interface StateChangeEvent<TState extends string = string> {
  resourceType: string;
  resourceId: string;
  fromState: TState;
  toState: TState;
  changedAt: Date;
  changedBy?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Revenue's typed state machine.
 *
 * Thin facade over `@classytic/primitives/state-machine`'s
 * `defineStateMachine` — primitives owns the transition logic, revenue
 * owns the API shape (`validate`, `getAllowedTransitions`,
 * `validateAndCreateAuditEvent`) that the existing repos and tests
 * depend on. Wires `InvalidStateTransitionError` through the primitive's
 * `errorFactory` so thrown types are unchanged.
 *
 * The constructor still accepts `Map<TState, Set<TState>>` so existing
 * instance definitions don't need to be rewritten.
 */
export class StateMachine<TState extends string> {
  private readonly inner: PrimitiveStateMachine<TState>;

  constructor(transitions: Map<TState, Set<TState>>, resourceType: string) {
    const record = {} as Record<TState, readonly TState[]>;
    for (const [from, toSet] of transitions.entries()) {
      record[from] = Array.from(toSet);
    }
    this.inner = defineStateMachine<TState>({
      name: resourceType,
      transitions: record,
      errorFactory: ({ entityId, from, to }) =>
        new InvalidStateTransitionError(resourceType, entityId, from, to),
    });
  }

  validate(from: TState, to: TState, resourceId: string): void {
    this.inner.assertTransition(resourceId, from, to);
  }

  canTransition(from: TState, to: TState): boolean {
    return this.inner.canTransition(from, to);
  }

  getAllowedTransitions(from: TState): TState[] {
    return [...(this.inner.transitions[from] ?? [])];
  }

  isTerminalState(state: TState): boolean {
    return this.inner.isTerminal(state);
  }

  getResourceType(): string {
    return this.inner.name;
  }

  validateAndCreateAuditEvent(
    from: TState,
    to: TState,
    resourceId: string,
    context?: { changedBy?: string; reason?: string; metadata?: Record<string, unknown> },
  ): StateChangeEvent<TState> {
    this.validate(from, to, resourceId);
    return {
      resourceType: this.inner.name,
      resourceId,
      fromState: from,
      toState: to,
      changedAt: new Date(),
      changedBy: context?.changedBy,
      reason: context?.reason,
      metadata: context?.metadata,
    };
  }
}

// ─── Transaction State Machine ───
export const TRANSACTION_STATE_MACHINE = new StateMachine<TransactionStatusValue>(
  new Map<TransactionStatusValue, Set<TransactionStatusValue>>([
    [TRANSACTION_STATUS.PENDING, new Set([
      TRANSACTION_STATUS.PAYMENT_INITIATED, TRANSACTION_STATUS.PROCESSING,
      TRANSACTION_STATUS.VERIFIED, TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.CANCELLED,
    ])],
    [TRANSACTION_STATUS.PAYMENT_INITIATED, new Set([
      TRANSACTION_STATUS.PROCESSING, TRANSACTION_STATUS.VERIFIED,
      TRANSACTION_STATUS.REQUIRES_ACTION, TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.CANCELLED,
    ])],
    [TRANSACTION_STATUS.PROCESSING, new Set([
      TRANSACTION_STATUS.VERIFIED, TRANSACTION_STATUS.REQUIRES_ACTION, TRANSACTION_STATUS.FAILED,
    ])],
    [TRANSACTION_STATUS.REQUIRES_ACTION, new Set([
      TRANSACTION_STATUS.VERIFIED, TRANSACTION_STATUS.FAILED,
      TRANSACTION_STATUS.CANCELLED, TRANSACTION_STATUS.EXPIRED,
    ])],
    [TRANSACTION_STATUS.VERIFIED, new Set([
      TRANSACTION_STATUS.COMPLETED, TRANSACTION_STATUS.REFUNDED,
      TRANSACTION_STATUS.PARTIALLY_REFUNDED, TRANSACTION_STATUS.CANCELLED,
    ])],
    [TRANSACTION_STATUS.COMPLETED, new Set([
      TRANSACTION_STATUS.REFUNDED, TRANSACTION_STATUS.PARTIALLY_REFUNDED,
    ])],
    [TRANSACTION_STATUS.PARTIALLY_REFUNDED, new Set([TRANSACTION_STATUS.REFUNDED])],
    [TRANSACTION_STATUS.FAILED, new Set([])],
    [TRANSACTION_STATUS.REFUNDED, new Set([])],
    [TRANSACTION_STATUS.CANCELLED, new Set([])],
    [TRANSACTION_STATUS.EXPIRED, new Set([])],
  ]),
  'transaction',
);

// ─── Subscription State Machine ───
export const SUBSCRIPTION_STATE_MACHINE = new StateMachine<SubscriptionStatusValue>(
  new Map<SubscriptionStatusValue, Set<SubscriptionStatusValue>>([
    [SUBSCRIPTION_STATUS.PENDING, new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.CANCELLED])],
    [SUBSCRIPTION_STATUS.ACTIVE, new Set([
      SUBSCRIPTION_STATUS.PAUSED, SUBSCRIPTION_STATUS.PENDING_RENEWAL,
      SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.EXPIRED,
    ])],
    [SUBSCRIPTION_STATUS.PENDING_RENEWAL, new Set([
      SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.CANCELLED, SUBSCRIPTION_STATUS.EXPIRED,
    ])],
    [SUBSCRIPTION_STATUS.PAUSED, new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.CANCELLED])],
    [SUBSCRIPTION_STATUS.INACTIVE, new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.CANCELLED])],
    [SUBSCRIPTION_STATUS.CANCELLED, new Set([])],
    [SUBSCRIPTION_STATUS.EXPIRED, new Set([])],
  ]),
  'subscription',
);

// ─── Settlement State Machine ───
export const SETTLEMENT_STATE_MACHINE = new StateMachine<SettlementStatusValue>(
  new Map<SettlementStatusValue, Set<SettlementStatusValue>>([
    [SETTLEMENT_STATUS.PENDING, new Set([SETTLEMENT_STATUS.PROCESSING, SETTLEMENT_STATUS.CANCELLED])],
    [SETTLEMENT_STATUS.PROCESSING, new Set([SETTLEMENT_STATUS.COMPLETED, SETTLEMENT_STATUS.FAILED])],
    [SETTLEMENT_STATUS.FAILED, new Set([SETTLEMENT_STATUS.PENDING, SETTLEMENT_STATUS.CANCELLED])],
    [SETTLEMENT_STATUS.COMPLETED, new Set([])],
    [SETTLEMENT_STATUS.CANCELLED, new Set([])],
  ]),
  'settlement',
);

// ─── Escrow Hold State Machine ───
export const HOLD_STATE_MACHINE = new StateMachine<HoldStatusValue>(
  new Map<HoldStatusValue, Set<HoldStatusValue>>([
    [HOLD_STATUS.HELD, new Set([
      HOLD_STATUS.RELEASED, HOLD_STATUS.PARTIALLY_RELEASED,
      HOLD_STATUS.CANCELLED, HOLD_STATUS.EXPIRED,
    ])],
    [HOLD_STATUS.PARTIALLY_RELEASED, new Set([HOLD_STATUS.RELEASED, HOLD_STATUS.CANCELLED])],
    [HOLD_STATUS.RELEASED, new Set([])],
    [HOLD_STATUS.CANCELLED, new Set([])],
    [HOLD_STATUS.EXPIRED, new Set([])],
  ]),
  'escrow_hold',
);

// ─── Split Payment State Machine ───
export const SPLIT_STATE_MACHINE = new StateMachine<SplitStatusValue>(
  new Map<SplitStatusValue, Set<SplitStatusValue>>([
    [SPLIT_STATUS.PENDING, new Set([
      SPLIT_STATUS.DUE, SPLIT_STATUS.PAID, SPLIT_STATUS.WAIVED, SPLIT_STATUS.CANCELLED,
    ])],
    [SPLIT_STATUS.DUE, new Set([SPLIT_STATUS.PAID, SPLIT_STATUS.WAIVED, SPLIT_STATUS.CANCELLED])],
    [SPLIT_STATUS.PAID, new Set([])],
    [SPLIT_STATUS.WAIVED, new Set([])],
    [SPLIT_STATUS.CANCELLED, new Set([])],
  ]),
  'split',
);
