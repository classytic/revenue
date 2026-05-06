/**
 * Zod 4 validators for bank-feed HTTP / RPC payloads.
 *
 * In-process schemas use `z.coerce.date()` (PACKAGE_RULES §25). Shapes
 * that travel over the wire (Plaid webhooks, queued jobs) use
 * `z.iso.datetime()` — see the catalog file for those.
 */

import { z } from 'zod';
import {
  BANK_FEED_SOURCE_VALUES,
  TRANSACTION_KIND_VALUES,
} from '../enums/bank-feed.enums.js';

// ─── Reusable fragments ──────────────────────────────────────────────────

export const moneySchema = z.object({
  amount: z.number().int(),
  currency: z.string().length(3),
});

export const counterpartySchema = z.object({
  name: z.string().optional(),
  identifier: z.string().optional(),
  iban: z.string().optional(),
  accountNumber: z.string().optional(),
  bic: z.string().optional(),
  routingNumber: z.string().optional(),
});

export const bankTransactionSchema = z.object({
  externalId: z.string().min(1),
  postedDate: z.coerce.date(),
  valueDate: z.coerce.date().optional(),
  amount: moneySchema,
  description: z.string(),
  counterparty: counterpartySchema.optional(),
  reference: z.string().optional(),
  category: z.string().optional(),
  balanceAfter: moneySchema.optional(),
  type: z.string().optional(),
  raw: z.unknown().optional(),
});

export const journalEntryRefSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

export const matchingMappingSchema = z.object({
  debitAccount: z.string().optional(),
  creditAccount: z.string().optional(),
  notes: z.string().optional(),
});

// ─── Verb body schemas (Arc actions) ─────────────────────────────────────

export const importBodySchema = z.object({
  bankAccountId: z.string().min(1),
  source: z.enum(BANK_FEED_SOURCE_VALUES as [string, ...string[]]),
  rows: z.array(bankTransactionSchema).min(1),
});

export const matchBodySchema = z.object({
  mapping: matchingMappingSchema,
  /** Optional cross-link to an upstream payment-flow row. */
  relatedTransactionId: z.string().optional(),
  matchedBy: z.string().optional(),
});

export const journalizeBodySchema = z.object({
  journalEntryRef: journalEntryRefSchema,
  journalizedBy: z.string().optional(),
});

export const rejectBodySchema = z.object({
  reason: z.string().min(1).max(500),
  rejectedBy: z.string().optional(),
});

export const unmatchBodySchema = z.object({
  unmatchedBy: z.string().optional(),
});

// ─── Manual entry creation ───────────────────────────────────────────────

export const manualEntrySchema = z.object({
  /** `'manual'` is the only legal value for this verb. */
  kind: z.literal('manual').default('manual'),
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  flow: z.enum(['inflow', 'outflow']),
  type: z.string().min(1),
  description: z.string().optional(),
  counterparty: counterpartySchema.optional(),
  reference: z.string().optional(),
  postedDate: z.coerce.date().optional(),
  valueDate: z.coerce.date().optional(),
  bankAccountId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ─── Find-match-candidates query ─────────────────────────────────────────

export const findMatchCandidatesQuerySchema = z.object({
  amount: z.coerce.number().nonnegative(),
  currency: z.string().length(3).optional(),
  postedDate: z.coerce.date(),
  toleranceDays: z.coerce.number().int().min(0).max(30).optional(),
  amountTolerancePct: z.coerce.number().min(0).max(0.5).optional(),
  counterpartyName: z.string().optional(),
});

// ─── Transaction list query (kind filter) ────────────────────────────────

export const transactionListQuerySchema = z.object({
  kind: z.enum(TRANSACTION_KIND_VALUES as [string, ...string[]]).optional(),
  status: z.string().optional(),
  bankAccountId: z.string().optional(),
  source: z.enum(BANK_FEED_SOURCE_VALUES as [string, ...string[]]).optional(),
});

// ─── Inferred types (for handler signatures) ─────────────────────────────

export type ImportBody = z.infer<typeof importBodySchema>;
export type MatchBody = z.infer<typeof matchBodySchema>;
export type JournalizeBody = z.infer<typeof journalizeBodySchema>;
export type RejectBody = z.infer<typeof rejectBodySchema>;
export type UnmatchBody = z.infer<typeof unmatchBodySchema>;
export type ManualEntryBody = z.infer<typeof manualEntrySchema>;
export type FindMatchCandidatesQuery = z.infer<typeof findMatchCandidatesQuerySchema>;
export type TransactionListQuery = z.infer<typeof transactionListQuerySchema>;
