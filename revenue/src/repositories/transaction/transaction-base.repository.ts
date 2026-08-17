import { RevenueRepositoryBase } from '../base.repository.js';
import type { DomainEvent } from '@classytic/primitives/events';
import type { TransactionDocument } from '../../models/transaction.schema.js';
import type { TransactionRepoDeps } from './transaction-types.js';

/**
 * Neutral shared base for the transaction-repository lifecycle layers.
 *
 * The full repository is assembled as a single class through an inheritance chain
 * (`TransactionRepositoryBase → TransactionBankFeedRepository → TransactionRefundRepository →
 * TransactionRepository`). The chain is a COMPOSITION mechanism to keep one class over one
 * collection — it does NOT mean payments depend on refunds or refunds on bank feeds. Each
 * layer just contributes a cohesive group of verbs. This base owns only what every layer
 * shares: the phased-dispatch helpers (PACKAGE_RULES §P8 / §5.5).
 *
 * Phased dispatch — `saveToOutbox` runs INSIDE a `withTransaction` body so the event row
 * commits atomically with the business write; `publishToTransport` runs AFTER commit so
 * in-process subscribers fire only when the parent write succeeded. For verbs that don't open
 * their own session, the base `dispatch()` (from `RevenueRepositoryBase`) is simpler.
 */
export abstract class TransactionRepositoryBase extends RevenueRepositoryBase<
  TransactionDocument,
  TransactionRepoDeps
> {
  /**
   * Host acceptance of a NON-TRANSACTIONAL deployment (a standalone `mongod`).
   *
   * ## The defect this closes — the worst of the five
   *
   * `allowNonTransactional` existed on the revenue runtime and was consumed by exactly one
   * place: the boot gate, which PRINTS "money writes proceed WITHOUT atomicity" and then
   * lets the host start. Every actual `withTransaction` call below passed no options, and
   * mongokit defaults `allowFallback: false` — so on a standalone mongod the boot log said
   * one thing and the write did another.
   *
   * What that cost: `refund()` fails AFTER the provider call may already have gone out;
   * `releaseRefundReservation` and `finalizeConfirmedRefund` — the two resolvers that
   * settle a refund attempt — can never run, so `PaymentAttempt.outcome` stays
   * `pending`/`unknown` and `pendingRefundAmount` stays reserved forever. And
   * `scanStaleAttempts` cannot converge it, because its repair path is the same broken
   * transaction. A refund the customer was told succeeded, unrecoverable by design.
   *
   * Set from the runtime; `false` keeps production fail-closed.
   */
  protected allowNonTransactional = false;

  /**
   * Save an event to the host-owned outbox, session-bound when available.
   *
   * Called INSIDE a `withTransaction` body. The outbox row commits atomically with the
   * business write (P8 true session-bound write) — if outbox.save fails, this method re-throws
   * so `withTransaction` rolls the parent write back. Without propagation, the parent doc would
   * commit while the event row vanishes, defeating the transactional-outbox correctness
   * argument. Logging happens before the re-throw so the failure surfaces without losing the
   * original stack trace.
   */
  protected async saveToOutbox(event: DomainEvent, session?: unknown): Promise<void> {
    if (!this.deps.outbox) return;
    try {
      await this.deps.outbox.save(event, session !== undefined ? { session } : {});
    } catch (err) {
      this.deps.logger?.error('[revenue] outbox.save failed for', event.type, err);
      throw err;
    }
  }

  /**
   * Publish an event to the in-process `EventTransport` after commit. Transport failure is
   * logged and swallowed — the host relay re-delivers from the durable outbox row on its next
   * poll, so a missed in-process event is recoverable. Best-effort by design.
   */
  protected async publishToTransport(event: DomainEvent): Promise<void> {
    try {
      await this.deps.events.publish(event);
    } catch (err) {
      this.deps.logger?.error('[revenue] events.publish failed for', event.type, err);
    }
  }
}
