import type { RevenueContext } from '../core/context.js';

/**
 * LedgerBridge — host-implemented contract for posting revenue events
 * into a general-ledger / accounting system.
 *
 * Revenue does NOT import any ledger package directly (PACKAGE_RULES §23).
 * The host wires this bridge once at engine creation time; revenue's repo
 * verbs call the relevant hook after each state transition. Every method
 * is optional — features degrade gracefully when omitted.
 *
 * Two phases of hooks:
 *
 *   1. **Payment-flow hooks** (`onPaymentVerified`, `onRefundProcessed`,
 *      `onSettlementCompleted`) — the original Stripe-style integration.
 *      Fired when a gateway transaction reaches a terminal accounting
 *      moment.
 *
 *   2. **Bank-feed hooks** (`onTransactionImported`, `onTransactionMatched`,
 *      `onTransactionJournalized`, `onTransactionRejected`,
 *      `onTransactionUnmatched`, `onTransactionRemovedByFeed`) — added
 *      in 3.0. Fired during the bank-feed lifecycle so the host can post
 *      JEs at match time, recall them on un-match, and chain
 *      `journalize()` after a successful JE post.
 *
 * The canonical wiring for `onTransactionMatched` is:
 *
 * ```ts
 * const ledgerBridge: LedgerBridge = {
 *   async onTransactionMatched(txn, mapping, ctx) {
 *     const report = await wireImport({
 *       source: [{ txn, mapping }],
 *       mapper: bankToJournalEntryMapper(mapping),
 *       journalEntries: ledger.repositories.journalEntry,
 *       context: { organizationId: ctx.organizationId },
 *     }).run();
 *     if (report.ok && report.entries[0]) {
 *       await revenue.repositories.transaction.journalize(
 *         String(txn._id),
 *         { journalEntryRef: { type: 'JournalEntry', id: report.entries[0].id } },
 *         ctx,
 *       );
 *     }
 *   },
 * };
 * ```
 */
export interface LedgerBridge {
  // ─── Payment flow ───
  /** Fired when a gateway transaction reaches `verified` status. */
  onPaymentVerified?(transaction: Record<string, unknown>, ctx: RevenueContext): Promise<void>;
  /** Fired after a refund posts (the new outflow row + the updated original). */
  onRefundProcessed?(
    original: Record<string, unknown>,
    refund: Record<string, unknown>,
    ctx: RevenueContext,
  ): Promise<void>;
  /** Fired when a settlement record reaches `completed`. */
  onSettlementCompleted?(settlement: Record<string, unknown>, ctx: RevenueContext): Promise<void>;

  // ─── Bank feed / accounting feed (3.0) ───
  /**
   * Fired once per row inserted by `import()`. Use this for live preview
   * dashboards or downstream materialized views — most production hosts
   * leave this unimplemented and act on the per-batch `events.publish`
   * stream instead.
   */
  onTransactionImported?(
    transaction: Record<string, unknown>,
    ctx: RevenueContext,
  ): Promise<void>;
  /**
   * Fired after `match()` succeeds. The host's typical implementation
   * posts a journal entry via the host's ledger package (e.g. arc's
   * `wireImport` over `@classytic/ledger`'s `journalEntry` repository),
   * then calls `revenue.repositories.transaction.journalize(id, …)` so
   * the row transitions `matched → journalized`.
   */
  onTransactionMatched?(
    transaction: Record<string, unknown>,
    mapping: { debitAccount?: string; creditAccount?: string; notes?: string },
    ctx: RevenueContext,
  ): Promise<void>;
  /**
   * Fired after `unmatch()` succeeds. Hosts can void / reverse the
   * journal entry created at match time. Pass the prior
   * `journalEntryRef` so reversal is keyed correctly.
   */
  onTransactionUnmatched?(
    transaction: Record<string, unknown>,
    priorJournalEntryRef: { type: string; id: string } | undefined,
    ctx: RevenueContext,
  ): Promise<void>;
  /**
   * Fired after `journalize()` stamps `journalEntryRef` on the row.
   * Most hosts are passive on this hook (the JE was created in
   * `onTransactionMatched`); useful for audit logs and analytics.
   */
  onTransactionJournalized?(
    transaction: Record<string, unknown>,
    journalEntryRef: { type: string; id: string },
    ctx: RevenueContext,
  ): Promise<void>;
  /**
   * Fired after `reject()` — operator skip on a duplicate / non-cash
   * import. Hosts typically log for audit.
   *
   * **JE reversal contract.** `reject()` is legal from `'matched'` as
   * well as `'imported'`. If your `onTransactionMatched` posted a JE
   * synchronously (the typical bridge implementation), the JE must be
   * reversed here — revenue itself never calls into ledger and has no
   * way to know one exists. Idempotency is the bridge's responsibility:
   * a reject on a never-journalized row should be a no-op for ledger,
   * a reject after journalize should void the JE keyed off
   * `transaction.matching` or whatever the host stamped at match time.
   */
  onTransactionRejected?(
    transaction: Record<string, unknown>,
    reason: string,
    ctx: RevenueContext,
  ): Promise<void>;
  /**
   * Fired when the upstream feed retracts a row (Plaid `removed[]`,
   * OFX correction, QBO CDC delete). The transaction is soft-deleted
   * before this hook runs. If a JE was already posted, the host
   * should reverse it.
   */
  onTransactionRemovedByFeed?(
    transaction: Record<string, unknown>,
    ctx: RevenueContext,
  ): Promise<void>;
}
