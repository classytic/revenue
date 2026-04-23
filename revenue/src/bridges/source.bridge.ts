import type { RevenueContext } from '../core/context.js';

/**
 * SourceBridge — resolve polymorphic source documents (Order, Invoice, Subscription, etc.)
 *
 * Revenue stores `sourceId` as a String to support any ID format:
 *   • Mongoose ObjectId hex strings (same MongoDB)
 *   • UUIDs (Postgres, external systems)
 *   • Stripe IDs (pi_..., ch_..., sub_...)
 *   • REST API IDs (any string)
 *
 * The host implements this bridge to teach revenue how to load source documents.
 *
 * @example Same MongoDB, same connection
 * ```typescript
 * const sourceBridge: SourceBridge = {
 *   async resolve(sourceId, sourceModel, ctx) {
 *     const Model = mongoose.connection.models[sourceModel];
 *     return Model ? await Model.findById(sourceId).lean() : null;
 *   },
 * };
 * ```
 *
 * @example Microservices (cross-DB Mongoose)
 * ```typescript
 * const sourceBridge: SourceBridge = {
 *   async resolve(sourceId, sourceModel, ctx) {
 *     if (sourceModel === 'Order') return await ordersDb.collection('orders').findOne({ _id: sourceId });
 *     if (sourceModel === 'Invoice') return await invoicesDb.collection('invoices').findOne({ _id: sourceId });
 *     return null;
 *   },
 * };
 * ```
 *
 * @example External systems (REST/Stripe/Postgres)
 * ```typescript
 * const sourceBridge: SourceBridge = {
 *   async resolve(sourceId, sourceModel, ctx) {
 *     if (sourceModel === 'StripeCharge') {
 *       return await stripe.charges.retrieve(sourceId);
 *     }
 *     if (sourceModel === 'PostgresOrder') {
 *       const { rows } = await pg.query('SELECT * FROM orders WHERE id = $1', [sourceId]);
 *       return rows[0];
 *     }
 *     return null;
 *   },
 * };
 * ```
 *
 * @example Batch resolution (perf optimization)
 * ```typescript
 * const sourceBridge: SourceBridge = {
 *   async resolve(sourceId, sourceModel, ctx) { ... },
 *   async resolveMany(refs, ctx) {
 *     // Group by sourceModel, batch fetch, return Map<sourceId, doc>
 *     const result = new Map();
 *     const byModel = groupBy(refs, r => r.sourceModel);
 *     for (const [model, batch] of byModel) {
 *       const ids = batch.map(b => b.sourceId);
 *       const docs = await mongoose.connection.models[model].find({ _id: { $in: ids } }).lean();
 *       docs.forEach(d => result.set(String(d._id), d));
 *     }
 *     return result;
 *   },
 * };
 * ```
 */
export interface SourceBridge {
  /**
   * Resolve a single source document by sourceId + sourceModel.
   * Returns null if not found or if the bridge can't handle this sourceModel.
   */
  resolve?(sourceId: string, sourceModel: string, ctx: RevenueContext): Promise<unknown | null>;

  /**
   * Optional batch resolver for performance (avoids N+1 in list endpoints).
   * Returns a Map keyed by sourceId.
   */
  resolveMany?(
    refs: Array<{ sourceId: string; sourceModel: string }>,
    ctx: RevenueContext,
  ): Promise<Map<string, unknown>>;
}
