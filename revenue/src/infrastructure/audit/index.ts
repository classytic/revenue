/**
 * Audit Trail Module
 * @classytic/revenue
 *
 * Exports audit trail functionality for state change tracking
 */

export type { StateChangeEvent } from './types.js';
export {
  appendAuditEvent,
  getAuditTrail,
  getLastStateChange,
  filterAuditTrail,
} from './types.js';
