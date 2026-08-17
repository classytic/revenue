import { Repository, type BatchOperationsMethods } from '@classytic/mongokit';
import type { TransactionDocument } from '../../models/transaction.schema.js';
import type { RevenueContext } from '../../core/context.js';
import type { FetchTransactionsParams } from '../../providers/bank-feed.js';
import type {
  BankImportReport,
  BankImportRowError,
  BankTransaction,
} from '@classytic/primitives/bank-transaction';
import type { PaymentMethodKind } from '@classytic/primitives/payment-method-kind';
import { TransactionRepositoryBase } from './transaction-base.repository.js';
import { createEvent } from '../../events/helpers.js';
import { REVENUE_EVENTS } from '../../events/event-constants.js';
import { TRANSACTION_STATUS, type TransactionStatusValue } from '../../enums/transaction.enums.js';
import {
  TRANSACTION_KIND,
  type TransactionKindValue,
  initialStatusFor,
} from '../../enums/bank-feed.enums.js';
import { smFor } from '../../core/state-machines.js';
import {
  BankFeedImportError,
  MethodKindLockedError,
  TransactionNotFoundError,
  ValidationError,
  WrongTransactionKindError,
} from '../../core/errors.js';
import { fromSet, isTransitionRace } from '../transition-support.js';

/** Transaction repo augmented with mongokit's batch-operations surface (bank-feed `import` uses `bulkWrite`). */
type RepoWithBulkWrite = Repository<TransactionDocument> & Partial<BatchOperationsMethods>;

/**
 * Bank-feed + manual lifecycle layer of the transaction repository, plus the shared
 * phased-dispatch helpers every lifecycle uses (kept here, the base-most transaction
 * layer, so the refund and payment layers inherit them). Self-contained: none of these
 * verbs call the payment/escrow/refund lifecycle. See `transaction.repository.ts` for the
 * full class doc.
 */
export abstract class TransactionBankFeedRepository extends TransactionRepositoryBase {
  async import(
    rows: BankTransaction[],
    opts: {
      bankAccountId: string;
      source: string;
      methodKind: PaymentMethodKind;
      method?: string;
      /**
       * Override the born status of newly-inserted rows. Defaults to
       * `initialStatusFor(bank_feed)` = `imported` (matchable). Pass
       * `reconciled_external` for vendor-reconciled rows (Xero Payments /
       * transfer legs) so they are BORN terminal + non-matchable and can
       * never post a journal entry. Applies to `$setOnInsert` only — re-imports
       * never overwrite an existing row's status.
       */
      initialStatus?: TransactionStatusValue;
    },
    ctx: RevenueContext = {},
  ): Promise<BankImportReport> {
    // No default — callers must be intentional. A Stripe balance import
    // is `'card'`, not bank_transfer; a Plaid drain is `'bank_transfer'`;
    // a crypto-exchange CSV is `'cryptocurrency'`. Silently defaulting
    // to `'bank_transfer'` would mis-classify those into accounting
    // reports and analytics.
    if (!opts.methodKind) {
      throw new BankFeedImportError(
        '`opts.methodKind` is required on TransactionRepository.import() — ' +
          'pick the canonical PaymentMethodKind for the source (e.g. `\'bank_transfer\'` for Plaid/OFX, ' +
          '`\'card\'` for a Stripe balance, `\'wallet\'` for PayPal, `\'cryptocurrency\'` for an exchange).',
      );
    }
    // Tenant-scope guard (MED). `import()` builds raw `bulkWrite` filters that
    // bypass the multi-tenant plugin's `required` check, so when scoping is
    // enabled a missing `ctx.organizationId` would silently upsert an
    // UNSCOPED bank row (invisible to every tenant-scoped read, and a
    // cross-org leak on a shared `externalId`). Fail loud instead. Single-
    // tenant / scoping-off engines leave `tenantScopeEnabled` false and pass.
    if (this.deps.tenantScopeEnabled && ctx.organizationId === undefined) {
      throw new BankFeedImportError(
        'Tenant scoping is enabled but `ctx.organizationId` is missing on import() — ' +
          'refusing to upsert unscoped bank rows. Pass the organization in the operation context.',
      );
    }

    const startedAt = Date.now();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { inserted: 0, updated: 0, skipped: 0, errors: [], durationMs: 0 };
    }

    const repo = this as unknown as RepoWithBulkWrite;
    if (!repo.bulkWrite) {
      throw new BankFeedImportError(
        'TransactionRepository requires `batchOperationsPlugin` for `import()`. ' +
          'Pass it via the bind runtime: `defineRevenue(shape).bind(conn, { repositoryPlugins: { transaction: [batchOperationsPlugin()] } })` ' +
          '— or rely on the engine default which wires it automatically.',
      );
    }

