import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import type { ApprovalChain } from '@classytic/primitives/approval';
import type { RevenueSchemaConfig } from './transaction.schema.js';

export interface SubscriptionDocument {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  organizationId?: string;
  customerId?: string | null;
  planKey: string;
  amount: number;
  currency?: string;
  status: string;
  isActive: boolean;
  transactionId?: mongoose.Types.ObjectId | null;
  paymentIntentId?: string | null;
  startDate?: Date;
  endDate?: Date;
  activatedAt?: Date;
  pausedAt?: Date;
  pauseReason?: string;
  canceledAt?: Date;
  cancelAt?: Date;
  cancellationReason?: string;
  /**
   * Optional embedded approval chain — P7. Hosts that gate high-value
   * subscription transitions on a maker-checker review attach a chain via
   * `createChain()` from `@classytic/primitives/approval`; the host's
   * approval action checks `isApproved(doc.approvals)` before applying
   * the change. Routine renewals/auto-pause flows leave it undefined.
   *
   * Use cases:
   *   - Cancel-with-refund (manager sign-off before issuing credit)
   *   - Plan change with credit note (finance verifies proration)
   *   - Manual reactivation after dunning failure
   */
  approvals?: ApprovalChain;
  renewalTransactionId?: mongoose.Types.ObjectId;
  renewalCount: number;
  metadata?: Record<string, unknown>;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildSubscriptionSchema(config: RevenueSchemaConfig): Schema<SubscriptionDocument> {
  const txnRef = 'Transaction';
  const fields: Record<string, unknown> = {
    publicId: { type: String },
    customerId: { type: String, default: null },
    planKey: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String },
    status: { type: String, default: 'pending' },
    isActive: { type: Boolean, default: false },
    transactionId: { type: Schema.Types.ObjectId, ref: txnRef, default: null },
    paymentIntentId: { type: String, default: null },
    startDate: { type: Date },
    endDate: { type: Date },
    activatedAt: { type: Date },
    pausedAt: { type: Date },
    pauseReason: { type: String },
    canceledAt: { type: Date },
    cancelAt: { type: Date },
    cancellationReason: { type: String },
    // P7 — embedded ApprovalChain VO (primitives owns the shape). Hosts
    // running a maker-checker workflow on cancel-with-refund or plan-change
    // transitions attach a chain via `createChain()` and gate the action on
    // `isApproved(doc.approvals)`. Routine flows leave it undefined.
    approvals: { type: Schema.Types.Mixed, default: null },
    renewalTransactionId: { type: Schema.Types.ObjectId, ref: txnRef },
    renewalCount: { type: Number, default: 0 },
    metadata: { type: Schema.Types.Mixed },
    deletedAt: { type: Date, default: null },
  };

  if (config.extraFields) Object.assign(fields, config.extraFields);

  const schema = new Schema<SubscriptionDocument>(fields as any, { timestamps: true });

  // Indexes — tenant field auto-prepended by injectTenantField when scoped
  schema.index({ customerId: 1, status: 1 });
  schema.index({ status: 1, endDate: 1 });
  // `$type: 'string'` excludes both deleted rows AND transient `null` rows
  // (customIdPlugin pre-save race or legacy direct collection writes).
  // Without it, a single `{ publicId: null }` row blocks the unique index
  // build with E11000 in production.
  schema.index(
    { publicId: 1 },
    {
      unique: true,
      partialFilterExpression: { deletedAt: null, publicId: { $type: 'string' } },
    },
  );

  if (config.extraIndexes) {
    for (const idx of config.extraIndexes) schema.index(idx.fields, idx.options);
  }

  return schema;
}

export function createSubscriptionModel(
  connection: Connection,
  config: RevenueSchemaConfig,
): Model<SubscriptionDocument> {
  return connection.model<SubscriptionDocument>('Subscription', buildSubscriptionSchema(config));
}
