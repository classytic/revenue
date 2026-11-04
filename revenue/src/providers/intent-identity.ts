import { fingerprintRequest } from '@classytic/repo-core/idempotency';
import type { TransactionRepository } from '../repositories/transaction/transaction.repository.js';
import type { TransactionDocument } from '../models/transaction.schema.js';
import { RevenueError } from '../core/errors.js';

type Input = Parameters<TransactionRepository['createPaymentIntent']>[0];

export function intentRequestFingerprint(input: Input, currency: string): string {
  return fingerprintRequest({ ...input, currency, idempotencyKey: undefined, reference: input.reference?.trim() || undefined });
}

export function assertIntentIdentity(input: Input, currency: string, transaction: TransactionDocument): void {
  if (transaction.amount !== input.amount || transaction.currency !== currency || transaction.method !== input.gateway
    || transaction.methodKind !== input.methodKind
    || (transaction.sourceId ?? undefined) !== (input.data?.sourceId == null ? undefined : String(input.data.sourceId))
    || (transaction.sourceModel ?? undefined) !== (input.data?.sourceModel == null ? undefined : String(input.data.sourceModel))
    || (transaction.customerId == null ? undefined : String(transaction.customerId)) !== (input.data?.customerId == null ? undefined : String(input.data.customerId))) {
    rejectIntentIdentity();
  }
}

export function rejectIntentIdentity(): never {
  throw new RevenueError('Payment idempotency key was already used with different payment facts.', 'revenue.intent.conflict', undefined, 409);
}
