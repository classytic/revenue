import { z } from 'zod';
import { PAYMENT_METHOD_KIND, type PaymentMethodKind } from '@classytic/primitives/payment-method-kind';
import { minorAmount, moneyFields } from '@classytic/validation/money';
// The monetization wire enum is the shared seam — same values catalog + primitives use.
import { revenueMonetizationTypeSchema } from '@classytic/validation/monetization';

const PAYMENT_METHOD_KIND_VALUES = Object.values(PAYMENT_METHOD_KIND) as [
  PaymentMethodKind,
  ...PaymentMethodKind[],
];

export const paymentIntentSchema = z.object({
  ...moneyFields('positive'),
  gateway: z.string(),
  methodKind: z.enum(PAYMENT_METHOD_KIND_VALUES),
  customerId: z.string().optional(),
  sourceId: z.string().optional(),
  sourceModel: z.string().optional(),
  monetizationType: revenueMonetizationTypeSchema.default('purchase'),
  planKey: z.string().optional(),
  paymentData: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * REQUIRED — this schema is positive-only (`moneyFields('positive')` forces amount ≥ 1),
   * and the engine refuses a positive-amount intent without a stable key. Optional here would
   * only defer that to a runtime throw. (Free / zero-amount intents never use this schema.)
   */
  idempotencyKey: z.string().min(1),
});

export const paymentVerifySchema = z.object({
  paymentIntentId: z.string(),
  verifiedBy: z.string().optional(),
});

export const refundSchema = z.object({
  transactionId: z.string(),
  amount: minorAmount('positive').optional(),
  reason: z.string().optional(),
  /**
   * REQUIRED — a refund moves money and the engine refuses one without a stable key (a
   * retried refund must reuse the same provider operation, never reverse twice). The boundary
   * schema must express that contract, not defer it to a runtime throw.
   */
  idempotencyKey: z.string().min(1),
});

export type PaymentIntentInput = z.infer<typeof paymentIntentSchema>;
export type PaymentVerifyInput = z.infer<typeof paymentVerifySchema>;
export type RefundInput = z.infer<typeof refundSchema>;
