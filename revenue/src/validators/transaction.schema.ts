import { z } from 'zod';
import { PAYMENT_METHOD_KIND, type PaymentMethodKind } from '@classytic/primitives/payment-method-kind';

const PAYMENT_METHOD_KIND_VALUES = Object.values(PAYMENT_METHOD_KIND) as [
  PaymentMethodKind,
  ...PaymentMethodKind[],
];

const commissionSchema = z.object({
  rate: z.number().min(0).max(1),
  grossAmount: z.number().int(),
  gatewayFeeRate: z.number().min(0).max(1),
  gatewayFeeAmount: z.number().int(),
  netAmount: z.number().int(),
  status: z.string(),
});

const holdReleaseSchema = z.object({
  amount: z.number().int(),
  recipientId: z.string(),
  recipientType: z.string(),
  releasedAt: z.coerce.date(),
  releasedBy: z.string().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const holdSchema = z.object({
  status: z.string(),
  heldAmount: z.number().int(),
  releasedAmount: z.number().int().default(0),
  reason: z.string(),
  heldAt: z.coerce.date(),
  holdUntil: z.coerce.date().optional(),
  releasedAt: z.coerce.date().optional(),
  cancelledAt: z.coerce.date().optional(),
  releases: z.array(holdReleaseSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const gatewaySchema = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  paymentIntentId: z.string().optional(),
  chargeId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  verificationData: z.record(z.string(), z.unknown()).optional(),
});

const splitInfoSchema = z.object({
  type: z.string(),
  recipientId: z.string(),
  recipientType: z.string(),
  rate: z.number(),
  grossAmount: z.number().int(),
  gatewayFeeRate: z.number(),
  gatewayFeeAmount: z.number().int(),
  netAmount: z.number().int(),
  status: z.string(),
});

const webhookSchema = z.object({
  eventId: z.string(),
  eventType: z.string(),
  receivedAt: z.coerce.date(),
  processedAt: z.coerce.date(),
  data: z.record(z.string(), z.unknown()),
});

export const transactionBaseSchema = z.object({
  publicId: z.string().optional(),
  organizationId: z.string().optional(),
  customerId: z.string().nullish(),
  type: z.string(),
  flow: z.enum(['inflow', 'outflow']),
  tags: z.array(z.string()).default([]),
  amount: z.number().int().min(0),
  currency: z.string().min(3).max(3),
  fee: z.number().int().default(0),
  tax: z.number().int().default(0),
  net: z.number().int().default(0),
  taxDetails: z.object({
    type: z.enum(['sales_tax', 'vat', 'none']).optional(),
    rate: z.number().min(0).max(1).optional(),
    isInclusive: z.boolean().optional(),
  }).optional(),
  method: z.string(),
  methodKind: z.enum(PAYMENT_METHOD_KIND_VALUES),
  status: z.string().default('pending'),
  gateway: gatewaySchema.optional(),
  paymentDetails: z.record(z.string(), z.unknown()).optional(),
  commission: commissionSchema.optional(),
  splits: z.array(splitInfoSchema).optional(),
  hold: holdSchema.optional(),
  sourceId: z.string().optional(),
  sourceModel: z.string().optional(),
  relatedTransactionId: z.string().optional(),
  refundedAmount: z.number().int().optional(),
  refundedAt: z.coerce.date().optional(),
  failureReason: z.string().optional(),
  failedAt: z.coerce.date().optional(),
  verifiedAt: z.coerce.date().optional(),
  verifiedBy: z.string().optional(),
  webhook: webhookSchema.optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const transactionCreateSchema = transactionBaseSchema.omit({
  publicId: true,
  refundedAmount: true,
  refundedAt: true,
  failureReason: true,
  failedAt: true,
  verifiedAt: true,
  verifiedBy: true,
  webhook: true,
});

export const transactionUpdateSchema = transactionBaseSchema.partial();

export const transactionListFilterSchema = z.object({
  organizationId: z.string().optional(),
  customerId: z.string().optional(),
  type: z.string().optional(),
  flow: z.enum(['inflow', 'outflow']).optional(),
  status: z.string().optional(),
  method: z.string().optional(),
  sourceId: z.string().optional(),
  sourceModel: z.string().optional(),
  minAmount: z.number().int().optional(),
  maxAmount: z.number().int().optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
  sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
});

export type TransactionCreateInput = z.infer<typeof transactionCreateSchema>;
export type TransactionUpdateInput = z.infer<typeof transactionUpdateSchema>;
export type TransactionListFilter = z.infer<typeof transactionListFilterSchema>;
