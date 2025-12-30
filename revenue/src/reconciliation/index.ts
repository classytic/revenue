/**
 * Reconciliation Module
 * @classytic/revenue/reconciliation
 *
 * Compare gateway reports with database transactions
 */

export {
  reconcileSettlement,
  findMissingTransactions,
  findAmountMismatches,
  generateDiscrepancies,
} from './reconciler.js';

export type {
  GatewaySettlement,
  ReconciliationOptions,
  ReconciliationReport,
  Discrepancy,
  DiscrepancyType,
} from '../shared/types/reconciliation.js';
