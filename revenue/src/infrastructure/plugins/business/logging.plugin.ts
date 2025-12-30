/**
 * Logging Plugin
 * @classytic/revenue
 *
 * Logs all revenue operations at specified log level
 */

import { definePlugin, type RevenuePlugin } from '../../../core/plugin.js';

/**
 * Logging plugin options
 */
export interface LoggingPluginOptions {
  /** Log level: 'debug' or 'info' */
  level?: 'debug' | 'info';
}

/**
 * Logging plugin - logs all operations
 *
 * Logs payment creation, verification, and refund operations
 *
 * @param options - Plugin options
 * @returns Logging plugin
 *
 * @example
 * ```typescript
 * import { Revenue } from '@classytic/revenue';
 * import { loggingPlugin } from '@classytic/revenue/plugins';
 *
 * const revenue = Revenue
 *   .create()
 *   .withPlugin(loggingPlugin({ level: 'debug' }))
 *   .build();
 * ```
 */
export function loggingPlugin(options: LoggingPluginOptions = {}): RevenuePlugin {
  const level = options.level ?? 'info';

  return definePlugin({
    name: 'logging',
    version: '1.0.0',
    description: 'Logs all revenue operations',
    hooks: {
      'payment.create.after': async (ctx, input, next) => {
        ctx.logger[level]('Creating payment', { amount: input.amount, currency: input.currency });
        const result = await next();
        ctx.logger[level]('Payment created', { paymentIntentId: result?.paymentIntentId });
        return result;
      },
      'payment.verify.after': async (ctx, input, next) => {
        ctx.logger[level]('Verifying payment', { id: input.id });
        const result = await next();
        ctx.logger[level]('Payment verified', { verified: result?.verified });
        return result;
      },
      'payment.refund.after': async (ctx, input, next) => {
        ctx.logger[level]('Processing refund', { transactionId: input.transactionId, amount: input.amount });
        const result = await next();
        ctx.logger[level]('Refund processed', { refundId: result?.refundId });
        return result;
      },
    },
  });
}

export default loggingPlugin;
