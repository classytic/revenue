/**
 * Built-in Plugins
 * @classytic/revenue/plugins
 *
 * Collection of built-in plugins for common use cases
 */

// Export plugin functions
export { loggingPlugin, type LoggingPluginOptions } from './business/logging.plugin.js';
export { auditPlugin, type AuditPluginOptions, type AuditEntry } from './business/audit.plugin.js';
export { metricsPlugin, type MetricsPluginOptions, type Metric } from './business/metrics.plugin.js';
export { createTaxPlugin, type TaxPluginOptions } from './business/tax.plugin.js';

// Re-export definePlugin for custom plugins
export { definePlugin } from '../../core/plugin.js';

// Default export with all plugins
import { loggingPlugin } from './business/logging.plugin.js';
import { auditPlugin } from './business/audit.plugin.js';
import { metricsPlugin } from './business/metrics.plugin.js';
import { createTaxPlugin } from './business/tax.plugin.js';

export default {
  loggingPlugin,
  auditPlugin,
  metricsPlugin,
  createTaxPlugin,
};
