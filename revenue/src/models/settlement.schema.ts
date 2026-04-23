import mongoose, { type Connection, type Model, Schema } from 'mongoose';
import type { RevenueSchemaConfig } from './transaction.schema.js';

export interface SettlementDocument {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  organizationId: string;
  recipientId: string;
  recipientType: string;
  type: string;
  status: string;
  payoutMethod: string;
  amount: number;
  currency: string;
  sourceTransactionIds: mongoose.Types.ObjectId[];
  sourceSplitIds: string[];
  bankTransferDetails?: Record<string, unknown>;
  mobileWalletDetails?: Record<string, unknown>;
  cryptoDetails?: Record<string, unknown>;
  scheduledAt: Date;
  processedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  cancelledAt?: Date;
  failureReason?: string;
  failureCode?: string;
  retryCount: number;
  notes?: string;
  metadata?: Record<string, unknown>;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildSettlementSchema(config: RevenueSchemaConfig): Schema<SettlementDocument> {
  const txnRef = 'Transaction';
  const fields: Record<string, unknown> = {
    publicId: { type: String },
    recipientId: { type: String, required: true },
    recipientType: { type: String, required: true },
    type: { type: String, required: true },
    status: { type: String, default: 'pending' },
    payoutMethod: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    sourceTransactionIds: [{ type: Schema.Types.ObjectId, ref: txnRef }],
    sourceSplitIds: [{ type: String }],
    bankTransferDetails: { type: Schema.Types.Mixed },
    mobileWalletDetails: { type: Schema.Types.Mixed },
    cryptoDetails: { type: Schema.Types.Mixed },
    scheduledAt: { type: Date, default: () => new Date() },
    processedAt: { type: Date },
    completedAt: { type: Date },
    failedAt: { type: Date },
    cancelledAt: { type: Date },
    failureReason: { type: String },
    failureCode: { type: String },
    retryCount: { type: Number, default: 0 },
    notes: { type: String },
    metadata: { type: Schema.Types.Mixed },
    deletedAt: { type: Date, default: null },
  };

  if (config.extraFields) Object.assign(fields, config.extraFields);

  const schema = new Schema<SettlementDocument>(fields as any, { timestamps: true });

  // Indexes — tenant field auto-prepended by injectTenantField when scoped
  schema.index({ status: 1, scheduledAt: 1 });
  schema.index({ recipientId: 1, status: 1 });
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

export function createSettlementModel(
  connection: Connection,
  config: RevenueSchemaConfig,
): Model<SettlementDocument> {
  return connection.model<SettlementDocument>('Settlement', buildSettlementSchema(config));
}
