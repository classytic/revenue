/**
 * Unit: refund command-ref stamping + `getRefundStatus` resolution (#5).
 *
 * The engine's reconciliation asks the adapter about a REFUND whose create response was lost.
 * This proves the adapter answers authoritatively and NEVER falls back to the PaymentIntent's
 * own status:
 *   1. refund() stamps a stable, deterministic command ref into the Stripe refund metadata
 *      (and forwards the idempotency key to Stripe).
 *   2. getRefundStatus with a known refundRef → refunds.retrieve → mapped status.
 *   3. getRefundStatus without a refundRef → refunds.list on the intent, matched by the
 *      stamped ref → mapped status.
 *   4. no authoritative match → 'processing' (uncertain → engine RETAINS the reservation),
 *      and the PaymentIntent is NEVER consulted.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PaymentCommandContext } from '@classytic/primitives/payment-gateway';
import {
  refund,
  getRefundStatus,
  refundCommandRef,
  REVENUE_REFUND_CMD_REF,
  type RefundDeps,
} from '../../src/lib/refund.js';

const KEY = 'refund-cmd-42';
const PI = 'pi_test_123';

function command(idempotencyKey = KEY): PaymentCommandContext {
  return { idempotencyKey, requestId: `req-${idempotencyKey}`, merchantReference: PI };
}

/** Minimal fake Stripe surface — only the refund methods the code touches. */
function fakeStripe(overrides: Record<string, unknown> = {}) {
  const paymentIntents = { retrieve: vi.fn() }; // must NEVER be called by getRefundStatus
  const refunds = {
    create: vi.fn(async (params: Record<string, unknown>) => ({
      id: 're_new',
      status: 'succeeded',
      amount: (params.amount as number) ?? 1000,
      currency: 'usd',
      created: 1_700_000_000,
      reason: null,
      metadata: params.metadata,
    })),
    retrieve: vi.fn(),
    list: vi.fn(),
    ...overrides,
  };
  return { stripe: { refunds, paymentIntents } as never, deps: { defaultCurrency: 'USD' } };
}

function deps(stripe: unknown): RefundDeps {
  return { stripe: stripe as never, defaultCurrency: 'USD' };
}

describe('refund() stamps a stable command ref', () => {
  it('writes REVENUE_REFUND_CMD_REF and forwards the idempotency key to Stripe', async () => {
    const { stripe } = fakeStripe();
    await refund(deps(stripe), PI, 1000, command());
    const [params, opts] = (stripe as any).refunds.create.mock.calls[0];
    expect(params.metadata[REVENUE_REFUND_CMD_REF]).toBe(refundCommandRef(KEY));
    expect(opts.idempotencyKey).toBe(KEY);
    // deterministic: same key → same ref
    expect(refundCommandRef(KEY)).toBe(refundCommandRef(KEY));
    expect(refundCommandRef(KEY)).not.toBe(refundCommandRef('other'));
  });
});

describe('getRefundStatus', () => {
  it('retrieves by refundRef when known (authoritative)', async () => {
    const { stripe } = fakeStripe({
      retrieve: vi.fn(async (id: string) => ({ id, status: 'succeeded', amount: 1000, currency: 'usd' })),
    });
    const res = await getRefundStatus(deps(stripe), { paymentId: PI, idempotencyKey: KEY, refundRef: 're_known' });
    expect((stripe as any).refunds.retrieve).toHaveBeenCalledWith('re_known');
    expect(res.status).toBe('succeeded');
    expect(res.id).toBe('re_known');
    expect((stripe as any).paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('lists the intent refunds and matches the stamped ref (failed → failed)', async () => {
    const { stripe } = fakeStripe({
      list: vi.fn(async () => ({
        data: [
          { id: 're_other', status: 'succeeded', amount: 500, currency: 'usd', metadata: { [REVENUE_REFUND_CMD_REF]: 'nope' } },
          { id: 're_ours', status: 'failed', amount: 1000, currency: 'usd', metadata: { [REVENUE_REFUND_CMD_REF]: refundCommandRef(KEY) } },
        ],
      })),
    });
    const res = await getRefundStatus(deps(stripe), { paymentId: PI, idempotencyKey: KEY });
    expect((stripe as any).refunds.list).toHaveBeenCalledWith({ payment_intent: PI, limit: 100 });
    expect(res.id).toBe('re_ours');
    expect(res.status).toBe('failed');
    expect((stripe as any).paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('no match → processing (uncertain, reservation retained), intent never consulted', async () => {
    const { stripe } = fakeStripe({ list: vi.fn(async () => ({ data: [] })) });
    const res = await getRefundStatus(deps(stripe), { paymentId: PI, idempotencyKey: KEY });
    expect(res.status).toBe('processing');
    expect((stripe as any).paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('a canceled refund maps to failed (money did not move → release)', async () => {
    const { stripe } = fakeStripe({
      retrieve: vi.fn(async (id: string) => ({ id, status: 'canceled', amount: 1000, currency: 'usd' })),
    });
    const res = await getRefundStatus(deps(stripe), { paymentId: PI, idempotencyKey: KEY, refundRef: 're_x' });
    expect(res.status).toBe('failed');
  });
});
