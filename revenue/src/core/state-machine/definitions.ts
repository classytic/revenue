/**
 * State Machine Definitions
 * @classytic/revenue
 *
 * Centralized state transition rules for all entities
 * Inspired by Stripe, PayPal, and Shopify state management patterns
 */

import { StateMachine } from './StateMachine.js';
import {
  TRANSACTION_STATUS,
  type TransactionStatusValue,
} from '../../enums/transaction.enums.js';
import {
  SUBSCRIPTION_STATUS,
  type SubscriptionStatusValue,
} from '../../enums/subscription.enums.js';
import {
  SETTLEMENT_STATUS,
  type SettlementStatusValue,
} from '../../enums/settlement.enums.js';
import {
  HOLD_STATUS,
  type HoldStatusValue,
} from '../../enums/escrow.enums.js';
import {
  SPLIT_STATUS,
  type SplitStatusValue,
} from '../../enums/split.enums.js';

/**
 * Transaction State Machine
 *
 * Flow:
 * ```
 * pending → payment_initiated → processing → verified → completed
 *           ↓                    ↓           ↓
 *         failed         requires_action  refunded
 *                                ↓       partially_refunded
 *                             failed
 * ```
 *
 * Terminal states: failed, refunded, cancelled, expired
 */
export const TRANSACTION_STATE_MACHINE = new StateMachine<TransactionStatusValue>(
  new Map<TransactionStatusValue, Set<TransactionStatusValue>>([
    [
      TRANSACTION_STATUS.PENDING,
      new Set([
        TRANSACTION_STATUS.PAYMENT_INITIATED,
        TRANSACTION_STATUS.PROCESSING,
        TRANSACTION_STATUS.VERIFIED, // Allow direct verification (manual payments)
        TRANSACTION_STATUS.FAILED,
        TRANSACTION_STATUS.CANCELLED,
      ]),
    ],
    [
      TRANSACTION_STATUS.PAYMENT_INITIATED,
      new Set([
        TRANSACTION_STATUS.PROCESSING,
        TRANSACTION_STATUS.VERIFIED, // Allow direct verification (webhook/instant payments)
        TRANSACTION_STATUS.REQUIRES_ACTION,
        TRANSACTION_STATUS.FAILED,
        TRANSACTION_STATUS.CANCELLED,
      ]),
    ],
    [
      TRANSACTION_STATUS.PROCESSING,
      new Set([
        TRANSACTION_STATUS.VERIFIED,
        TRANSACTION_STATUS.REQUIRES_ACTION,
        TRANSACTION_STATUS.FAILED,
      ]),
    ],
    [
      TRANSACTION_STATUS.REQUIRES_ACTION,
      new Set([
        TRANSACTION_STATUS.VERIFIED,
        TRANSACTION_STATUS.FAILED,
        TRANSACTION_STATUS.CANCELLED,
        TRANSACTION_STATUS.EXPIRED,
      ]),
    ],
    [
      TRANSACTION_STATUS.VERIFIED,
      new Set([
        TRANSACTION_STATUS.COMPLETED,
        TRANSACTION_STATUS.REFUNDED,
        TRANSACTION_STATUS.PARTIALLY_REFUNDED,
        TRANSACTION_STATUS.CANCELLED,
      ]),
    ],
    [
      TRANSACTION_STATUS.COMPLETED,
      new Set([
        TRANSACTION_STATUS.REFUNDED,
        TRANSACTION_STATUS.PARTIALLY_REFUNDED,
      ]),
    ],
    [
      TRANSACTION_STATUS.PARTIALLY_REFUNDED,
      new Set([TRANSACTION_STATUS.REFUNDED]),
    ],
    // Terminal states
    [TRANSACTION_STATUS.FAILED, new Set([])],
    [TRANSACTION_STATUS.REFUNDED, new Set([])],
    [TRANSACTION_STATUS.CANCELLED, new Set([])],
    [TRANSACTION_STATUS.EXPIRED, new Set([])],
  ]),
  'transaction'
);

/**
 * Subscription State Machine
 *
 * Flow:
 * ```
 * pending → active → paused → active
 *            ↓        ↓
 *        cancelled  cancelled
 *            ↓
 *         expired
 * ```
 *
 * Terminal states: cancelled, expired
 */
