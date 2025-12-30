/**
 * Reconciliation Utilities
 * @classytic/revenue
 *
 * Compare gateway settlement reports with database transactions
 * Find missing transactions, amount mismatches, and discrepancies
 */

import type {
  GatewaySettlement,
  ReconciliationOptions,
  ReconciliationReport,
  Discrepancy,
} from '../shared/types/reconciliation.js';
import type { TransactionDocument, MongooseModel } from '../shared/types/index.js';

/**
 * Reconcile gateway settlements with database transactions
 *
 * Compares payment gateway's settlement report with your database to identify:
 * - Transactions in gateway but missing in DB
 * - Transactions in DB but missing in gateway
 * - Amount mismatches between gateway and DB
 *
 * @param gatewaySettlements - Settlement data from payment gateway
 * @param TransactionModel - Mongoose Transaction model
 * @param options - Reconciliation options
 * @returns Reconciliation report with findings
 *
 * @example
 * ```typescript
 * import { reconcileSettlement } from '@classytic/revenue/reconciliation';
 *
 * // Get Stripe settlements for January
 * const stripeSettlements = await stripe.balanceTransactions.list({
 *   created: { gte: jan1, lte: jan31 },
 * });
 *
 * // Reconcile with database
 * const report = await reconcileSettlement(
 *   stripeSettlements.data.map(s => ({
 *     settlementId: s.id,
 *     transactionId: s.source,
 *     amount: s.amount,
 *     currency: s.currency,
 *     settledAt: new Date(s.created * 1000),
 *     gatewayFee: s.fee,
 *     netAmount: s.net,
 *   })),
 *   TransactionModel,
 *   { gateway: 'stripe', startDate: jan1, endDate: jan31 }
 * );
 *
 * console.log(report.summary);
 * // { matched: 1245, missing: 2, extra: 1, amountMismatches: 3 }
 * ```
 */
export async function reconcileSettlement(
  gatewaySettlements: GatewaySettlement[],
  TransactionModel: MongooseModel<TransactionDocument>,
  options: ReconciliationOptions = {}
): Promise<ReconciliationReport> {
  const {
    organizationId,
    gateway,
    startDate,
    endDate,
    autoMatch: _autoMatch = true,
    amountTolerance = 1, // 1 cent tolerance
  } = options;

  // Build query for DB transactions
  const query: Record<string, unknown> = {};
  if (organizationId) query.organizationId = organizationId;
  if (gateway) query['gateway.type'] = gateway;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) (query.createdAt as Record<string, unknown>).$gte = startDate;
    if (endDate) (query.createdAt as Record<string, unknown>).$lte = endDate;
  }

  // Get database transactions
  const dbTransactions = await (TransactionModel as unknown as {
    find(filter: object): Promise<TransactionDocument[]>;
  }).find(query);

  // Create lookup maps
  const gatewayMap = new Map<string, GatewaySettlement>();
  const dbMap = new Map<string, TransactionDocument>();

  for (const settlement of gatewaySettlements) {
    gatewayMap.set(settlement.transactionId, settlement);
  }

  for (const transaction of dbTransactions) {
    // Use gateway.paymentIntentId as the key for matching
    const key = (transaction.gateway?.paymentIntentId || transaction._id.toString());
    dbMap.set(key, transaction);
  }

  // Initialize report
  const report: ReconciliationReport = {
    summary: {
      totalGatewayTransactions: gatewaySettlements.length,
      totalDbTransactions: dbTransactions.length,
      matched: 0,
      missing: 0,
      extra: 0,
      amountMismatches: 0,
      totalAmountDiff: 0,
    },
    missingInDb: [],
    missingInGateway: [],
    amountMismatches: [],
    matched: [],
    metadata: {
      reconciledAt: new Date(),
      period: { start: startDate, end: endDate },
      gateway,
      organizationId,
    },
  };

  // Find matches and mismatches
  for (const [gatewayTxId, gatewaySettlement] of gatewayMap.entries()) {
    const dbTransaction = dbMap.get(gatewayTxId);

    if (!dbTransaction) {
      // Missing in DB
      report.missingInDb.push(gatewaySettlement);
      report.summary.missing++;
    } else {
      // Found - check amount
      const amountDiff = Math.abs(dbTransaction.amount - gatewaySettlement.amount);

      if (amountDiff > amountTolerance) {
        // Amount mismatch
        report.amountMismatches.push({
          transactionId: gatewayTxId,
          gatewayAmount: gatewaySettlement.amount,
          dbAmount: dbTransaction.amount,
          diff: dbTransaction.amount - gatewaySettlement.amount,
          transaction: dbTransaction,
          gatewayRecord: gatewaySettlement,
        });
        report.summary.amountMismatches++;
        report.summary.totalAmountDiff += amountDiff;
      } else {
        // Matched!
        report.matched.push({
          transactionId: gatewayTxId,
          amount: dbTransaction.amount,
          transaction: dbTransaction,
          gatewayRecord: gatewaySettlement,
        });
        report.summary.matched++;
      }

      // Mark as processed
      dbMap.delete(gatewayTxId);
    }
  }

  // Remaining DB transactions = extra (not in gateway)
  for (const [_, transaction] of dbMap.entries()) {
    report.missingInGateway.push(transaction);
    report.summary.extra++;
  }

  return report;
}

