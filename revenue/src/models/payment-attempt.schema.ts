import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import type { PaymentMethodKind } from '@classytic/primitives/payment-method-kind';
import type { RevenueSchemaConfig } from './transaction.schema.js';

/**
 * A single provider attempt for a payment-flow transaction (the PaymentIntent).
 *
 * WHY THIS EXISTS (payments-architecture.md §4.5). The `Transaction`'s single
 * embedded `gateway` block holds only the LAST attempt, so today's model cannot
 * express "three declines then a success". More importantly, the provider call
 * in `createPaymentIntent` happens BEFORE the transaction is persisted — a
 * timeout can leave a live intent upstream with NO local record. The
 * `PaymentAttempt` is that local record: it is written BEFORE the provider call,
 * so its `_id` is a durable anchor (and the source of a collision-free
 * idempotency key when the caller supplies none), and an orphaned/unknown intent
 * is always visible to us for reconciliation.
 *
 * `transactionId` is OPTIONAL and linked AFTER the payment-flow transaction is
 * created — at attempt time the transaction does not exist yet. The attempt is
 * the anchor, not the transaction.
 */
export interface PaymentAttemptDocument {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  organizationId?: string;
  /** Linked after the payment-flow transaction is persisted (absent for an orphaned attempt). */
  transactionId?: mongoose.Types.ObjectId | null;
  /** Which money-moving operation this attempt records. */
  operation: 'create-intent' | 'confirm' | 'refund';
  /** Gateway string (e.g. 'stripe', 'sslcommerz', 'manual'). */
  provider: string;
  methodKind?: PaymentMethodKind;
  /** The caller's command key — the claim identity (unique per operation, provider and tenant). */
  idempotencyKey: string;
  /**
   * The key SENT to the provider. Tenant-namespaced on a scoped engine, because a provider
   * account shared by tenants dedups on the raw key. Present on every create-intent attempt.
   */
  providerKey?: string;
  /** Private fingerprint of the immutable creation request. */
  requestFingerprint?: string;
  amount: number;
  currency: string;
  /**
   * `pending` is stamped BEFORE the provider call. It is then resolved to the
   * three-valued provider outcome. A row stuck at `pending` is itself the signal
   * that the call never returned (crash between write and provider response).
   */
  outcome: 'pending' | 'confirmed' | 'declined' | 'unknown';
  /** Normalized cause for a `declined`/`unknown` outcome (never a raw vendor message). */
  causeCode?: string;
  declineReason?: string;
  /** Gateway identifiers captured on a `confirmed` outcome. */
  gateway?: {
    sessionId?: string;
    paymentIntentId?: string;
    chargeId?: string;
  };
  providerReference?: string;
  /** Private verification material; excluded from ordinary reads and attempt-history DTOs. */
  returnProof?: { digest: string; expiresAt: Date; organizationId?: string };
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Mongoose `required` condition: only a create-intent attempt carries a fingerprint and a provider key. */
function isCreateIntent(this: { operation?: string }): boolean {
  return this.operation === 'create-intent';
}

export function buildPaymentAttemptSchema(config: RevenueSchemaConfig): Schema<PaymentAttemptDocument> {
  const fields: Record<string, unknown> = {
    publicId: { type: String },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
    operation: { type: String, required: true, default: 'create-intent' },
    provider: { type: String, required: true },
    methodKind: { type: String },
    idempotencyKey: { type: String, required: true },
    providerKey: { type: String, required: [isCreateIntent, 'A create-intent attempt records the key sent to the provider.'] },
    requestFingerprint: { type: String, select: false, required: [isCreateIntent, 'A create-intent attempt carries its request fingerprint.'] },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    outcome: { type: String, default: 'pending' },
    causeCode: { type: String },
    declineReason: { type: String },
    gateway: { type: Schema.Types.Mixed },
    providerReference: { type: String },
    returnProof: {
      type: new Schema({ digest: { type: String, required: true }, expiresAt: { type: Date, required: true }, organizationId: String }, { _id: false }),
      select: false,
    },
    metadata: { type: Schema.Types.Mixed },
  };

  if (config.extraFields) Object.assign(fields, config.extraFields);

  const schema = new Schema<PaymentAttemptDocument>(fields as any, { timestamps: true });

  // Unique per tenant (the tenant field is prepended on a scoped engine). The tenant is discovered from
  // `revenue_return_proof_routes`, so this index no longer has to be global.
  schema.index({ 'returnProof.digest': 1 }, {
    unique: true, name: 'attempt_return_proof_str',
    partialFilterExpression: { 'returnProof.digest': { $gte: '' } },
  });

  // Lookups — tenant field auto-prepended by injectTenantField when scoped.
  schema.index({ transactionId: 1, createdAt: 1 }, { sparse: true });
  // Operation/provider claims; the create-only index below also prevents provider forks.
  schema.index(
    { operation: 1, provider: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $gte: '' } },
      name: 'attempt_command_identity_str',
    },
  );
  // One creation command across providers: an unknown primary cannot silently fail over.
  schema.index({ idempotencyKey: 1 }, {
    unique: true, name: 'attempt_create_identity',
    partialFilterExpression: { operation: 'create-intent', idempotencyKey: { $gte: '' } },
  });
  // Reconciliation worklist: find attempts that never resolved.
  schema.index({ outcome: 1, createdAt: 1 });
  // String publicIds only, so a transient null cannot block the build; `$gte: ''` (not
  // `$type: 'string'`) so a plain lookup by publicId can use it.
  schema.index(
    { publicId: 1 },
    { name: 'publicId_str', unique: true, partialFilterExpression: { publicId: { $gte: '' } } },
  );

  return schema;
}

export function createPaymentAttemptModel(
  connection: Connection,
  config: RevenueSchemaConfig,
): Model<PaymentAttemptDocument> {
  return connection.model<PaymentAttemptDocument>('PaymentAttempt', buildPaymentAttemptSchema(config));
}
