/**
 * Metrics Plugin
 * @classytic/revenue
 *
 * Collects operation metrics (duration, success/failure)
 */

import { definePlugin, type RevenuePlugin } from '../../../core/plugin.js';

/**
 * Metric record
 */
export interface Metric {
  name: string;
  duration: number;
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Metrics plugin options
 */
export interface MetricsPluginOptions {
  /** Callback for each metric */
  onMetric?: (metric: Metric) => void;
}

/**
 * Metrics plugin - collects operation metrics
 *
 * Tracks duration and success/failure of operations
 *
 * @param options - Plugin options
 * @returns Metrics plugin
 *
 * @example
 * ```typescript
 * import { Revenue } from '@classytic/revenue';
 * import { metricsPlugin } from '@classytic/revenue/plugins';
 *
 * const revenue = Revenue
 *   .create()
 *   .withPlugin(metricsPlugin({
 *     onMetric: (metric) => {
 *       // Send to Datadog, Prometheus, etc.
 *       statsd.timing(metric.name, metric.duration);
 *       if (!metric.success) {
 *         statsd.increment(`${metric.name}.error`);
 *       }
 *     }
 *   }))
 *   .build();
 * ```
 */
export function metricsPlugin(options: MetricsPluginOptions = {}): RevenuePlugin {
  const metrics: Metric[] = [];

  const record = options.onMetric ?? ((metric: Metric) => {
    metrics.push(metric);
  });

  return definePlugin({
    name: 'metrics',
    version: '1.0.0',
    description: 'Collects operation metrics',
    hooks: {
      'payment.create.before': async (_ctx, input, next) => {
        const start = Date.now();
        try {
          const result = await next();
          record({
            name: 'payment.create',
            duration: Date.now() - start,
            success: true,
            amount: input.amount,
            currency: input.currency,
          });
          return result;
        } catch (error) {
          record({
            name: 'payment.create',
            duration: Date.now() - start,
            success: false,
            error: (error as Error).message,
          });
          throw error;
        }
      },
    },
  });
}

export default metricsPlugin;