/**
 * Find transactions missing in database
 *
 * @param organizationId - Organization to check
 * @param dateRange - Date range to search
 * @param gateway - Payment gateway
 * @param TransactionModel - Mongoose Transaction model
 * @returns Missing transaction IDs
 */
export async function findMissingTransactions(
  _organizationId: string,
  _dateRange: { start: Date; end: Date },
  _gateway: string,
  _TransactionModel: MongooseModel<TransactionDocument>
): Promise<{ inGateway: string[]; inDb: string[] }> {
  // This is a simplified version - in production, you'd fetch from gateway API
  // For now, return structure for apps to implement
  return {
    inGateway: [], // Transactions in gateway but not in DB
    inDb: [],      // Transactions in DB but not confirmed by gateway
  };
}

/**
 * Find amount mismatches between gateway and database
 *
 * @param organizationId - Organization to check
 * @param dateRange - Date range to search
 * @param threshold - Amount difference threshold (cents)
 * @param TransactionModel - Mongoose Transaction model
 * @returns Array of mismatches
 */
export async function findAmountMismatches(
  _organizationId: string,
  _dateRange: { start: Date; end: Date },
  _threshold: number = 1,
  _TransactionModel: MongooseModel<TransactionDocument>
): Promise<Array<{ transactionId: string; diff: number }>> {
  // This is a stub function for apps to implement
  // In production, query transactions and compare with gateway data

  const mismatches: Array<{ transactionId: string; diff: number }> = [];

  return mismatches;
}

/**
 * Generate reconciliation discrepancies
 *
 * @param report - Reconciliation report
 * @returns Array of discrepancies sorted by severity
 */
export function generateDiscrepancies(report: ReconciliationReport): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];

  // Missing in DB (HIGH severity)
  for (const gateway of report.missingInDb) {
    discrepancies.push({
      type: 'missing_in_db',
      transactionId: gateway.transactionId,
      severity: 'high',
      description: `Transaction ${gateway.transactionId} found in gateway (${gateway.amount} ${gateway.currency}) but missing in database`,
      gatewayData: gateway,
    });
  }

  // Missing in gateway (MEDIUM severity)
  for (const transaction of report.missingInGateway) {
    discrepancies.push({
      type: 'missing_in_gateway',
      transactionId: transaction._id.toString(),
      severity: 'medium',
      description: `Transaction ${transaction._id} found in database but not in gateway report`,
      dbData: transaction,
    });
  }

  // Amount mismatches (severity based on amount)
  for (const mismatch of report.amountMismatches) {
    const severity: 'low' | 'medium' | 'high' = Math.abs(mismatch.diff) > 1000 ? 'high' : Math.abs(mismatch.diff) > 100 ? 'medium' : 'low';

    discrepancies.push({
      type: 'amount_mismatch',
      transactionId: mismatch.transactionId,
      severity,
      description: `Amount mismatch: Gateway shows ${mismatch.gatewayAmount}, DB shows ${mismatch.dbAmount} (diff: ${mismatch.diff})`,
      gatewayData: mismatch.gatewayRecord,
      dbData: mismatch.transaction,
      diff: mismatch.diff,
    });
  }

  // Sort by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  discrepancies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return discrepancies;
}
