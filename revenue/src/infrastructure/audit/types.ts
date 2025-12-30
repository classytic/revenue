/**
 * Audit Trail Types
 * @classytic/revenue
 *
 * State change tracking for compliance and debugging
 * Stored in document.metadata.stateHistory array
 */

/**
 * State Change Audit Event
 * Records who changed what, when, and why
 *
 * Example usage:
 * ```typescript
 * const event: StateChangeEvent = {
 *   resourceType: 'transaction',
 *   resourceId: 'tx_123',
 *   fromState: 'pending',
 *   toState: 'verified',
 *   changedAt: new Date(),
 *   changedBy: 'admin_user_id',
 *   reason: 'Payment verified by payment gateway',
 *   metadata: { verificationId: 'ver_abc' }
 * };
 * ```
 */
export interface StateChangeEvent<TState = string> {
  /** Type of resource (e.g., 'transaction', 'subscription') */
  resourceType: string;

  /** Unique identifier of the resource */
  resourceId: string;

  /** State before the transition */
  fromState: TState;

  /** State after the transition */
  toState: TState;

  /** Timestamp when the change occurred */
  changedAt: Date;

  /** User ID or system identifier who triggered the change */
  changedBy?: string;

  /** Human-readable reason for the state change */
  reason?: string;

  /** Additional contextual data */
  metadata?: Record<string, unknown>;
}

/**
 * Helper to append audit event to document metadata
 *
 * This is a metadata-based approach that stores audit trail
 * directly in the document's metadata.stateHistory array.
 *
 * Example:
 * ```typescript
 * const transaction = await Transaction.findById(id);
 *
 * const auditEvent = {
 *   resourceType: 'transaction',
 *   resourceId: transaction._id.toString(),
 *   fromState: 'pending',
 *   toState: 'verified',
 *   changedAt: new Date(),
 *   changedBy: 'admin_123',
 * };
 *
 * const updated = appendAuditEvent(transaction, auditEvent);
 * await updated.save();
 * ```
 *
 * @param document - Mongoose document or plain object with optional metadata field
 * @param event - State change event to append
 * @returns Updated document with event in metadata.stateHistory
 */
export function appendAuditEvent<T extends { metadata?: any }>(
  document: T,
  event: StateChangeEvent
): T {
  const stateHistory = document.metadata?.stateHistory ?? [];

  return {
    ...document,
    metadata: {
      ...document.metadata,
      stateHistory: [...stateHistory, event],
    },
  };
}

/**
 * Helper to get audit trail from document metadata
 *
 * Example:
 * ```typescript
 * const transaction = await Transaction.findById(id);
 * const history = getAuditTrail(transaction);
 *
 * console.log(history);
 * // [
 * //   { fromState: 'pending', toState: 'processing', changedAt: ... },
 * //   { fromState: 'processing', toState: 'verified', changedAt: ... },
 * // ]
 * ```
 *
 * @param document - Document to extract audit trail from
 * @returns Array of state change events (empty array if none)
 */
export function getAuditTrail<T extends { metadata?: any }>(
  document: T
): StateChangeEvent[] {
  return document.metadata?.stateHistory ?? [];
}

/**
 * Helper to get the last state change from audit trail
 *
 * @param document - Document to extract last change from
 * @returns Last state change event or undefined if none
 */
export function getLastStateChange<T extends { metadata?: any }>(
  document: T
): StateChangeEvent | undefined {
  const history = getAuditTrail(document);
  return history[history.length - 1];
}

/**
 * Helper to find state changes by criteria
 *
 * Example:
 * ```typescript
 * const transaction = await Transaction.findById(id);
 *
 * // Find all changes made by a specific user
 * const userChanges = filterAuditTrail(transaction, {
 *   changedBy: 'admin_123'
 * });
 *
 * // Find all transitions to 'failed' state
 * const failures = filterAuditTrail(transaction, {
 *   toState: 'failed'
 * });
 * ```
 *
 * @param document - Document to filter audit trail from
 * @param criteria - Filter criteria
 * @returns Filtered array of state change events
 */
export function filterAuditTrail<T extends { metadata?: any }>(
  document: T,
  criteria: Partial<StateChangeEvent>
): StateChangeEvent[] {
  const history = getAuditTrail(document);

  return history.filter((event) => {
    return Object.entries(criteria).every(([key, value]) => {
      return event[key as keyof StateChangeEvent] === value;
    });
  });
}
