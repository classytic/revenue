/**
 * The outcome classifier — the safety property of the whole payment design.
 *
 * A provider call that throws tells us nothing about whether money moved. Classifying such
 * an error as `declined` licences a retry, and if the first attempt had already captured,
 * that retry double-charges. So the classifier is conservative BY CONSTRUCTION: only an
 * explicit, provider-declared decision counts as `declined`; everything else is `unknown`.
 *
 * The asymmetry is deliberate. Calling a real decline `unknown` merely triggers a
 * reconciliation that finds nothing. The reverse takes money twice.
 */
import { describe, expect, it } from 'vitest';
import { executeProviderCommand } from '../src/providers/execute-command.js';
import { ProviderStatusUnavailableError } from '@classytic/primitives/payment-gateway';

const decline = {
  reason: 'card_declined' as const,
  providerCode: 'do_not_honor',
  retryable: false,
};

describe('executeProviderCommand', () => {
  it('confirms a successful call', async () => {
    const r = await executeProviderCommand(async () => ({ id: 'pi_1' }));
    expect(r).toEqual({ outcome: 'confirmed', value: { id: 'pi_1' } });
  });

  it('reports DECLINED only when the provider attached an explicit decision', async () => {
    const r = await executeProviderCommand(async () => {
      throw Object.assign(new Error('card declined'), { decline });
    });
    expect(r.outcome).toBe('declined');
    if (r.outcome === 'declined') expect(r.error.reason).toBe('card_declined');
  });

  it('a TIMEOUT is unknown, NOT declined — the capture may have succeeded', async () => {
    const r = await executeProviderCommand(async () => {
      throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
    });
    expect(r.outcome).toBe('unknown');
  });

  it('an ABORT is unknown', async () => {
    const r = await executeProviderCommand(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    expect(r.outcome).toBe('unknown');
  });

  it('a socket reset is unknown', async () => {
    const r = await executeProviderCommand(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    });
    expect(r.outcome).toBe('unknown');
  });

  it('an UNRECOGNISED error defaults to unknown — never declined', async () => {
    /**
     * The branch that matters most. A programming error or an unmapped vendor exception
     * says nothing about whether funds moved, and defaulting it to `declined` would licence
     * a retry. An adapter that knows better must attach a `decline`.
     */
    const r = await executeProviderCommand(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    });
    expect(r.outcome).toBe('unknown');
  });

  it('carries a providerReference through an unknown, so status can be reconciled', async () => {
    const r = await executeProviderCommand(
      async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      },
      { providerReference: 'pi_abc' },
    );
    expect(r).toMatchObject({ outcome: 'unknown', providerReference: 'pi_abc' });
  });

  it('classifies ProviderStatusUnavailableError as unknown', async () => {
    // A stateless provider saying "I hold no record of this" — the honest answer, and the
    // reason `unknown` exists beyond network faults.
    const r = await executeProviderCommand(async () => {
      throw new ProviderStatusUnavailableError('manual');
    });
    expect(r.outcome).toBe('unknown');
  });
});
