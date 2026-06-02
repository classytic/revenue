/**
 * `reconciled_external` — terminal, non-matchable bank-feed status.
 *
 * Vendor-reconciled rows (Xero Payments + transfer legs) are BORN in this
 * status so they can NEVER be matched/journalized — which would post a second
 * JE on top of the GL the vendor already owns. It must be:
 *   - unreachable from `imported`/`matched` (no flip-after-insert race), and
 *   - terminal (no outbound edges).
 */

import { describe, it, expect } from 'vitest';
import { BANK_FEED_STATE_MACHINE } from '../../revenue/src/core/state-machines.js';
import { TRANSACTION_STATUS } from '../../revenue/src/enums/transaction.enums.js';
import { TRANSACTION_KIND, isStatusValidForKind } from '../../revenue/src/enums/bank-feed.enums.js';

const RX = TRANSACTION_STATUS.RECONCILED_EXTERNAL;

describe('bank-feed: reconciled_external is terminal + non-matchable', () => {
  it('cannot be entered from imported or matched (closes the auto-reconcile race)', () => {
    expect(BANK_FEED_STATE_MACHINE.canTransition(TRANSACTION_STATUS.IMPORTED, RX)).toBe(false);
    expect(BANK_FEED_STATE_MACHINE.canTransition(TRANSACTION_STATUS.MATCHED, RX)).toBe(false);
  });

  it('is terminal — no transition out to matched / journalized / imported', () => {
    expect(BANK_FEED_STATE_MACHINE.canTransition(RX, TRANSACTION_STATUS.MATCHED)).toBe(false);
    expect(BANK_FEED_STATE_MACHINE.canTransition(RX, TRANSACTION_STATUS.JOURNALIZED)).toBe(false);
    expect(BANK_FEED_STATE_MACHINE.canTransition(RX, TRANSACTION_STATUS.IMPORTED)).toBe(false);
  });

  it('is a valid bank_feed status, not a payment_flow status', () => {
    expect(isStatusValidForKind(RX, TRANSACTION_KIND.BANK_FEED)).toBe(true);
    expect(isStatusValidForKind(RX, TRANSACTION_KIND.PAYMENT_FLOW)).toBe(false);
  });

  it('regression: normal imported→matched still allowed', () => {
    expect(
      BANK_FEED_STATE_MACHINE.canTransition(TRANSACTION_STATUS.IMPORTED, TRANSACTION_STATUS.MATCHED),
    ).toBe(true);
  });
});
