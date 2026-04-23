import { z } from 'zod';

export const subscriptionBaseSchema = z.object({
  publicId: z.string().optional(),
  organizationId: z.string().optional(),
  customerId: z.string().nullish(),
  planKey: z.string(),
  amount: z.number().int().min(0),
  currency: z.string().min(3).max(3).optional(),
  status: z.string().default('pending'),
  isActive: z.boolean().default(false),
  transactionId: z.string().nullish(),
  paymentIntentId: z.string().nullish(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  activatedAt: z.coerce.date().optional(),
  pausedAt: z.coerce.date().optional(),
  pauseReason: z.string().optional(),
  canceledAt: z.coerce.date().optional(),
  cancelAt: z.coerce.date().optional(),
  cancellationReason: z.string().optional(),
  renewalTransactionId: z.string().optional(),
  renewalCount: z.number().int().default(0),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const subscriptionCreateSchema = subscriptionBaseSchema.omit({
  publicId: true,
  status: true,
  isActive: true,
  activatedAt: true,
  pausedAt: true,
  canceledAt: true,
  renewalCount: true,
});

export const subscriptionUpdateSchema = subscriptionBaseSchema.partial();

export const subscriptionListFilterSchema = z.object({
  organizationId: z.string().optional(),
  customerId: z.string().optional(),
  planKey: z.string().optional(),
  status: z.string().optional(),
  isActive: z.boolean().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
  sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
});

export type SubscriptionCreateInput = z.infer<typeof subscriptionCreateSchema>;
export type SubscriptionUpdateInput = z.infer<typeof subscriptionUpdateSchema>;
export type SubscriptionListFilter = z.infer<typeof subscriptionListFilterSchema>;
