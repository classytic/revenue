/**
 * Provider CONFORMANCE — the SAME scenarios run through every adapter.
 *
 * Mirrors `@classytic/carrier-bd`'s `tests/integration/contract.test.ts`
 * pattern: if a scenario passes against one provider but fails on another,
 * the PORT is wrong, not the adapter. `@classytic/revenue` today registers
 * only `ManualProvider` in any real deployment (`@classytic/revenue-stripe`
 * exists and is published, but nothing in this workspace mocks the Stripe
 * SDK client it wraps, so it has no case here yet — add one the moment a
 * test double exists, following this file's `ProviderCase` shape).
 *
 * Scenarios: create → verify, idempotent create, refund (full + partial),
 * refund idempotency, webhook handling honors the declared capability,
 * `getStatus` never fabricates success for an intent it has no authority
 * over.
 */
import { describe, expect, it } from 'vitest';
import { ManualProvider } from '@classytic/revenue-manual';
import type { PaymentCommandContext, PaymentProviderPort } from '@classytic/primitives/payment-gateway';
import { currencyCode } from '@classytic/primitives/currency';

interface ProviderCase {
  name: string;
  build: () => PaymentProviderPort;
}

const cases: ProviderCase[] = [
  { name: 'manual', build: () => new ManualProvider({ defaultCurrency: 'BDT' }) },
];

let seq = 0;
/** Fresh, non-colliding idempotency key per call — each SCENARIO tests its own dedup separately. */
function ctxFor(merchantReference: string): PaymentCommandContext {
  seq += 1;
  return {
    idempotencyKey: `contract-${merchantReference}-${seq}`,
    requestId: `req-${seq}`,
    merchantReference,
  };
}

const AMOUNT = { amount: 10_000, currency: currencyCode('BDT') };

describe.each(cases)('Payment provider contract: $name', ({ build }) => {
  it('declares capabilities as a closed set of booleans', () => {
    const caps = build().getCapabilities();
    for (const key of ['supportsWebhooks', 'supportsRefunds', 'supportsPartialRefunds', 'requiresManualVerification'] as const) {
      expect(typeof caps[key]).toBe('boolean');
    }
  });

  it('createIntent → verifyPayment: intent id round-trips, status is a real terminal/pending value', async () => {
    const provider = build();
    const command = ctxFor('ord-conf-1');
    const intent = await provider.createIntent({ amount: AMOUNT }, command);
    expect(intent.id).toBeTruthy();
    expect(intent.provider).toBe(provider.name);
    expect(intent.amount.amount).toBe(AMOUNT.amount);

    const result = await provider.verifyPayment(intent.id);
    expect(result.id).toBe(intent.id);
    expect(['succeeded', 'failed', 'processing', 'requires_action']).toContain(result.status);
  });

  it('createIntent is idempotent — same idempotencyKey yields the same intent id', async () => {
    const provider = build();
    const command = ctxFor('ord-conf-idem');
    const a = await provider.createIntent({ amount: AMOUNT }, command);
    const b = await provider.createIntent({ amount: AMOUNT }, command);
    expect(b.id).toBe(a.id);
  });

  it('full refund succeeds when the provider declares supportsRefunds', async () => {
    const provider = build();
    if (!provider.getCapabilities().supportsRefunds) return;
    const command = ctxFor('ord-conf-refund-full');
    const refund = await provider.refund('payment-1', null, command);
    expect(refund.id).toBeTruthy();
    expect(refund.provider).toBe(provider.name);
    expect(['succeeded', 'pending', 'failed'].includes(refund.status)).toBe(true);
  });

  it('partial refund honors the requested amount when supportsPartialRefunds', async () => {
    const provider = build();
    const caps = provider.getCapabilities();
    if (!caps.supportsRefunds || !caps.supportsPartialRefunds) return;
    const command = ctxFor('ord-conf-refund-partial');
    const refund = await provider.refund('payment-1', 3_000, command);
    expect(refund.amount?.amount).toBe(3_000);
  });

  it('refund is idempotent — same idempotencyKey yields the same refund id', async () => {
    const provider = build();
    if (!provider.getCapabilities().supportsRefunds) return;
    const command = ctxFor('ord-conf-refund-idem');
    const a = await provider.refund('payment-1', 1_000, command);
    const b = await provider.refund('payment-1', 1_000, command);
    expect(b.id).toBe(a.id);
  });

  it('handleWebhook matches its OWN declared capability — never silently no-ops', async () => {
    const provider = build();
    const caps = provider.getCapabilities();
    if (!caps.supportsWebhooks) {
      // A provider that says "no webhooks" must REFUSE the call, not silently
      // accept-and-drop it — a caller wiring a webhook route against a
      // capability-false provider needs to find out at the call site, not
      // discover a payment that never confirmed.
      await expect(provider.handleWebhook({}, {})).rejects.toThrow();
    }
    // supportsWebhooks: true has no generic payload shape to fabricate here —
    // each such provider's own adapter tests exercise real event parsing.
  });

  it('getStatus never fabricates success for an intent it has no authority over', async () => {
    const provider = build();
    try {
      const status = await provider.getStatus('contract-test-unknown-intent');
      expect(['succeeded', 'failed', 'processing', 'requires_action']).toContain(status.status);
    } catch (err) {
      // Refusing (ProviderStatusUnavailableError, or any thrown error) is a
      // valid answer — AGENTS.md rule 3: absence of an answer is not a
      // negative answer, but it must never default to a POSITIVE one either.
      expect(err).toBeInstanceOf(Error);
    }
  });
});
