/**
 * Generic State Machine Validator
 * @classytic/revenue
 *
 * Inspired by Stripe's state transition validation
 * Provides centralized, type-safe state transition management
 */

import { InvalidStateTransitionError } from '../errors.js';
import type { StateChangeEvent } from '../../infrastructure/audit/types.js';

/**
 * Generic State Machine for validating state transitions
 *
 * @template TState - The state type (typically a union of string literals)
 *
 * @example
 * ```typescript
 * const stateMachine = new StateMachine(
 *   new Map([
 *     ['pending', new Set(['processing', 'failed'])],
 *     ['processing', new Set(['completed', 'failed'])],
 *     ['completed', new Set([])], // Terminal state
 *     ['failed', new Set([])],     // Terminal state
 *   ]),
 *   'payment'
 * );
 *
 * // Validate transition
 * stateMachine.validate('pending', 'processing', 'pay_123'); // ✅ OK
 * stateMachine.validate('completed', 'pending', 'pay_123');  // ❌ Throws InvalidStateTransitionError
 *
 * // Check without throwing
 * stateMachine.canTransition('pending', 'processing'); // true
 * stateMachine.canTransition('completed', 'pending');  // false
 * ```
 */
export class StateMachine<TState extends string> {
  /**
   * @param transitions - Map of state → allowed next states
   * @param resourceType - Type of resource (for error messages)
   */
  constructor(
    private readonly transitions: Map<TState, Set<TState>>,
    private readonly resourceType: string
  ) {}

  /**
   * Validate state transition is allowed
   *
   * @param from - Current state
   * @param to - Target state
   * @param resourceId - ID of the resource being transitioned
   * @throws InvalidStateTransitionError if transition is invalid
   *
   * @example
   * ```typescript
   * try {
   *   stateMachine.validate('pending', 'completed', 'tx_123');
   * } catch (error) {
   *   if (error instanceof InvalidStateTransitionError) {
   *     console.error('Invalid transition:', error.message);
   *   }
   * }
   * ```
   */
  validate(
    from: TState,
    to: TState,
    resourceId: string
  ): void {
    const allowedTransitions = this.transitions.get(from);

    if (!allowedTransitions?.has(to)) {
      throw new InvalidStateTransitionError(
        this.resourceType,
        resourceId,
        from,
        to
      );
    }
  }

  /**
   * Check if transition is valid (non-throwing)
   *
   * @param from - Current state
   * @param to - Target state
   * @returns true if transition is allowed
   *
   * @example
   * ```typescript
   * if (stateMachine.canTransition('pending', 'processing')) {
   *   // Safe to proceed with transition
   *   transaction.status = 'processing';
   * }
   * ```
   */
  canTransition(from: TState, to: TState): boolean {
    return this.transitions.get(from)?.has(to) ?? false;
  }

  /**
   * Get all allowed next states from current state
   *
   * @param from - Current state
   * @returns Array of allowed next states
   *
   * @example
   * ```typescript
   * const nextStates = stateMachine.getAllowedTransitions('pending');
   * console.log(nextStates); // ['processing', 'failed']
   * ```
   */
  getAllowedTransitions(from: TState): TState[] {
    return Array.from(this.transitions.get(from) ?? []);
  }

  /**
   * Check if state is terminal (no outgoing transitions)
   *
   * @param state - State to check
   * @returns true if state has no outgoing transitions
   *
   * @example
   * ```typescript
   * stateMachine.isTerminalState('completed'); // true
   * stateMachine.isTerminalState('pending');   // false
   * ```
   */
  isTerminalState(state: TState): boolean {
    const transitions = this.transitions.get(state);
    return !transitions || transitions.size === 0;
  }

  /**
   * Get the resource type this state machine manages
   *
   * @returns Resource type string
   */
  getResourceType(): string {
    return this.resourceType;
  }

  /**
   * Validate state transition and create audit event
   *
   * This is a convenience method that combines validation with audit event creation.
   * Use this when you want to both validate a transition and record it in the audit trail.
   *
   * @param from - Current state
   * @param to - Target state
   * @param resourceId - ID of the resource being transitioned
   * @param context - Optional audit context (who, why, metadata)
   * @returns StateChangeEvent ready to be appended to document metadata
   * @throws InvalidStateTransitionError if transition is invalid
   *
   * @example
   * ```typescript
   * import { appendAuditEvent } from '@classytic/revenue';
   *
   * // Validate and create audit event
   * const auditEvent = TRANSACTION_STATE_MACHINE.validateAndCreateAuditEvent(
   *   transaction.status,
   *   'verified',
   *   transaction._id.toString(),
   *   {
   *     changedBy: 'admin_123',
   *     reason: 'Payment verified by payment gateway',
   *     metadata: { verificationId: 'ver_abc' }
   *   }
   * );
   *
   * // Apply state change
   * transaction.status = 'verified';
   *
   * // Append audit event to metadata
   * Object.assign(transaction, appendAuditEvent(transaction, auditEvent));
   *
   * // Save
   * await transaction.save();
   * ```
   */
  validateAndCreateAuditEvent(
    from: TState,
    to: TState,
    resourceId: string,
    context?: {
      changedBy?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  ): StateChangeEvent<TState> {
    // First validate the transition (throws if invalid)
    this.validate(from, to, resourceId);

    // Then create and return the audit event
    return {
      resourceType: this.resourceType,
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
