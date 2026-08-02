/**
 * The command envelope reaching the adapter — and being STABLE across retries.
 *
 * The envelope existed as a type for a while without being threaded anywhere: the port
 * declared idempotency, the engine never sent it, and the adapters never forwarded it. Types
 * without a call site are documentation, not a guarantee, so these pin the wiring.
 */
import { describe, expect, it } from 'vitest';
import { buildPaymentCommandContext } from '../src/providers/command-context.js';

describe('buildPaymentCommandContext', () => {
  it('uses the CALLER key when supplied — the caller knows which retries are the same', () => {
    const ctx = buildPaymentCommandContext({
      operation: 'refund',
      subjectId: 'txn-1',
      organizationId: 'org-1',
      idempotencyKey: 'caller-key',
    });
    expect(ctx.idempotencyKey).toBe('caller-key');
  });

  it('DERIVES a stable key when none is supplied — never a random one', async () => {
    /**
     * The property that matters. A random fallback makes every retry look like a NEW
     * operation to the gateway, defeating the deduplication the field exists for while
     * appearing correctly wired — worse than sending no key at all.
     */
    const a = buildPaymentCommandContext({
      operation: 'refund',
      subjectId: 'txn-1',
      organizationId: 'org-1',
    });
    await new Promise((r) => setTimeout(r, 5));
    const b = buildPaymentCommandContext({
      operation: 'refund',
      subjectId: 'txn-1',
      organizationId: 'org-1',
    });

    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it('separates different operations on the SAME subject', () => {
    // A refund and a create against one transaction are different logical operations and
    // must not collide on one key.
    const refund = buildPaymentCommandContext({
      operation: 'refund',
      subjectId: 'txn-1',
      organizationId: 'org-1',
    });
    const create = buildPaymentCommandContext({
      operation: 'create-intent',
      subjectId: 'txn-1',
      organizationId: 'org-1',
    });

    expect(refund.idempotencyKey).not.toBe(create.idempotencyKey);
  });

  it('gives each attempt a DISTINCT requestId — correlation, not deduplication', () => {
    // requestId must vary even when the idempotency key does not: it identifies the attempt,
    // which is what makes an `unknown` outcome reconcilable against the provider's logs.
    const a = buildPaymentCommandContext({ operation: 'refund', subjectId: 't', organizationId: 'o' });
    const b = buildPaymentCommandContext({ operation: 'refund', subjectId: 't', organizationId: 'o' });

    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.requestId).not.toBe(b.requestId);
  });

  it('carries organization scope and a merchant reference', () => {
    const ctx = buildPaymentCommandContext({
      operation: 'refund',
      subjectId: 'txn-9',
      organizationId: 'org-7',
      merchantReference: 'ORD-2026-0001',
    });
    expect(ctx.organizationId).toBe('org-7');
    expect(ctx.merchantReference).toBe('ORD-2026-0001');
  });

  it('falls back to the subject as the merchant reference', () => {
    const ctx = buildPaymentCommandContext({
      operation: 'refund',
      subjectId: 'txn-9',
      organizationId: 'org-7',
    });
    expect(ctx.merchantReference).toBe('txn-9');
  });
});
