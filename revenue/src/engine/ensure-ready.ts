/**
 * VERIFY step — the bind-time capability gate.
 *
 * ## Why revenue needs one at all
 *
 * Revenue MOVES MONEY, and five of its verbs are multi-document by
 * construction: `refund.repository` claims a refund, writes the refund row and
 * rolls the claim back on failure; `transaction.repository` settles a capture
 * and writes its allocation. All five run through mongokit's `withTransaction`
 * with NO `allowFallback`, so on a deployment that cannot start a transaction
 * they throw at the FIRST capture or refund — in production, mid-payment,
 * against a real customer — rather than at boot, where an operator would see it
 * next to the rest of the deployment's configuration.
 *
 * Every other money-adjacent kernel in this repo (wallet, invoice, ledger,
 * purchase, promo, party) already refuses that deployment at bind. Revenue was
 * the one that did not — a gap found while rolling out mongokit's observed
 * capabilities on 2026-08-05.
 *
 * ## Why it only became possible to write on 2026-08-05
 *
 * `Repository#capabilities` used to be mongokit's STATIC
 * `MONGOKIT_CAPABILITIES` with `transactions` hard-coded `true`, so a gate like
 * this would have been a tautology — it could never have refused the standalone
 * `mongod` it exists to catch (AGENTS.md FAIL LOUD rule 4). mongokit now
 * OBSERVES the live SDAM topology per connection, so the answer is real.
 *
 * ## Three answers, not two (rule 3)
 *
 * An UNREADABLE topology — bound before the connection opened, a driver that
 * exposes none — is reported as `transactions: false` with resolution
 * `'unknown'`. It REFUSES exactly like an observed `false`, because an
 * unobserved outcome is never a positive one and "we could not confirm atomic
 * commit" carries the same risk as "there is no atomic commit". But the
 * operator's fix is different (bind later vs. run a replica set), so the
 * message is different.
 *
 * ## The escape hatch is opt-IN, never opt-out
 *
 * `allowNonTransactional` absent ⇒ transactions REQUIRED. A deployment that
 * genuinely accepts non-atomic refunds (local dev on a standalone) says so in
 * its runtime, where an operator can see it, and it logs.
 */

import { transactionResolutionOf } from '@classytic/mongokit';
import type { RepoCapabilities } from '@classytic/repo-core/repository';
import { RevenueError } from '../core/errors.js';
import type { RevenueLogger } from './engine-types.js';

/**
 * Capabilities revenue cannot run without under ANY configuration — no opt-in
 * reaches these, because there is no degraded mode for them:
 *
 *   - `duplicateKeyError` — the idempotency contract. `transaction.repository`
 *     and `refund.repository` map a residual E11000 on the idempotency-key
 *     index to "return the payment already recorded". A backend that cannot
 *     CLASSIFY a duplicate-key conflict turns that into a double charge.
 *   - `upsert` — atomic `findOneAndUpdate` upserts back the settlement and
 *     subscription-cycle paths.
 */
export const REVENUE_REQUIRED_CAPABILITIES = ['duplicateKeyError', 'upsert'] as const;

/** Thrown at bind when the wired backend cannot satisfy revenue's contract. */
export class RevenueCapabilityError extends RevenueError {
  readonly missing: readonly string[];
  /**
   * `true` when the backend never ANSWERED rather than answering "no". Both
   * refuse; the remedy differs.
   */
  readonly indeterminate: boolean;

  constructor(missing: readonly string[], remedy: string, indeterminate = false) {
    super(
      `[revenue] backend missing required ${
        missing.length === 1 ? 'capability' : 'capabilities'
      }: ${missing.join(', ')}. ${remedy}`,
      'ENGINE_MISSING_CAPABILITIES',
      { missing: [...missing], indeterminate },
      500,
    );
    this.name = 'RevenueCapabilityError';
    this.missing = missing;
    this.indeterminate = indeterminate;
  }
}

export interface AssertRevenueCapabilitiesOptions {
  /**
   * Explicit host opt-in to non-atomic money writes (standalone Mongo, local
   * dev). Absent / false ⇒ a backend without `transactions` FAILS THE BIND.
   * Waives ONLY `transactions`.
   */
  allowNonTransactional?: boolean | undefined;
  /** Where the opt-in warning goes. Defaults to `console`. */
  logger?: Pick<RevenueLogger, 'warn'> | undefined;
}

const TRANSACTION_REMEDY_OBSERVED =
  'Run MongoDB as a replica set (or mongos) so multi-document transactions are available. ' +
  'For local development on a standalone mongod, accept the partial-write risk explicitly ' +
  'with `allowNonTransactional: true` in the RevenueRuntime.';

const TRANSACTION_REMEDY_UNKNOWN =
  'The topology could not be read — the connection was most likely not open at bind time. ' +
  'Bind AFTER `await mongoose.connect(...)` / `await connection.asPromise()`, or call ' +
  '`await probeMongoCapabilities(connection)` first. If the deployment genuinely has no ' +
  'transactions, set `allowNonTransactional: true` in the RevenueRuntime.';

export function assertRevenueCapabilities(
  repo: { capabilities?: RepoCapabilities | undefined },
  opts: AssertRevenueCapabilitiesOptions = {},
): void {
  const caps = repo.capabilities;
  if (!caps) {
    // An ABSENT descriptor is not an implicit "yes", and is NOT waivable —
    // a backend too old to declare capabilities is broken, not a choice.
    throw new RevenueCapabilityError(
      ['capabilities descriptor'],
      'The wired repository backend declares no `capabilities` descriptor ' +
        '(repo-core 0.6 / mongokit 3.16+ required). Upgrade the persistence kit.',
    );
  }

  const missing = REVENUE_REQUIRED_CAPABILITIES.filter((flag) => caps[flag] !== true);
  if (missing.length > 0) {
    throw new RevenueCapabilityError(
      missing,
      'Payment idempotency needs duplicate-key classification and settlement needs atomic ' +
        'upserts — without them a retried capture charges twice.',
    );
  }

  if (caps.transactions === true) return;

  const indeterminate = transactionResolutionOf(caps) === 'unknown';
  const problem = indeterminate
    ? 'It could NOT be determined whether the backend supports multi-document transactions, ' +
      'and an unconfirmed answer is treated as unsupported — capture settlement and refund ' +
      'claim/rollback may silently fail to be atomic.'
    : 'The backend does not support multi-document transactions, so capture settlement and ' +
      'refund claim/rollback cannot be atomic.';

  if (opts.allowNonTransactional) {
    (opts.logger ?? console).warn(
      `[revenue] ${problem} allowNonTransactional=true: money writes proceed WITHOUT ` +
        'atomicity — a crash mid-refund can leave a claim released with the refund already ' +
        'sent, which is a double refund on the retry. Do not run this in production.',
    );
    return;
  }

  throw new RevenueCapabilityError(
    ['transactions'],
    `${problem} ${indeterminate ? TRANSACTION_REMEDY_UNKNOWN : TRANSACTION_REMEDY_OBSERVED}`,
    indeterminate,
  );
}
