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
  operation: 'create-intent' | 'refund';
  /** Gateway string (e.g. 'stripe', 'sslcommerz', 'manual'). */
  provider: string;
  methodKind?: PaymentMethodKind;
  /** The idempotency key SENT to the provider — caller-supplied, or derived from this attempt's `_id`. */
  idempotencyKey: string;
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
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export function buildPaymentAttemptSchema(config: RevenueSchemaConfig): Schema<PaymentAttemptDocument> {
  const fields: Record<string, unknown> = {
    publicId: { type: String },
    transactionId: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
    operation: { type: String, required: true, default: 'create-intent' },
    provider: { type: String, required: true },
    methodKind: { type: String },
    idempotencyKey: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    outcome: { type: String, default: 'pending' },
    causeCode: { type: String },
    declineReason: { type: String },
    gateway: { type: Schema.Types.Mixed },
    providerReference: { type: String },
    metadata: { type: Schema.Types.Mixed },
  };

  if (config.extraFields) Object.assign(fields, config.extraFields);

  const schema = new Schema<PaymentAttemptDocument>(fields as any, { timestamps: true });

  // Lookups — tenant field auto-prepended by injectTenantField when scoped.
  schema.index({ transactionId: 1, createdAt: 1 }, { sparse: true });
  /**
   * ATOMIC COMMAND-IDENTITY CLAIM. A money command is uniquely one
   * (operation, provider, idempotencyKey) — plus `organizationId`, which
   * `injectTenantField` prepends when the engine is scoped (declared here, before
   * injection, precisely so it participates). Creating the attempt IS the claim:
   * two concurrent requests with the same key to the same provider race on this
   * index; the loser gets a duplicate-key error and loads the winner's attempt
   * instead of calling the provider a second time. `provider` is in the key so a
   * FAILOVER to a different provider under the same order key is a distinct claim
   * (not a false dup), while a same-provider retry is deduped.
   */
  schema.index(
    { operation: 1, provider: 1, idempotencyKey: 1 },
    {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      name: 'attempt_command_identity',
    },
  );
  // Reconciliation worklist: find attempts that never resolved.
  schema.index({ outcome: 1, createdAt: 1 });
  // `$type: 'string'` excludes transient-null rows so one null publicId
  // can't block the unique index build (mirrors the other schemas).
  schema.index(
    { publicId: 1 },
    { unique: true, partialFilterExpression: { publicId: { $type: 'string' } } },
  );

  if (config.extraIndexes) {
    for (const idx of config.extraIndexes) schema.index(idx.fields, idx.options);
  }

  return schema;
}

export function createPaymentAttemptModel(
  connection: Connection,
  config: RevenueSchemaConfig,
): Model<PaymentAttemptDocument> {
  return connection.model<PaymentAttemptDocument>('PaymentAttempt', buildPaymentAttemptSchema(config));
}
