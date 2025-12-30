/**
 * Infrastructure Module
 * @classytic/revenue
 *
 * Core infrastructure components and utilities
 */

// ============ AUDIT TRAIL ============
export type { StateChangeEvent } from './audit/index.js';
export {
  appendAuditEvent,
  getAuditTrail,
  getLastStateChange,
  filterAuditTrail,
} from './audit/index.js';

// ============ CONFIGURATION ============
export {
  resolveConfig,
  getCommissionRate,
  getGatewayFeeRate,
  mergeConfig,
} from './config/index.js';

// ============ PLUGINS ============
export {
  loggingPlugin,
  auditPlugin,
  metricsPlugin,
  createTaxPlugin,
  definePlugin,
  type LoggingPluginOptions,
  type AuditPluginOptions,
  type AuditEntry,
  type MetricsPluginOptions,
  type Metric,
  type TaxPluginOptions,
} from './plugins/index.js';
