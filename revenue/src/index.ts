/**
 * @classytic/revenue
 * Enterprise Revenue Management System
 *
 * Modern • Type-safe • Resilient • Composable
 *
 * @version 1.1.3
 * @author Classytic
 * @license MIT
 */

// ============================================================================
// CORE API - Main exports
// ============================================================================

export {
  Revenue,
  RevenueBuilder,
  createRevenue,
  type RevenueOptions,
  type ModelsConfig,
  type ProvidersConfig,
} from './core/revenue.js';

// ============================================================================
// ESSENTIAL UTILITIES
// ============================================================================

export {
  Money,
  toSmallestUnit,
  fromSmallestUnit,
  type MoneyValue,
} from './shared/utils/formatters/money.js';

export {
  Result,
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  type Ok,
  type Err,
} from './core/result.js';

// ============================================================================
// PROVIDER SYSTEM
// ============================================================================

export {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from './providers/base.js';

// ============================================================================
// ERROR CLASSES
// ============================================================================

export * from './core/errors.js';

// ============================================================================
// STATE MACHINES
// ============================================================================

export {
  StateMachine,
  TRANSACTION_STATE_MACHINE,
  SUBSCRIPTION_STATE_MACHINE,
  SETTLEMENT_STATE_MACHINE,
  HOLD_STATE_MACHINE,
  SPLIT_STATE_MACHINE,
} from './core/state-machine/index.js';

// ============================================================================
// AUDIT TRAIL
// ============================================================================

export type { StateChangeEvent } from './infrastructure/audit/index.js';
export {
  appendAuditEvent,
  getAuditTrail,
  getLastStateChange,
  filterAuditTrail,
} from './infrastructure/audit/index.js';

// ============================================================================
// TRANSACTION INTERFACE (for app-level schema)
// ============================================================================

export type {
  ITransaction,
  ITransactionCreateInput
} from './shared/types/transaction.interface.js';

// ============================================================================
// IMPORT GUIDE
// ============================================================================

/**
 * For advanced features, import from submodules:
 *
 * @example
 * ```ts
 * // Plugins
 * import { loggingPlugin, auditPlugin, createTaxPlugin } from '@classytic/revenue/plugins';
 *
 * // Enums
 * import { TRANSACTION_STATUS, PAYMENT_STATUS } from '@classytic/revenue/enums';
 *
 * // Events
 * import { EventBus, type RevenueEvents } from '@classytic/revenue/events';
 *
 * // Schemas
 * import { CreatePaymentSchema, transactionSchema } from '@classytic/revenue/schemas';
 *
 * // Utilities
 * import { retry, calculateCommission } from '@classytic/revenue/utils';
 *
 * // Services (advanced)
 * import { MonetizationService } from '@classytic/revenue/services';
 *
 * // Reconciliation
 * import { reconcileSettlement } from '@classytic/revenue/reconciliation';
 * ```
 */

