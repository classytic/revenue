import { withTransaction } from '@classytic/mongokit';
import type { ClientSession } from 'mongoose';
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
 * A verb that opens its own transaction and emits events uses `transactionWithEvents`; one
 * that doesn't uses the base `dispatch()` (from `RevenueRepositoryBase`).
 */
export abstract class TransactionRepositoryBase extends RevenueRepositoryBase<
  TransactionDocument,
  TransactionRepoDeps
> {
  /**
   * The runtime's `allowNonTransactional`, honoured by EVERY transaction this repository opens
   * (`allowFallback`) — the boot gate saying "non-transactional" while the writes refused to run
   * left refunds unresolvable on a standalone mongod. `false` keeps production fail-closed.
   */
  protected allowNonTransactional = false;

  /**
   * The ONE way a verb opens a transaction that emits events. `emit` writes the outbox row in
   * the transaction (a failed save rolls the write back); the events are delivered once, after
   * commit, per the engine's dispatch mode.
   *
   * Each attempt starts with no events: `withTransaction` re-runs the body on a transient
   * error, and the aborted attempt's event — its row rolled back — must never be delivered.
   *
   * `afterCommit` runs between commit and delivery (e.g. bridges that must see the write first).
   */
  protected async transactionWithEvents<T>(
    body: (session: ClientSession, emit: (event: DomainEvent) => Promise<void>) => Promise<T>,
    afterCommit?: (result: T) => Promise<void>,
  ): Promise<T> {
    let events: DomainEvent[] = [];
    const result = await withTransaction(
      this.Model.db as unknown as { startSession(): Promise<ClientSession> },
      async (session) => {
        const attempt: DomainEvent[] = [];
        events = attempt;
        return body(session, async (event) => {
          if (this.deps.outbox) {
            try {
              await this.deps.outbox.save(event, session ? { session } : {});
            } catch (err) {
              this.deps.logger?.error('[revenue] outbox.save failed for', event.type, err);
              throw err;
            }
          }
          attempt.push(event);
        });
      },
      { allowFallback: this.allowNonTransactional },
    );
    if (afterCommit) await afterCommit(result);
    await this.deliverAll(events);
    return result;
  }
}
