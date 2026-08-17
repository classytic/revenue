import type { PluginType } from '@classytic/mongokit';
import type { Model } from 'mongoose';
import type { PaymentAttemptDocument } from '../models/payment-attempt.schema.js';
import { RevenueRepositoryBase, type BaseRevenueRepoDeps } from './base.repository.js';

/**
 * PaymentAttempt persistence via mongokit — NOT the raw model. This is what makes
 * reconciliation correct:
 *
 *   - `claim()` (inherited) gives an atomic outcome transition — `from: ['pending',
 *     'unknown'] → to: 'confirmed'|'declined'` — so two concurrent reconciles can never
 *     release the same reservation twice (only the CAS winner proceeds).
 *   - `optsFromCtx` injects the tenant filter on every read/write, so reconciliation is
 *     branch-scoped instead of a global `findById`/`find`.
 *
 * No domain verbs of its own — the attempt lifecycle is orchestrated by
 * `TransactionRepository` (create / refund / reconcile). This repo just supplies the
 * scoped, CAS-capable data layer.
 */
export class PaymentAttemptRepository extends RevenueRepositoryBase<
  PaymentAttemptDocument,
  BaseRevenueRepoDeps
> {
  constructor(model: Model<PaymentAttemptDocument>, plugins: PluginType[] = []) {
    super(model, plugins);
  }
}
