import mongoose, { type Connection, type Model, Schema } from 'mongoose';

export interface RevenueSchemaConfig {
  scoped: boolean;
  extraFields?: Record<string, unknown>;
  extraIndexes?: Array<{ fields: Record<string, 1 | -1>; options?: Record<string, unknown> }>;
}

export interface TransactionDocument {
  _id: mongoose.Types.ObjectId;
  publicId: string;
  organizationId?: string;
  customerId?: string | null;
  type: string;
  flow: 'inflow' | 'outflow';
  tags: string[];
  amount: number;
  currency: string;
  fee: number;
  tax: number;
  net: number;
  taxDetails?: { type?: string; rate?: number; isInclusive?: boolean };
  method: string;
  status: string;
  gateway?: {
    type: string;
    sessionId?: string;
    paymentIntentId?: string;
    chargeId?: string;
    metadata?: Record<string, unknown>;
    verificationData?: Record<string, unknown>;
  };
  paymentDetails?: Record<string, unknown>;
  commission?: {
    rate: number;
    grossAmount: number;
    gatewayFeeRate: number;
    gatewayFeeAmount: number;
    netAmount: number;
    status: string;
  };
  splits?: Array<{
    type: string;
    recipientId: string;
    recipientType: string;
    rate: number;
    grossAmount: number;
    gatewayFeeRate: number;
    gatewayFeeAmount: number;
    netAmount: number;
    status: string;
  }>;
  hold?: {
    status: string;
    heldAmount: number;
    releasedAmount: number;
    reason: string;
    heldAt: Date;
    holdUntil?: Date;
    releasedAt?: Date;
    cancelledAt?: Date;
    releases: Array<{
      amount: number;
      recipientId: string;
      recipientType: string;
      releasedAt: Date;
      releasedBy?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    }>;
    metadata?: Record<string, unknown>;
  };
  sourceId?: string;
  sourceModel?: string;
  relatedTransactionId?: mongoose.Types.ObjectId;
  refundedAmount?: number;
  refundedAt?: Date;
  failureReason?: string;
  failedAt?: Date;
  verifiedAt?: Date;
  verifiedBy?: string;
  webhook?: {
    eventId: string;
    eventType: string;
    receivedAt: Date;
    processedAt: Date;
    data: Record<string, unknown>;
  };
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildTransactionSchema(config: RevenueSchemaConfig): Schema<TransactionDocument> {
  const fields: Record<string, unknown> = {
    publicId: { type: String },
    customerId: { type: String, default: null },
    type: { type: String, required: true },
    flow: { type: String, enum: ['inflow', 'outflow'], required: true },
    tags: [{ type: String }],
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    fee: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    net: { type: Number, default: 0 },
    taxDetails: { type: Schema.Types.Mixed },
    method: { type: String, required: true },
    status: { type: String, default: 'pending' },
    gateway: { type: Schema.Types.Mixed },
    paymentDetails: { type: Schema.Types.Mixed },
    commission: { type: Schema.Types.Mixed },
    splits: [{ type: Schema.Types.Mixed }],
    hold: { type: Schema.Types.Mixed },
    // Polymorphic source — String accepts any ID format:
    //   • ObjectId hex   ('507f1f77bcf86cd799439011')
    //   • UUID           ('550e8400-e29b-41d4-a716-446655440000')
    //   • External ID    ('order_abc123', 'pi_3OqXyZ', 'stripe_charge_xxx')
    // Population via SourceBridge (host implements). Works for single-DB Mongoose,
    // microservices, external systems (Stripe/Postgres/REST), and mixed UUID/ObjectId.
    sourceId: { type: String },
    sourceModel: { type: String },
    // Self-reference for refund/release/split (always within revenue's own collection)
    relatedTransactionId: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    refundedAmount: { type: Number },
    refundedAt: { type: Date },
    failureReason: { type: String },
    failedAt: { type: Date },
    verifiedAt: { type: Date },
    verifiedBy: { type: String },
    webhook: { type: Schema.Types.Mixed },
    idempotencyKey: { type: String },
    metadata: { type: Schema.Types.Mixed },
    deletedAt: { type: Date, default: null },
  };

  if (config.extraFields) {
    Object.assign(fields, config.extraFields);
  }

  const schema = new Schema<TransactionDocument>(fields as any, { timestamps: true });

  // Indexes — tenant field auto-prepended by injectTenantField when scoped
  schema.index({ status: 1, createdAt: -1 });
  schema.index({ customerId: 1, createdAt: -1 });
  schema.index({ sourceId: 1, sourceModel: 1 });
  // Global indexes (gateway.sessionId, idempotencyKey, publicId) are NOT
  // defined here — they're applied in create-models.ts AFTER injectTenantField
  // so they stay unscoped (cross-tenant lookups for webhooks, external systems).

  if (config.extraIndexes) {
    for (const idx of config.extraIndexes) {
      schema.index(idx.fields, idx.options);
    }
  }

  return schema;
}

export function createTransactionModel(
  connection: Connection,
  config: RevenueSchemaConfig,
): Model<TransactionDocument> {
  return connection.model<TransactionDocument>('Transaction', buildTransactionSchema(config));
}
