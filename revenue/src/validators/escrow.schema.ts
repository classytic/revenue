import { z } from 'zod';

export const escrowHoldSchema = z.object({
  transactionId: z.string(),
  amount: z.number().int().min(1).optional(),
  reason: z.string().optional(),
  holdUntil: z.coerce.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const escrowReleaseSchema = z.object({
  transactionId: z.string(),
  amount: z.number().int().min(1).optional(),
  recipientId: z.string(),
  recipientType: z.string(),
  reason: z.string().optional(),
  releasedBy: z.string().optional(),
  createTransaction: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const splitRuleSchema = z.object({
  type: z.string(),
  recipientId: z.string(),
  recipientType: z.string(),
  rate: z.number().min(0).max(1),
});

export type EscrowHoldInput = z.infer<typeof escrowHoldSchema>;
export type EscrowReleaseInput = z.infer<typeof escrowReleaseSchema>;
export type SplitRuleInput = z.infer<typeof splitRuleSchema>;
