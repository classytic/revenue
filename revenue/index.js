/**
 * @classytic/revenue
 * Enterprise Revenue Management System
 *
 * A unified, enterprise-grade revenue management system combining
 * monetization (subscriptions, purchases, proration) and payment processing
 * (verification, refunds, webhooks) into a single, cohesive package.
 *
 * Thin, focused, production-ready library with smart defaults.
 *
 * @version 1.0.0
 * @author Classytic (Classytic)
 * @license MIT
 */

// ============ CORE API ============
export { createRevenue } from './core/builder.js';
export { Container } from './core/container.js';
import { createRevenue as _createRevenue } from './core/builder.js';
import { Container as _Container } from './core/container.js';

// ============ ERROR CLASSES ============
export * from './core/errors.js';
import { RevenueError } from './core/errors.js';

// ============ PROVIDER SYSTEM ============
export {
  PaymentProvider,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  WebhookEvent,
} from './providers/base.js';
import { PaymentProvider as _PaymentProvider } from './providers/base.js';
// Note: ManualProvider moved to @classytic/revenue-manual (separate package)

// ============ SERVICES (ADVANCED USAGE) ============
export { SubscriptionService } from './services/subscription.service.js';
export { PaymentService } from './services/payment.service.js';
export { TransactionService } from './services/transaction.service.js';

// ============ ENUMS & SCHEMAS (FOR INJECTION) ============
export * from './enums/index.js';
export * from './schemas/index.js';

// ============ UTILITIES ============
export {
  logger,
  setLogger,
  calculateCommission,
  reverseCommission,
} from './utils/index.js';

// ============ DEFAULT EXPORT ============
export default {
  createRevenue: _createRevenue,
  PaymentProvider: _PaymentProvider,
  RevenueError,
  Container: _Container,
};
