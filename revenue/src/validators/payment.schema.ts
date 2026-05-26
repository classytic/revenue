import { z } from 'zod';
import { PAYMENT_METHOD_KIND, type PaymentMethodKind } from '@classytic/primitives/payment-method-kind';

const PAYMENT_METHOD_KIND_VALUES = Object.values(PAYMENT_METHOD_KIND) as [
  PaymentMethodKind,
  ...PaymentMethodKind[],
];

export const paymentIntentSchema = z.object({
  amount: z.number().int().min(1),
  currency: z.string().min(3).max(3),
  gateway: z.string(),
  methodKind: z.enum(PAYMENT_METHOD_KIND_VALUES),
  customerId: z.string().optional(),
  sourceId: z.string().optional(),
  sourceModel: z.string().optional(),
  monetizationType: z.enum(['purchase', 'subscription', 'free']).default('purchase'),
  planKey: z.string().optional(),
  paymentData: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().optional(),
});

export const paymentVerifySchema = z.object({
  paymentIntentId: z.string(),
  verifiedBy: z.string().optional(),
});

export const refundSchema = z.object({
  transactionId: z.string(),
  amount: z.number().int().min(1).optional(),
  reason: z.string().optional(),
});

export type PaymentIntentInput = z.infer<typeof paymentIntentSchema>;
export type PaymentVerifyInput = z.infer<typeof paymentVerifySchema>;
export type RefundInput = z.infer<typeof refundSchema>;
