/**
 * Audit Plugin
 * @classytic/revenue
 *
 * Records all operations for compliance and audit trails
 */

import { definePlugin, type RevenuePlugin } from '../../../core/plugin.js';

/**
 * Audit entry record
 */
export interface AuditEntry {
  action: string;
  requestId: string;
  timestamp: Date;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Audit plugin options
 */
export interface AuditPluginOptions {
  /** Custom storage function for audit entries */
  store?: (entry: AuditEntry) => Promise<void>;
}

/**
 * Sanitize input by removing sensitive fields
 * @private
 */
function sanitizeInput(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || !input) return {};
  const sanitized = { ...input } as Record<string, unknown>;
  // Remove sensitive fields
  delete sanitized.apiKey;
  delete sanitized.secretKey;
  delete sanitized.password;
  return sanitized;
}

/**
 * Sanitize output
 * @private
 */
function sanitizeOutput(output: unknown): Record<string, unknown> {
  if (typeof output !== 'object' || !output) return {};
  return { ...output } as Record<string, unknown>;
}

/**
 * Audit plugin - records all operations for compliance
 *
 * Records payment creation, refunds, and other operations with sanitized data
 *
 * @param options - Plugin options
 * @returns Audit plugin
 *
 * @example
 * ```typescript
 * import { Revenue } from '@classytic/revenue';
 * import { auditPlugin } from '@classytic/revenue/plugins';
 *
 * const revenue = Revenue
 *   .create()
 *   .withPlugin(auditPlugin({
 *     store: async (entry) => {
 *       await AuditLog.create(entry);
 *     }
 *   }))
 *   .build();
 * ```
 */
export function auditPlugin(options: AuditPluginOptions = {}): RevenuePlugin {
  const entries: AuditEntry[] = [];

  const store = options.store ?? (async (entry: AuditEntry) => {
    entries.push(entry);
  });

  return definePlugin({
    name: 'audit',
    version: '1.0.0',
    description: 'Audit trail for all operations',
    hooks: {
      'payment.create.after': async (ctx, input, next) => {
        const result = await next();
        await store({
          action: 'payment.create',
          requestId: ctx.meta.requestId,
          timestamp: ctx.meta.timestamp,
          input: sanitizeInput(input),
          output: sanitizeOutput(result),
          idempotencyKey: ctx.meta.idempotencyKey,
        });
        return result;
      },
      'payment.refund.after': async (ctx, input, next) => {
        const result = await next();
        await store({
          action: 'payment.refund',
          requestId: ctx.meta.requestId,
          timestamp: ctx.meta.timestamp,
          input: sanitizeInput(input),
          output: sanitizeOutput(result),
          idempotencyKey: ctx.meta.idempotencyKey,
        });
        return result;
      },
    },
  });
}

export default auditPlugin;
