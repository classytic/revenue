import { z } from 'zod';

export const settlementBaseSchema = z.object({
  publicId: z.string().optional(),
  organizationId: z.string(),
  recipientId: z.string(),
  recipientType: z.enum(['platform', 'organization', 'user', 'affiliate', 'partner']),
  type: z.enum(['split_payout', 'platform_withdrawal', 'manual_payout', 'escrow_release']),
  status: z.string().default('pending'),
  payoutMethod: z.enum(['bank_transfer', 'mobile_wallet', 'platform_balance', 'crypto', 'check', 'manual']),
  amount: z.number().int().min(0),
  currency: z.string().min(3).max(3),
  sourceTransactionIds: z.array(z.string()).default([]),
  sourceSplitIds: z.array(z.string()).default([]),
  bankTransferDetails: z.object({
    accountNumber: z.string().optional(),
    accountName: z.string().optional(),
    bankName: z.string().optional(),
    routingNumber: z.string().optional(),
    swiftCode: z.string().optional(),
    iban: z.string().optional(),
    transferReference: z.string().optional(),
    transferredAt: z.coerce.date().optional(),
  }).optional(),
  mobileWalletDetails: z.object({
    provider: z.string().optional(),
    phoneNumber: z.string().optional(),
    accountNumber: z.string().optional(),
    transactionId: z.string().optional(),
    transferredAt: z.coerce.date().optional(),
  }).optional(),
  cryptoDetails: z.object({
    network: z.string().optional(),
    walletAddress: z.string().optional(),
    transactionHash: z.string().optional(),
    transferredAt: z.coerce.date().optional(),
  }).optional(),
  scheduledAt: z.coerce.date().default(() => new Date()),
  processedAt: z.coerce.date().optional(),
  completedAt: z.coerce.date().optional(),
  failedAt: z.coerce.date().optional(),
  cancelledAt: z.coerce.date().optional(),
  failureReason: z.string().optional(),
  failureCode: z.string().optional(),
  retryCount: z.number().int().default(0),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const settlementCreateSchema = settlementBaseSchema.omit({
  publicId: true,
  status: true,
  processedAt: true,
  completedAt: true,
  failedAt: true,
  cancelledAt: true,
  failureReason: true,
  failureCode: true,
  retryCount: true,
});

export const settlementUpdateSchema = settlementBaseSchema.partial();

export const settlementListFilterSchema = z.object({
  organizationId: z.string().optional(),
  recipientId: z.string().optional(),
  recipientType: z.string().optional(),
  status: z.string().optional(),
  payoutMethod: z.string().optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
  sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
});

export type SettlementCreateInput = z.infer<typeof settlementCreateSchema>;
export type SettlementUpdateInput = z.infer<typeof settlementUpdateSchema>;
export type SettlementListFilter = z.infer<typeof settlementListFilterSchema>;
