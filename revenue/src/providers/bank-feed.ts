/**
 * Bank-feed provider abstraction.
 *
 * Sibling to `PaymentProvider`. Where `PaymentProvider` models the
 * "intent → verify → refund → webhook" gateway lifecycle, `BankFeedProvider`
 * models the "fetch → drain → upload-parse" data-feed lifecycle.
 *
 * The provider does **not** persist anything — it returns canonical rows
 * and (for sync providers) a resumption cursor. Persistence policy
 * (cursor storage, retry strategy, batch size) lives in the host. Revenue's
 * `transactionRepository.import()` is the single entry point that
 * persists the canonical rows under the partial-unique index
 * `(orgId, bankAccountId, externalId)`.
 *
 * This split lets a small package wrap any source (fin-io's parsers,
 * Plaid's SDK, QBO CDC, a custom CSV uploader) and feed revenue
 * uniformly, with hosts choosing which provider for which bank account.
 */

import type { BankFeedSourceValue } from '../enums/bank-feed.enums.js';
import type {
  BankTransaction,
  BankStatement,
} from '@classytic/primitives/bank-transaction';

// No re-exports — consumers import canonical shapes directly from
// `@classytic/primitives/bank-transaction` and `@classytic/primitives/money`.
// Subpath imports keep tree-shaking honest and follow PACKAGE_RULES P2.

// ─── Capabilities ────────────────────────────────────────────────────────

export interface BankFeedProviderCapabilities {
  /** Supports continuous sync (Plaid, QBO CDC, Xero CDC). */
  supportsSync: boolean;
  /** Supports file upload parsing (OFX, CAMT.053, MT940, CSV, IIF). */
  supportsUpload: boolean;
  /** Provider may report retracted entries (Plaid `removed[]`, OFX correction). */
  supportsRemovals: boolean;
  /** Cursor-resumable — `fetchTransactions` returns a `nextCursor`. */
  cursorBased: boolean;
  /** Multi-account in a single sync call. */
  multiAccount: boolean;
}

// ─── Operation params ────────────────────────────────────────────────────

export interface FetchTransactionsParams {
  /** Resumption token from a previous call (Plaid cursor, QBO `LastUpdatedTime`, …). */
  cursor?: string | undefined;
  /** Account scope. May be undefined for providers that fetch all accounts. */
  bankAccountId?: string | undefined;
  /** Optional date floor — supplements cursor-based drains. */
  from?: Date | undefined;
  /** Optional date ceiling. */
  to?: Date | undefined;
  /** Provider-specific knobs. */
  options?: Record<string, unknown> | undefined;
}

export interface FetchTransactionsResult {
  /** Newly added or updated rows. */
  transactions: BankTransaction[];
  /** Vendor-stable IDs of rows the upstream feed has retracted. */
  removed?: Array<{ externalId: string; bankAccountId?: string }>;
  /** Resumption cursor for the next call. */
  nextCursor?: string;
  /** True when more pages are available — driver may stop calling when false. */
  hasMore?: boolean;
  /** Provider raw response for audit. Optional. */
  raw?: unknown;
}

export interface ParseUploadParams {
  /** Raw upload bytes / string. */
  buffer: Buffer | string | Uint8Array;
  /** Format hint — providers MAY auto-detect when absent. */
  format?: BankFeedSourceValue;
  /** Account scope to stamp on every parsed row (when the file omits it). */
  bankAccountId?: string;
  /** Format-specific quirks (e.g. `'chase' | 'boa' | 'lenient'`). */
  options?: Record<string, unknown>;
}

export interface ParseUploadResult {
  /** Statement-level metadata (account, period, balances). */
  statements: BankStatement[];
  /** Flat list of all rows across all statements — convenience for `import()`. */
  transactions: BankTransaction[];
  /** Per-row parse errors that didn't abort the file. */
  warnings: Array<{ line?: number; reason: string }>;
}

// ─── Abstract provider ───────────────────────────────────────────────────

/**
 * Bank-feed provider — implement one method or both depending on the
 * upstream's capabilities. Mirrors the optional-method pattern that
 * works well across PaymentProvider's gateway plurality.
 */
export abstract class BankFeedProvider {
  public readonly config: Record<string, unknown>;
  public readonly name: string;

  constructor(name: string, config: Record<string, unknown> = {}) {
    this.name = name;
    this.config = config;
  }

  /**
   * Fetch a batch of transactions. Cursor-based providers (Plaid)
   * return `nextCursor` for the next call; date-range providers
   * (older QBO Reports API) ignore cursor and use `from` / `to`.
   * Throws if the provider does not support sync.
   */
  fetchTransactions?(_params: FetchTransactionsParams): Promise<FetchTransactionsResult>;

  /**
   * Parse a file upload (OFX / CAMT.053 / MT940 / CSV / IIF). The
   * canonical implementation delegates to `@classytic/fin-io`. Throws
   * if the provider does not support uploads.
   */
  parseUpload?(_params: ParseUploadParams): Promise<ParseUploadResult>;

  /**
   * Async drain — yields one batch per call until the upstream is
   * caught up. Default implementation pulls `fetchTransactions` in a
   * loop; providers can override for more efficient pagination
   * (e.g. SSE / long-poll) or to interleave `removed[]` correctly.
   */
  async *drain(
    params: FetchTransactionsParams = {},
  ): AsyncGenerator<FetchTransactionsResult> {
    if (!this.fetchTransactions) {
      throw new Error(`Provider ${this.name} does not support fetchTransactions()`);
    }
    let cursor = params.cursor;
    // Bound infinite-loop pathological cases at 10k pages — providers in
    // practice converge in < 50; this is a safety net, not a limit.
    const MAX_PAGES = 10_000;
    for (let i = 0; i < MAX_PAGES; i++) {
      const result = await this.fetchTransactions({ ...params, cursor });
      yield result;
      const tooLittle = result.transactions.length === 0 && (result.removed?.length ?? 0) === 0;
      if (result.hasMore === false || tooLittle) return;
      if (!result.nextCursor || result.nextCursor === cursor) return;
      cursor = result.nextCursor;
    }
  }

  abstract getCapabilities(): BankFeedProviderCapabilities;
}

// ─── Registry ────────────────────────────────────────────────────────────

import { ProviderNotFoundError } from '../core/errors.js';

export class BankFeedProviderRegistry {
  private providers = new Map<string, BankFeedProvider>();

  register(name: string, provider: BankFeedProvider): void {
    this.providers.set(name, provider);
  }

  get(name: string): BankFeedProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new ProviderNotFoundError(name);
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}

export function createBankFeedProviderRegistry(
  providers: Record<string, BankFeedProvider> = {},
): BankFeedProviderRegistry {
  const registry = new BankFeedProviderRegistry();
  for (const [name, provider] of Object.entries(providers)) {
    registry.register(name, provider);
  }
  return registry;
}
