/**
 * Reconciliation Types
 * @classytic/revenue
 *
 * Types for comparing gateway reports with database records
 */

import type { TransactionDocument } from './index.js';

/**
 * Gateway Settlement Record
 * Data from payment gateway's settlement report (Stripe, PayPal, etc.)
 */
export interface GatewaySettlement {
  /** Settlement ID from gateway */
  settlementId: string;

  /** Transaction/payment ID from gateway */
  transactionId: string;

  /** Amount settled */
  amount: number;

  /** Currency */
  currency: string;

  /** When funds were settled */
  settledAt: Date;

  /** Gateway fee deducted */
  gatewayFee?: number;

  /** Net amount received (amount - gatewayFee) */
  netAmount?: number;

  /** Payment status in gateway */
  status?: string;

  /** Additional gateway metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Reconciliation Options
 * Configuration for reconciliation process
 */
export interface ReconciliationOptions {
  /** Filter by organization */
  organizationId?: string;

  /** Filter by payment gateway */
  gateway?: string;

  /** Start date for reconciliation period */
  startDate?: Date;

  /** End date for reconciliation period */
  endDate?: Date;

  /** Automatically match by transactionId */
  autoMatch?: boolean;

  /** Tolerance for amount mismatches (in cents) */
  amountTolerance?: number;
}

/**
 * Reconciliation Report
 * Result of reconciling gateway settlements with database transactions
 */
export interface ReconciliationReport {
  /** Summary statistics */
  summary: {
    /** Total transactions in gateway report */
    totalGatewayTransactions: number;

    /** Total transactions in database */
    totalDbTransactions: number;

    /** Number of matched transactions */
    matched: number;

    /** Number missing in database */
    missing: number;

    /** Number extra in database (not in gateway) */
    extra: number;

    /** Number with amount mismatches */
    amountMismatches: number;

    /** Total amount difference across all mismatches */
    totalAmountDiff: number;
  };

  /** Transactions in gateway but not in database */
  missingInDb: GatewaySettlement[];

  /** Transactions in database but not in gateway */
  missingInGateway: TransactionDocument[];

  /** Transactions with amount mismatches */
  amountMismatches: Array<{
    transactionId: string;
    gatewayAmount: number;
    dbAmount: number;
    diff: number;
    transaction?: TransactionDocument;
    gatewayRecord?: GatewaySettlement;
  }>;

  /** Successfully matched transactions */
  matched: Array<{
    transactionId: string;
    amount: number;
    transaction: TransactionDocument;
    gatewayRecord: GatewaySettlement;
  }>;

  /** Reconciliation metadata */
  metadata: {
    reconciledAt: Date;
    period: { start?: Date; end?: Date };
    gateway?: string;
    organizationId?: string;
  };
}

/**
 * Discrepancy Type
 */
export type DiscrepancyType =
  | 'missing_in_db'
  | 'missing_in_gateway'
  | 'amount_mismatch'
  | 'status_mismatch';

/**
 * Discrepancy Record
 * Individual reconciliation discrepancy
 */
export interface Discrepancy {
  type: DiscrepancyType;
  transactionId: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  gatewayData?: GatewaySettlement;
  dbData?: TransactionDocument;
  diff?: number;
}