    const errors: BankImportRowError[] = [];
    const tenantOption = ctx.organizationId !== undefined ? { organizationId: ctx.organizationId } : {};

    // Build bulk operations. `$setOnInsert` carries fields that must NOT be
    // overwritten by re-imports (kind, status, externalId, bankAccountId,
    // organizationId — anything that pins identity). `$set` carries fields
    // that MAY drift (description, category, balance, counterparty enrichment).
    const ops: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!row.externalId || typeof row.externalId !== 'string') {
        errors.push({ externalId: String(row.externalId), reason: 'missing_external_id', row });
        continue;
      }
      // primitives.Money.amount is already integer minor units (number),
      // signed by convention (positive = inflow). No bigint conversion.
      const signed = row.amount.amount;
      if (!Number.isFinite(signed) || !Number.isInteger(signed)) {
        errors.push({ externalId: row.externalId, reason: 'invalid_amount', row });
        continue;
      }
      const isInflow = signed >= 0;
      const absoluteAmount = Math.abs(signed);

      const filter: Record<string, unknown> = {
        bankAccountId: opts.bankAccountId,
        externalId: row.externalId,
      };
      if (ctx.organizationId !== undefined) filter.organizationId = ctx.organizationId;

      const set: Record<string, unknown> = {
        amount: absoluteAmount,
        currency: row.amount.currency,
        flow: isInflow ? 'inflow' : 'outflow',
        postedDate: row.postedDate,
        description: row.description,
        method: opts.method ?? opts.source,
      };
      if (row.valueDate !== undefined) set.valueDate = row.valueDate;
      if (row.counterparty !== undefined) set.counterparty = row.counterparty;
      if (row.reference !== undefined) set.reference = row.reference;
      if (row.category !== undefined) set.vendorCategory = row.category;
      if (row.balanceAfter !== undefined) set.balanceAfter = row.balanceAfter.amount;

      const setOnInsert: Record<string, unknown> = {
        kind: TRANSACTION_KIND.BANK_FEED,
        // Born status: caller may override to `reconciled_external` so
        // vendor-reconciled rows are terminal + non-matchable from insert.
        status: opts.initialStatus ?? initialStatusFor(TRANSACTION_KIND.BANK_FEED),
        bankAccountId: opts.bankAccountId,
        externalId: row.externalId,
        source: opts.source,
        type: 'bank_feed',
        tags: ['bank_feed', opts.source],
        methodKind: opts.methodKind,
        fee: 0,
        tax: 0,
        net: absoluteAmount,
      };
      if (ctx.organizationId !== undefined) setOnInsert.organizationId = ctx.organizationId;

      ops.push({
        updateOne: {
          filter,
          update: { $set: set, $setOnInsert: setOnInsert },
          upsert: true,
        },
      });
    }

    if (ops.length === 0) {
      return { inserted: 0, updated: 0, skipped: rows.length, errors, durationMs: Date.now() - startedAt };
    }

    const sessionOption: Record<string, unknown> = ctx.session !== undefined ? { session: ctx.session } : {};
    const result = (await repo.bulkWrite(ops, { ordered: false, ...sessionOption, ...tenantOption })) as {
      insertedCount: number;
      upsertedCount: number;
      modifiedCount: number;
      upsertedIds: Record<string | number, unknown>;
    };

    const inserted = (result.upsertedCount ?? 0) + (result.insertedCount ?? 0);
    const updated = result.modifiedCount ?? 0;
    const upsertedIds = Object.values(result.upsertedIds ?? {});

    // Fan out one event per *inserted* row. Re-imports (modifications only)
    // do not re-fire the imported event — subscribers can't tell idempotent
    // re-imports apart from genuine new rows otherwise.
    if (upsertedIds.length > 0) {
      for (let i = 0; i < upsertedIds.length; i++) {
        const id = upsertedIds[i];
        if (id === undefined || id === null) continue;
        const doc = await this.getById(String(id), this.optsFromCtx(ctx, { throwOnNotFound: false }));
        if (!doc) continue;
        const txn = doc as unknown as TransactionDocument;
        await this.dispatch(
          createEvent(
            REVENUE_EVENTS.TRANSACTION_IMPORTED,
            {
              transaction: txn,
              source: opts.source,
              bankAccountId: opts.bankAccountId,
              externalId: txn.externalId ?? '',
            },
            ctx,
            { resource: 'transaction', resourceId: txn.publicId },
          ),
          ctx,
        );
        await this.deps.bridges.ledger?.onTransactionImported?.(txn as unknown as Record<string, unknown>, ctx);
      }
    }

    return {
      inserted,
      updated,
      skipped: errors.length,
      errors,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Drain a bank-feed provider into the collection.
   *
   * Pulls pages from `provider.fetchTransactions()` (Plaid cursor, QBO
   * CDC) and feeds each batch through `import()`. Yields the running
   * report so a host cron can stream-progress-report to logs / metrics.
   *
   * Stops when the provider returns no new rows AND no removals AND no
   * `nextCursor`. Caller is responsible for persisting the final cursor
   * in their own checkpoint table — `result.nextCursor` is returned so
   * the host can write it after a successful drain.
   *
   * Plaid `removed[]` rows (and any provider that retracts entries) are
   * routed through `removeByFeed` so the host's LedgerBridge can void
   * any JE that was already posted.
   */
  async drainSync(
    providerName: string,
    params: FetchTransactionsParams & { bankAccountId: string; methodKind: PaymentMethodKind },
    ctx: RevenueContext = {},
  ): Promise<{ totalImported: number; totalUpdated: number; totalRemoved: number; nextCursor?: string; errors: BankImportRowError[] }> {
    if (!this.deps.bankFeedProviders) {
      throw new ValidationError(
        '`bankFeedProviders` not wired on the engine. Pass them in the bind runtime: `defineRevenue(shape).bind(conn, { bankFeedProviders })`.',
      );
    }
    const provider = this.deps.bankFeedProviders.get(providerName);

    let totalImported = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;
    let lastCursor: string | undefined;
    const errors: BankImportRowError[] = [];

    for await (const page of provider.drain(params)) {
      if (page.transactions && page.transactions.length > 0) {
        const report = await this.import(
          page.transactions,
          { bankAccountId: params.bankAccountId, source: providerName, methodKind: params.methodKind },
          ctx,
        );
        totalImported += report.inserted;
        totalUpdated += report.updated;
        if (report.errors.length > 0) errors.push(...report.errors);
      }
      if (page.removed && page.removed.length > 0) {
        const removed = await this.removeByFeed(
          page.removed.map((r) => r.externalId),
          { bankAccountId: params.bankAccountId, source: providerName },
          ctx,
        );
        totalRemoved += removed.removed;
      }
      if (page.nextCursor) lastCursor = page.nextCursor;
    }

    return {
      totalImported,
      totalUpdated,
      totalRemoved,
      ...(lastCursor !== undefined ? { nextCursor: lastCursor } : {}),
      errors,
    };
  }

  /**
   * Parse an upload (OFX / CAMT.053 / MT940 / CSV) via a registered
   * bank-feed provider, then `import()` the result.
   *
   * Convenience over manually calling `provider.parseUpload()` and
   * threading the canonical rows into `import()` — the file-upload
   * route handler is one line.
   */
  async parseAndImport(
    providerName: string,
    upload: { buffer: Buffer | string | Uint8Array; format?: string; bankAccountId: string; methodKind: PaymentMethodKind },
    ctx: RevenueContext = {},
  ): Promise<BankImportReport> {
    if (!this.deps.bankFeedProviders) {
      throw new ValidationError('`bankFeedProviders` not wired on the engine.');
    }
    const provider = this.deps.bankFeedProviders.get(providerName);
    if (!provider.parseUpload) {
      throw new ValidationError(`Provider '${providerName}' does not support parseUpload`);
    }
    const parsed = await provider.parseUpload({
      buffer: upload.buffer,
      ...(upload.format !== undefined ? { format: upload.format as never } : {}),
      bankAccountId: upload.bankAccountId,
    });
    return this.import(
      parsed.transactions,
      { bankAccountId: upload.bankAccountId, source: providerName, methodKind: upload.methodKind },
      ctx,
    );
  }

  /**
   * Hand-keyed entry — treasurer logs a cash deposit, owner injects
   * capital, refund correction. Created in `pending` (manual SM); host
   * proceeds with `match()` → `journalize()` to post it to the ledger.
   *
   * `kind: 'manual'` is enforced — calls passing other kinds throw.
   */
  async createManual(
    data: {
      amount: number;
      currency: string;
      flow: 'inflow' | 'outflow';
      type: string;
      methodKind: PaymentMethodKind;
      description?: string;
      counterparty?: TransactionDocument['counterparty'];
      reference?: string;
      postedDate?: Date;
      valueDate?: Date;
      bankAccountId?: string;
      sourceId?: string;
      sourceModel?: string;
      metadata?: Record<string, unknown>;
    },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const doc = await this.create(
      {
        organizationId: ctx.organizationId,
        kind: TRANSACTION_KIND.MANUAL,
        type: data.type,
        flow: data.flow,
        tags: ['manual'],
        amount: data.amount,
        currency: data.currency,
        fee: 0,
        tax: 0,
        net: data.amount,
        method: 'manual',
        methodKind: data.methodKind,
        status: initialStatusFor(TRANSACTION_KIND.MANUAL),
        source: 'manual',
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.counterparty !== undefined ? { counterparty: data.counterparty } : {}),
        ...(data.reference !== undefined ? { reference: data.reference } : {}),
        ...(data.postedDate !== undefined ? { postedDate: data.postedDate } : {}),
        ...(data.valueDate !== undefined ? { valueDate: data.valueDate } : {}),
        ...(data.bankAccountId !== undefined ? { bankAccountId: data.bankAccountId } : {}),
        ...(data.sourceId !== undefined ? { sourceId: data.sourceId } : {}),
        ...(data.sourceModel !== undefined ? { sourceModel: data.sourceModel } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
      } as never,
      this.optsFromCtx(ctx),
    );

    return doc as TransactionDocument;
  }

  /**
   * Backfill the `methodKind` on a Transaction created with kind
   * unknown — the canonical use case is hosted-checkout (Stripe
   * Checkout, PayPal redirect, Razorpay Checkout) where the customer
   * picks their payment method on the gateway's UI, AFTER the host has
   * already created the ProviderIntent + Transaction with
   * `methodKind: 'other'`.
   *
   * Call this from your verification / webhook handler once you know
   * the customer's actual choice — e.g. inside
   * `payment_intent.succeeded`:
   *
   * ```ts
   * await transactionRepository.backfillMethodKind(
   *   tx._id,
   *   stripePaymentIntentToKind(event.data.object),
   *   ctx,
   * );
   * ```
   *
   * **Guard rule.** Atomic CAS — succeeds only when the doc has
   * `methodKind === 'other'` AND `status === 'pending'`. Any other
   * combination throws `MethodKindLockedError` (HTTP 409): once a
   * transaction has a specific kind (or has settled past pending),
   * silently overwriting it would corrupt downstream analytics and
   * accounting reports.
   *
   * Emits `revenue:transaction.updated` with `changedFields:
   * ['methodKind']` so subscribers can re-bucket the row.
   */
  async backfillMethodKind(
    transactionId: string,
    methodKind: PaymentMethodKind,
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const updated = await this.findOneAndUpdate<TransactionDocument>(
      {
        _id: transactionId,
        methodKind: 'other',
        status: TRANSACTION_STATUS.PENDING,
      },
      { $set: { methodKind } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const existing = (await this.getById(
        transactionId,
        this.optsFromCtx(ctx, { throwOnNotFound: false }),
      )) as TransactionDocument | null;
      if (!existing) throw new TransactionNotFoundError(transactionId);
      throw new MethodKindLockedError(
        transactionId,
        existing.methodKind ?? 'unknown',
        existing.status ?? 'unknown',
      );
    }

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_UPDATED,
        { transaction: updated, changedFields: ['methodKind'] },
        ctx,
        { resource: 'transaction', resourceId: (updated as TransactionDocument).publicId },
      ),
      ctx,
    );

    return updated as TransactionDocument;
  }

  /**
   * Match a bank-feed / manual transaction to GL accounts, optionally
   * cross-linking to an upstream payment-flow transaction.
   *
   * Atomic state CAS via `claim()` — the `where: { kind: { $in: [...] } }`
   * predicate prevents a payment-flow row from being matched through this
   * verb. Multi-source `from` (`['imported', 'matched']`) supports
   * re-match after `unmatch()` (`matched → imported → matched`) without
   * losing the prior mapping if the host wants to overwrite it.
   *
   * After a successful claim, `LedgerBridge.onTransactionMatched` runs
   * — the canonical implementation creates a journal entry and chains
   * `journalize()` to record the JE ref. The bridge call is OUTSIDE the
   * claim's CAS window because JE posting is a side effect that may
   * take seconds (cross-process call to ledger).
   */
  async match(
    id: string,
    data: {
      mapping: { debitAccount?: string; creditAccount?: string; notes?: string };
      relatedTransactionId?: string;
      matchedBy?: string;
    },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }

    // Compile-time check — feeding the right machine; primitives' assertTransition fires
    // via the StateMachine wrapper and rejects illegal current states before the round-trip.
    const machine = smFor(existing.kind);

    const set: Record<string, unknown> = {
      matching: {
        ...data.mapping,
        ...(data.matchedBy !== undefined ? { matchedBy: data.matchedBy } : {}),
        matchedAt: new Date(),
      },
      ...(data.matchedBy !== undefined ? { verifiedBy: data.matchedBy } : {}),
      verifiedAt: new Date(),
    };
    if (data.relatedTransactionId !== undefined) {
      set.relatedTransactionId = data.relatedTransactionId;
    }

    // Multi-source machine-gated CAS (mongokit applyTransition):
    // `imported/pending → matched` are the per-kind happy paths;
    // `matched → matched` (re-match-with-different-mapping) is the
    // idempotent RE-CLAIM the 3.22.1 semantics admit. `fromSet` narrows
    // the historical shared array to the kind's table truth.
    // Belt-and-suspenders `$unset journalEntryRef`: a re-match must drop
    // any prior ref — a stale pointer at a superseded JE is the worst
    // class of accounting bug. Cheap to unconditionally clear.
    const claimed = (await this.applyTransition(
      String(existing._id),
      machine,
      {
        from: fromSet(
          machine,
          [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED, TRANSACTION_STATUS.PENDING],
          TRANSACTION_STATUS.MATCHED,
        ),
        to: TRANSACTION_STATUS.MATCHED,
        where: { kind: existing.kind },
        set,
        unset: { journalEntryRef: 1 },
        history: false,
      },
      this.optsFromCtx(ctx) as never,
    ).catch((err: unknown) => {
      if (isTransitionRace(err)) {
        throw new ValidationError(`Transaction ${id} could not be matched (race-loss or illegal state)`);
      }
      throw err;
    })) as TransactionDocument;

    await this.deps.bridges.ledger?.onTransactionMatched?.(
      claimed as unknown as Record<string, unknown>,
      data.mapping,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_MATCHED,
        {
          transaction: claimed,
          mapping: data.mapping,
          ...(data.relatedTransactionId !== undefined ? { relatedTransactionId: data.relatedTransactionId } : {}),
          ...(data.matchedBy !== undefined ? { matchedBy: data.matchedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Revert a matched transaction back to `imported`. Clears the
   * `matching` block and `relatedTransactionId`. Notifies the
   * LedgerBridge (which typically voids the journal entry) AFTER the
   * state CAS lands.
   *
   * Only legal for `kind: 'bank_feed'` — manual entries don't allow
   * un-match (the manual SM has no `matched → pending` edge).
   */
  async unmatch(
    id: string,
    options: { unmatchedBy?: string } = {},
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED) {
      throw new WrongTransactionKindError(id, 'bank_feed', existing.kind);
    }

    const priorJournalEntryRef = existing.journalEntryRef;

    const claimed = (await this.applyTransition(
      String(existing._id),
      smFor(existing.kind),
      {
        from: TRANSACTION_STATUS.MATCHED,
        to: TRANSACTION_STATUS.IMPORTED,
        where: { kind: TRANSACTION_KIND.BANK_FEED },
        unset: {
          matching: 1,
          relatedTransactionId: 1,
          journalEntryRef: 1,
          verifiedBy: 1,
          verifiedAt: 1,
        },
        history: false,
      },
      this.optsFromCtx(ctx) as never,
    ).catch((err: unknown) => {
      if (isTransitionRace(err)) {
        throw new ValidationError(`Transaction ${id} could not be unmatched (current state is not 'matched')`);
      }
      throw err;
    })) as TransactionDocument;

    await this.deps.bridges.ledger?.onTransactionUnmatched?.(
      claimed as unknown as Record<string, unknown>,
      priorJournalEntryRef,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_UNMATCHED,
        {
          transaction: claimed,
          ...(options.unmatchedBy !== undefined ? { unmatchedBy: options.unmatchedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Reconcile a bank-feed / manual row that settled a linked document
   * (invoice/bill) WITHOUT posting a journal entry. The document's payment
   * already owns the cash JE (`Dr Bank / Cr AR`), so the bank line only needs
   * its status moved to `settled` — calling `match()` here would fire
   * `LedgerBridge.onTransactionMatched` and double-count the cash. This is the
   * package's intended path when the JE lives elsewhere (the reachable sibling
   * of the born-`reconciled_external` import).
   *
   * `imported → settled` (bank_feed) / `pending → settled` (manual). Idempotent:
   * a row already `settled` is returned unchanged, so a best-effort caller can
   * safely re-run. The optional `metadata` is shallow-merged onto the document's
   * `metadata` (dotted `$set`, so sibling keys survive) — hosts stamp the link
   * back to the settling document there. No JE bridge call, no domain event:
   * settlement is host-initiated and the host owns the reconcile audit trail.
   */
  async settle(
    id: string,
    data: { settledBy?: string; metadata?: Record<string, unknown> } = {},
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }
    // Idempotent: a best-effort caller may re-run after a settlement already
    // landed. `settled → settled` is not a legal edge, so short-circuit.
    if (existing.status === TRANSACTION_STATUS.SETTLED) {
      return existing;
    }

    const machine = smFor(existing.kind);

    const set: Record<string, unknown> = {
      verifiedAt: new Date(),
      ...(data.settledBy !== undefined ? { verifiedBy: data.settledBy } : {}),
    };
    // Shallow-merge metadata via dotted paths so unrelated metadata keys
    // survive (a whole-object `$set` would replace them).
    if (data.metadata) {
      for (const [k, v] of Object.entries(data.metadata)) {
        set[`metadata.${k}`] = v;
      }
    }

    const claimed = (await this.applyTransition(
      String(existing._id),
      machine,
      {
        from: fromSet(
          machine,
          [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.PENDING],
          TRANSACTION_STATUS.SETTLED,
        ),
        to: TRANSACTION_STATUS.SETTLED,
        where: { kind: existing.kind },
        set,
        history: false,
      },
      this.optsFromCtx(ctx) as never,
    ).catch((err: unknown) => {
      if (isTransitionRace(err)) {
        throw new ValidationError(`Transaction ${id} could not be settled (race-loss or illegal state)`);
      }
      throw err;
    })) as TransactionDocument;
    return claimed as TransactionDocument;
  }

  /**
   * Reverse a `settle()` — the linked document's payment was undone, so the
   * bank line returns to its birth status to re-enter the reconcile queue.
   * `settled → imported` (bank_feed) / `settled → pending` (manual). Clears
   * `verifiedAt`/`verifiedBy` plus any metadata keys named in `clearMetadata`
   * (the host-stamped link back to the now-reversed document). Idempotent: a
   * row not currently `settled` is returned unchanged.
   */
  async unsettle(
    id: string,
    data: { unsettledBy?: string; clearMetadata?: string[] } = {},
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }
    if (existing.status !== TRANSACTION_STATUS.SETTLED) {
      return existing; // nothing to reverse
    }

    // Restore the birth status deterministically by kind — a manual row was
    // born `pending`, a bank_feed row `imported`.
    const target = existing.kind === TRANSACTION_KIND.MANUAL
      ? TRANSACTION_STATUS.PENDING
      : TRANSACTION_STATUS.IMPORTED;
    const machine = smFor(existing.kind);

    const unset: Record<string, unknown> = { verifiedBy: 1, verifiedAt: 1 };
    for (const k of data.clearMetadata ?? []) {
      unset[`metadata.${k}`] = 1;
    }

    const claimed = (await this.applyTransition(
      String(existing._id),
      machine,
      {
        from: TRANSACTION_STATUS.SETTLED,
        to: target,
        where: { kind: existing.kind },
        unset,
        history: false,
      },
      this.optsFromCtx(ctx) as never,
    ).catch((err: unknown) => {
      if (isTransitionRace(err)) {
        throw new ValidationError(`Transaction ${id} could not be un-settled (current state is not 'settled')`);
      }
      throw err;
    })) as TransactionDocument;
    return claimed as TransactionDocument;
  }

  /**
   * Stamp the journal entry reference and transition `matched →
   * journalized`. Typical caller is the `LedgerBridge.onTransactionMatched`
   * implementation — after creating a JE, it calls this verb so the row
   * carries the back-reference.
   */
  async journalize(
    id: string,
    data: { journalEntryRef: { type: string; id: string }; journalizedBy?: string },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }

    const claimed = (await this.applyTransition(
      String(existing._id),
      smFor(existing.kind),
      {
        from: TRANSACTION_STATUS.MATCHED,
        to: TRANSACTION_STATUS.JOURNALIZED,
        where: { kind: existing.kind },
        set: { journalEntryRef: data.journalEntryRef },
        history: false,
      },
      this.optsFromCtx(ctx) as never,
    ).catch((err: unknown) => {
      if (isTransitionRace(err)) {
        throw new ValidationError(`Transaction ${id} could not be journalized (current state is not 'matched')`);
      }
      throw err;
    })) as TransactionDocument;

    await this.deps.bridges.ledger?.onTransactionJournalized?.(
      claimed as unknown as Record<string, unknown>,
      data.journalEntryRef,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_JOURNALIZED,
        {
          transaction: claimed,
          journalEntryRef: data.journalEntryRef,
          ...(data.journalizedBy !== undefined ? { journalizedBy: data.journalizedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Operator skip — marks an imported / matched / pending row as
   * rejected (terminal). Use cases: duplicate of an already-imported
   * row, non-cash entry the host doesn't want in the ledger, manual
   * correction overrides.
   *
   * `relatedTransactionId` is preserved; reversal is the host's call.
   */
  async reject(
    id: string,
    data: { reason: string; rejectedBy?: string },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument> {
    const existing = await this.getById(id, this.optsFromCtx(ctx)) as TransactionDocument | null;
    if (!existing) throw new TransactionNotFoundError(id);
    if (existing.kind !== TRANSACTION_KIND.BANK_FEED && existing.kind !== TRANSACTION_KIND.MANUAL) {
      throw new WrongTransactionKindError(id, 'bank_feed | manual', existing.kind);
    }

    const machine = smFor(existing.kind);

    const claimed = (await this.applyTransition(
      String(existing._id),
      machine,
      {
        from: fromSet(
          machine,
          [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED, TRANSACTION_STATUS.PENDING],
          TRANSACTION_STATUS.REJECTED,
        ),
        to: TRANSACTION_STATUS.REJECTED,
        where: { kind: existing.kind },
        set: {
          failureReason: data.reason,
          failedAt: new Date(),
          ...(data.rejectedBy !== undefined ? { verifiedBy: data.rejectedBy } : {}),
        },
        history: false,
      },
      this.optsFromCtx(ctx) as never,
    ).catch((err: unknown) => {
      if (isTransitionRace(err)) {
        throw new ValidationError(`Transaction ${id} could not be rejected (illegal current state)`);
      }
      throw err;
    })) as TransactionDocument;

    await this.deps.bridges.ledger?.onTransactionRejected?.(
      claimed as unknown as Record<string, unknown>,
      data.reason,
      ctx,
    );

    await this.dispatch(
      createEvent(
        REVENUE_EVENTS.TRANSACTION_REJECTED,
        {
          transaction: claimed,
          reason: data.reason,
          ...(data.rejectedBy !== undefined ? { rejectedBy: data.rejectedBy } : {}),
        },
        ctx,
        { resource: 'transaction', resourceId: (claimed as TransactionDocument).publicId },
      ),
      ctx,
    );

    return claimed as TransactionDocument;
  }

  /**
   * Soft-delete bank-feed rows that the upstream feed has retracted
   * (Plaid `removed[]`, OFX correction).
   *
   * Each row is matched by `(orgId, bankAccountId, externalId)`; rows
   * already journalized are NOT silently kept — they're surfaced in
   * `retainedJournalized` so the caller can surface them in the UI
   * ("the feed retracted these N rows but they're posted; reverse
   * manually"). The host's `LedgerBridge` should post a reversing JE
   * for those before any subsequent `delete()` can succeed.
   *
   * @returns `removed` (count soft-deleted), `retainedJournalized`
   *          (rows kept because they're already in the GL).
   */
  async removeByFeed(
    externalIds: string[],
    opts: { bankAccountId: string; source: string },
    ctx: RevenueContext = {},
  ): Promise<{ removed: number; retainedJournalized: TransactionDocument[] }> {
    if (externalIds.length === 0) return { removed: 0, retainedJournalized: [] };

    // Pull EVERY row matching the feed retraction — both the deletable
    // ones AND the journalized ones — so the caller sees what was kept.
    const allFilter: Record<string, unknown> = {
      kind: TRANSACTION_KIND.BANK_FEED,
      bankAccountId: opts.bankAccountId,
      externalId: { $in: externalIds },
    };
    const allDocs = (await this.findAll(
      allFilter,
      this.optsFromCtx(ctx),
    )) as unknown as TransactionDocument[];
    if (!Array.isArray(allDocs) || allDocs.length === 0) {
      return { removed: 0, retainedJournalized: [] };
    }

    const retainedJournalized: TransactionDocument[] = [];
    const removable: TransactionDocument[] = [];
    for (const doc of allDocs) {
      if (doc.status === TRANSACTION_STATUS.JOURNALIZED) retainedJournalized.push(doc);
      else removable.push(doc);
    }

    let removed = 0;
    for (const doc of removable) {
      await this.delete(doc._id, this.optsFromCtx(ctx));
      removed += 1;
      await this.deps.bridges.ledger?.onTransactionRemovedByFeed?.(
        doc as unknown as Record<string, unknown>,
        ctx,
      );
      await this.dispatch(
        createEvent(
          REVENUE_EVENTS.TRANSACTION_REMOVED_BY_FEED,
          {
            transaction: doc,
            source: opts.source,
            externalId: doc.externalId ?? '',
          },
          ctx,
          { resource: 'transaction', resourceId: doc.publicId },
        ),
        ctx,
      );
    }
    return { removed, retainedJournalized };
  }

  /**
   * Find candidate matches for cross-referencing a payment-flow row to
   * its bank deposit (or vice-versa).
   *
   * Heuristic:
   *   - same currency by default; cross-currency requires `fxRate` on
   *     the candidate row (multi-currency reconciliation).
   *   - amount within `amountTolerancePct` (default 1%) — accounts for
   *     gateway fees / FX rounding.
   *   - posted/created within `toleranceDays` of the target date
   *     (default 3 days — covers ACH delays, weekend settlement).
   *   - terminal verified states only (`verified` / `completed` for
   *     payment_flow, `imported` / `matched` for bank_feed).
   *
   * Returned candidates are unsorted; callers rank by their own
   * confidence model (counterparty fuzzy match, currency identity,
   * exact-amount preference, …).
   */
  async findMatchCandidates(
    filter: {
      amount: number;
      currency?: string;
      postedDate: Date;
      toleranceDays?: number;
      amountTolerancePct?: number;
      counterpartyName?: string;
      kind?: TransactionKindValue;
    },
    ctx: RevenueContext = {},
  ): Promise<TransactionDocument[]> {
    const tolerance = filter.toleranceDays ?? 3;
    const pct = filter.amountTolerancePct ?? 0.01;
    const start = new Date(filter.postedDate.getTime() - tolerance * 86400_000);
    const end = new Date(filter.postedDate.getTime() + tolerance * 86400_000);
    const minAmount = filter.amount * (1 - pct);
    const maxAmount = filter.amount * (1 + pct);

    const targetKind = filter.kind ?? TRANSACTION_KIND.PAYMENT_FLOW;
    const validStatuses =
      targetKind === TRANSACTION_KIND.PAYMENT_FLOW
        ? [TRANSACTION_STATUS.VERIFIED, TRANSACTION_STATUS.COMPLETED]
        : [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED];

    // Settlement-window timestamp depends on kind:
    //   - `bank_feed` rows carry `postedDate` (the bank's settled-on date).
    //   - `payment_flow` rows carry `verifiedAt` (the gateway's confirm-on
    //     timestamp). `postedDate` is never set on payment_flow, and
    //     `createdAt` is "row insertion time" which can be hours-to-days
    //     after the actual charge — too noisy to anchor reconciliation.
    // Falling back to `createdAt` keeps legacy rows (verified before the
    // field existed) match-able, matching how upgraded ledgers usually
    // backfill `verifiedAt = createdAt` on the first migration.
    const dateClauses: Record<string, unknown>[] =
      targetKind === TRANSACTION_KIND.BANK_FEED
        ? [{ postedDate: { $gte: start, $lte: end } }]
        : [
            { verifiedAt: { $gte: start, $lte: end } },
            { createdAt: { $gte: start, $lte: end } },
          ];

    const query: Record<string, unknown> = {
      kind: targetKind,
      status: { $in: validStatuses },
      amount: { $gte: minAmount, $lte: maxAmount },
      $or: dateClauses,
    };
    if (filter.currency !== undefined) query.currency = filter.currency;
    if (filter.counterpartyName !== undefined) {
      query['counterparty.name'] = { $regex: escapeRegex(filter.counterpartyName), $options: 'i' };
    }

    const docs = await this.findAll(query, this.optsFromCtx(ctx, { limit: 50 }));
    return (Array.isArray(docs) ? docs : []) as unknown as TransactionDocument[];
  }

  /**
   * Running balance for a bank account as of `asOf` (defaults to now).
   *
   * Uses mongokit's tenant-scoped read via `findAll` — inflows minus
   * outflows over `kind: 'bank_feed'`, terminal states only. For audit
   * pages where exact-to-the-cent reconciliation is required, prefer
   * the most recent row's `balanceAfter` (banks ship that field on
   * every entry).
   */
  async getRunningBalance(
    bankAccountId: string,
    asOf: Date = new Date(),
    ctx: RevenueContext = {},
  ): Promise<{ balance: number; currency: string | null; rowCount: number; asOf: Date }> {
    const filter: Record<string, unknown> = {
      kind: TRANSACTION_KIND.BANK_FEED,
      bankAccountId,
      postedDate: { $lte: asOf },
      status: { $in: [TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED, TRANSACTION_STATUS.JOURNALIZED] },
    };
    const rows = (await this.findAll(filter, this.optsFromCtx(ctx))) as unknown as TransactionDocument[];

    let balance = 0;
    let currency: string | null = null;
    for (const row of rows) {
      if (currency === null) currency = row.currency;
      balance += row.flow === 'inflow' ? row.amount : -row.amount;
    }
    return { balance, currency, rowCount: rows.length, asOf };
  }
}

/** Escape user-provided strings before embedding in `$regex`. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
