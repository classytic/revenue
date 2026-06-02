/**
 * Bank-feed enums + status×kind validity matrix.
 *
 * The compile-time guard in `bank-feed.enums.ts` (`as const satisfies
 * readonly string[]`) catches drift inside the package; this suite
 * pins the runtime contract that hosts depend on at API boundaries.
 */
import { describe, it, expect } from 'vitest';
import {
  BANK_FEED_SOURCE,
  BANK_FEED_SOURCE_VALUES,
  BANK_FEED_STATUS,
  initialStatusFor,
  isBankFeedSource,
  isBankFeedStatus,
  isStatusValidForKind,
  isTransactionKind,
  statusesForKind,
  TRANSACTION_KIND,
  TRANSACTION_KIND_VALUES,
  TRANSACTION_STATUS,
} from '@classytic/revenue/enums';

describe('TRANSACTION_KIND', () => {
  it('exposes payment_flow / bank_feed / manual values', () => {
    expect(TRANSACTION_KIND_VALUES).toEqual([
      TRANSACTION_KIND.PAYMENT_FLOW,
      TRANSACTION_KIND.BANK_FEED,
      TRANSACTION_KIND.MANUAL,
    ]);
  });

  it('isTransactionKind narrows correctly', () => {
    expect(isTransactionKind('payment_flow')).toBe(true);
    expect(isTransactionKind('bank_feed')).toBe(true);
    expect(isTransactionKind('manual')).toBe(true);
    expect(isTransactionKind('garbage')).toBe(false);
    expect(isTransactionKind(undefined)).toBe(false);
  });
});

describe('BANK_FEED_SOURCE', () => {
  it('covers every supported feed format', () => {
    expect(BANK_FEED_SOURCE_VALUES).toEqual([
      BANK_FEED_SOURCE.OFX,
      BANK_FEED_SOURCE.CAMT053,
      BANK_FEED_SOURCE.MT940,
      BANK_FEED_SOURCE.CSV,
      BANK_FEED_SOURCE.IIF,
      BANK_FEED_SOURCE.QBO,
      BANK_FEED_SOURCE.XERO,
      BANK_FEED_SOURCE.PLAID,
      BANK_FEED_SOURCE.MANUAL,
    ]);
  });

  it('isBankFeedSource narrows correctly', () => {
    expect(isBankFeedSource('plaid')).toBe(true);
    expect(isBankFeedSource('camt.053')).toBe(true);
    expect(isBankFeedSource('mt5')).toBe(false);
  });
});

describe('initialStatusFor', () => {
  it('payment_flow → pending', () => {
    expect(initialStatusFor(TRANSACTION_KIND.PAYMENT_FLOW)).toBe(TRANSACTION_STATUS.PENDING);
  });
  it('bank_feed → imported', () => {
    expect(initialStatusFor(TRANSACTION_KIND.BANK_FEED)).toBe(TRANSACTION_STATUS.IMPORTED);
  });
  it('manual → pending', () => {
    expect(initialStatusFor(TRANSACTION_KIND.MANUAL)).toBe(TRANSACTION_STATUS.PENDING);
  });
});

describe('isBankFeedStatus', () => {
  it('accepts the four bank-feed statuses', () => {
    expect(isBankFeedStatus(BANK_FEED_STATUS.IMPORTED)).toBe(true);
    expect(isBankFeedStatus(BANK_FEED_STATUS.MATCHED)).toBe(true);
    expect(isBankFeedStatus(BANK_FEED_STATUS.JOURNALIZED)).toBe(true);
    expect(isBankFeedStatus(BANK_FEED_STATUS.REJECTED)).toBe(true);
  });
  it('rejects payment-flow statuses', () => {
    expect(isBankFeedStatus('pending')).toBe(false);
    expect(isBankFeedStatus('verified')).toBe(false);
  });
});

describe('isStatusValidForKind — kind-aware status guard', () => {
  it('payment_flow accepts every payment-lifecycle status', () => {
    for (const s of [
      'pending',
      'payment_initiated',
      'processing',
      'requires_action',
      'verified',
      'completed',
      'failed',
      'cancelled',
      'expired',
      'refunded',
      'partially_refunded',
    ]) {
      expect(isStatusValidForKind(s, TRANSACTION_KIND.PAYMENT_FLOW)).toBe(true);
    }
  });

  it('payment_flow rejects bank-feed-only statuses', () => {
    expect(isStatusValidForKind('imported', TRANSACTION_KIND.PAYMENT_FLOW)).toBe(false);
    expect(isStatusValidForKind('journalized', TRANSACTION_KIND.PAYMENT_FLOW)).toBe(false);
  });

  it('bank_feed accepts only its four statuses', () => {
    for (const s of ['imported', 'matched', 'journalized', 'rejected']) {
      expect(isStatusValidForKind(s, TRANSACTION_KIND.BANK_FEED)).toBe(true);
    }
    expect(isStatusValidForKind('verified', TRANSACTION_KIND.BANK_FEED)).toBe(false);
    expect(isStatusValidForKind('refunded', TRANSACTION_KIND.BANK_FEED)).toBe(false);
    // Even though 'pending' is a valid TRANSACTION_STATUS, it's not legal for bank_feed.
    expect(isStatusValidForKind('pending', TRANSACTION_KIND.BANK_FEED)).toBe(false);
  });

  it('manual accepts pending / matched / journalized / rejected', () => {
    for (const s of ['pending', 'matched', 'journalized', 'rejected']) {
      expect(isStatusValidForKind(s, TRANSACTION_KIND.MANUAL)).toBe(true);
    }
    expect(isStatusValidForKind('imported', TRANSACTION_KIND.MANUAL)).toBe(false);
    expect(isStatusValidForKind('verified', TRANSACTION_KIND.MANUAL)).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isStatusValidForKind(undefined, TRANSACTION_KIND.PAYMENT_FLOW)).toBe(false);
    expect(isStatusValidForKind(null, TRANSACTION_KIND.PAYMENT_FLOW)).toBe(false);
    expect(isStatusValidForKind(42, TRANSACTION_KIND.PAYMENT_FLOW)).toBe(false);
  });
});

describe('statusesForKind — UI dropdown helper', () => {
  it('returns 11 payment-flow statuses', () => {
    expect(statusesForKind(TRANSACTION_KIND.PAYMENT_FLOW)).toHaveLength(11);
  });
  it('returns 5 bank-feed statuses', () => {
    expect(statusesForKind(TRANSACTION_KIND.BANK_FEED)).toEqual([
      'imported',
      'matched',
      'journalized',
      'rejected',
      'reconciled_external',
    ]);
  });
  it('returns 4 manual statuses', () => {
    expect(statusesForKind(TRANSACTION_KIND.MANUAL)).toEqual([
      'pending',
      'matched',
      'journalized',
      'rejected',
    ]);
  });
});