export const SUBSCRIPTION_STATE_MACHINE = new StateMachine<SubscriptionStatusValue>(
  new Map<SubscriptionStatusValue, Set<SubscriptionStatusValue>>([
    [
      SUBSCRIPTION_STATUS.PENDING,
      new Set([
        SUBSCRIPTION_STATUS.ACTIVE,
        SUBSCRIPTION_STATUS.CANCELLED,
      ]),
    ],
    [
      SUBSCRIPTION_STATUS.ACTIVE,
      new Set([
        SUBSCRIPTION_STATUS.PAUSED,
        SUBSCRIPTION_STATUS.PENDING_RENEWAL,
        SUBSCRIPTION_STATUS.CANCELLED,
        SUBSCRIPTION_STATUS.EXPIRED,
      ]),
    ],
    [
      SUBSCRIPTION_STATUS.PENDING_RENEWAL,
      new Set([
        SUBSCRIPTION_STATUS.ACTIVE,
        SUBSCRIPTION_STATUS.CANCELLED,
        SUBSCRIPTION_STATUS.EXPIRED,
      ]),
    ],
    [
      SUBSCRIPTION_STATUS.PAUSED,
      new Set([
        SUBSCRIPTION_STATUS.ACTIVE,
        SUBSCRIPTION_STATUS.CANCELLED,
      ]),
    ],
    [
      SUBSCRIPTION_STATUS.INACTIVE,
      new Set([
        SUBSCRIPTION_STATUS.ACTIVE,
        SUBSCRIPTION_STATUS.CANCELLED,
      ]),
    ],
    // Terminal states
    [SUBSCRIPTION_STATUS.CANCELLED, new Set([])],
    [SUBSCRIPTION_STATUS.EXPIRED, new Set([])],
  ]),
  'subscription'
);

/**
 * Settlement State Machine
 *
 * Flow:
 * ```
 * pending → processing → completed
 *            ↓
 *          failed → pending (retry allowed)
 * ```
 *
 * Terminal states: completed, cancelled
 * Note: failed can retry to pending
 */
export const SETTLEMENT_STATE_MACHINE = new StateMachine<SettlementStatusValue>(
  new Map<SettlementStatusValue, Set<SettlementStatusValue>>([
    [
      SETTLEMENT_STATUS.PENDING,
      new Set([
        SETTLEMENT_STATUS.PROCESSING,
        SETTLEMENT_STATUS.CANCELLED,
      ]),
    ],
    [
      SETTLEMENT_STATUS.PROCESSING,
      new Set([
        SETTLEMENT_STATUS.COMPLETED,
        SETTLEMENT_STATUS.FAILED,
      ]),
    ],
    [
      SETTLEMENT_STATUS.FAILED,
      new Set([
        SETTLEMENT_STATUS.PENDING,  // Allow retry
        SETTLEMENT_STATUS.CANCELLED,
      ]),
    ],
    // Terminal states
    [SETTLEMENT_STATUS.COMPLETED, new Set([])],
    [SETTLEMENT_STATUS.CANCELLED, new Set([])],
  ]),
  'settlement'
);

/**
 * Escrow Hold State Machine
 *
 * Flow:
 * ```
 * held → partially_released → released
 *  ↓
 * cancelled
 * ```
 *
 * Terminal states: released, cancelled, expired
 */
export const HOLD_STATE_MACHINE = new StateMachine<HoldStatusValue>(
  new Map<HoldStatusValue, Set<HoldStatusValue>>([
    [
      HOLD_STATUS.HELD,
      new Set([
        HOLD_STATUS.RELEASED,
        HOLD_STATUS.PARTIALLY_RELEASED,
        HOLD_STATUS.CANCELLED,
        HOLD_STATUS.EXPIRED,
      ]),
    ],
    [
      HOLD_STATUS.PARTIALLY_RELEASED,
      new Set([
        HOLD_STATUS.RELEASED,
        HOLD_STATUS.CANCELLED,
      ]),
    ],
    // Terminal states
    [HOLD_STATUS.RELEASED, new Set([])],
    [HOLD_STATUS.CANCELLED, new Set([])],
    [HOLD_STATUS.EXPIRED, new Set([])],
  ]),
  'escrow_hold'
);

/**
 * Split Payment State Machine
 *
 * Flow:
 * ```
 * pending → due → paid
 *   ↓
 * waived
 * cancelled
 * ```
 *
 * Terminal states: paid, waived, cancelled
 */
export const SPLIT_STATE_MACHINE = new StateMachine<SplitStatusValue>(
  new Map<SplitStatusValue, Set<SplitStatusValue>>([
    [
      SPLIT_STATUS.PENDING,
      new Set([
        SPLIT_STATUS.DUE,
        SPLIT_STATUS.PAID,
        SPLIT_STATUS.WAIVED,
        SPLIT_STATUS.CANCELLED,
      ]),
    ],
    [
      SPLIT_STATUS.DUE,
      new Set([
        SPLIT_STATUS.PAID,
        SPLIT_STATUS.WAIVED,
        SPLIT_STATUS.CANCELLED,
      ]),
    ],
    // Terminal states
    [SPLIT_STATUS.PAID, new Set([])],
    [SPLIT_STATUS.WAIVED, new Set([])],
    [SPLIT_STATUS.CANCELLED, new Set([])],
  ]),
  'split'
);
