import type { Model } from 'mongoose';
import type { ReturnProofRouteDocument } from '../models/return-proof-route.schema.js';

/**
 * The routing directory for browser returns (digest -> owning tenant). It is the only read that happens
 * before the tenant is known, which is why it lives outside the tenant-scoped payment-attempt collection.
 */
export interface ReturnProofRouteStore {
  /** Record who owns a digest until `expiresAt`. Idempotent: the same digest overwrites itself. */
  put(route: { digest: string; expiresAt: Date; organizationId?: string }): Promise<void>;
  /** The live route for a digest, or null when unknown or expired. */
  find(digest: string): Promise<{ organizationId?: string } | null>;
}

export function createReturnProofRouteStore(model: Model<ReturnProofRouteDocument>): ReturnProofRouteStore {
  return {
    async put({ digest, expiresAt, organizationId }) {
      await model.updateOne(
        { _id: digest },
        { $set: { expiresAt, ...(organizationId ? { organizationId } : {}) }, ...(organizationId ? {} : { $unset: { organizationId: '' } }) },
        { upsert: true },
      );
    },
    async find(digest) {
      // The TTL monitor runs about once a minute, so expiry is also checked here.
      const row = await model.findOne({ _id: digest, expiresAt: { $gt: new Date() } }).lean();
      return row ? { ...(row.organizationId ? { organizationId: row.organizationId } : {}) } : null;
    },
  };
}
