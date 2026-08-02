/**
 * `revenue-manual` must not claim a payment succeeded when it cannot know.
 *
 * `getStatus` used to delegate to `verifyPayment`, which returns `succeeded`
 * unconditionally — so the status of a payment that was never created, or was still
 * awaiting approval, read as succeeded. Nothing called it, so the false positive was latent
 * rather than live; the first reconciliation or retry path to consult it would have taken
 * that as confirmation that money had arrived.
 *
 * The provider is stateless: no store, no network call, no record of any intent. For a
 * manual method there is also no external money-movement authority, so the stored
 * transaction IS the authority (payments-architecture.md §1) and the provider's correct
 * move is to say it cannot answer.
 */
import { describe, expect, it } from 'vitest';
import { ProviderStatusUnavailableError } from '@classytic/primitives/payment-gateway';
import { ManualProvider } from '../src/index.js';

describe('ManualProvider.getStatus', () => {
  it('REFUSES to answer rather than guessing succeeded', async () => {
    const provider = new ManualProvider();
    await expect(provider.getStatus('never-created')).rejects.toBeInstanceOf(
      ProviderStatusUnavailableError,
    );
  });

  it('says why, and points at the record as the authority', async () => {
    const provider = new ManualProvider();
    await expect(provider.getStatus('x')).rejects.toThrow(/stored transaction/i);
  });

  it('verifyPayment STILL succeeds — it is only ever called from an approval action', async () => {
    // The distinction that makes the refusal correct rather than a gap: an admin approving
    // is a real fact this provider carries. A passive status query is not.
    const provider = new ManualProvider();
    const result = await provider.verifyPayment('intent-1');
    expect(result.status).toBe('succeeded');
  });
});
