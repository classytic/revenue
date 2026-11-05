import { Schema } from 'mongoose';

/**
 * Routing directory for browser returns: digest of a one-shot return credential → owning tenant.
 *
 * A customer comes back from the provider with only the credential, no tenant, so something outside
 * any tenant must say who owns it. That something is this collection, not a global index on the tenant's
 * payment attempts: a global unique index makes the attempts collection impossible to shard by tenant.
 * The directory is deliberately NOT tenant-injected. It is tiny (one row per live checkout), bounded by a
 * TTL on `expiresAt`, and the `_id` IS the digest, so it needs no secondary index and shards cleanly on
 * `{ _id: 'hashed' }` if it ever has to. It holds a hash and an owner id, never the credential.
 */
export interface ReturnProofRouteDocument {
  /** `returnProofDigest(provider, paymentId, token)`. */
  _id: string;
  /** Owning tenant; absent on an unscoped engine. */
  organizationId?: string;
  expiresAt: Date;
}

export function buildReturnProofRouteSchema(): Schema<ReturnProofRouteDocument> {
  const schema = new Schema<ReturnProofRouteDocument>(
    { _id: { type: String, required: true }, organizationId: { type: String }, expiresAt: { type: Date, required: true } },
    { versionKey: false },
  );
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'return_proof_route_ttl' });
  return schema;
}
