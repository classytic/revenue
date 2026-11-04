/**
 * Scenario: refunds issued OUTSIDE the engine (gateway dashboard / API).
 *
 * A hosted checkout is verified by its SESSION, but refunds only name the PAYMENT.
 * The engine must link the two at verify, then record any refund the gateway reports
 * through the same reserve→finalize path as `refund()`:
 *
 *   - verify stores the gateway's payment id the provider reports;
 *   - a dashboard refund (no command ref) is recorded once — one refund child, one
 *     `payment.refunded`, the original flipped partially_refunded / refunded;
 *   - the same refund delivered twice (`refund.created` + `refund.updated`) records once;
 *   - a refund the engine issued itself (command ref present) is never recorded twice;
 *   - a refund larger than what remains is refused, not recorded.
 */
import type { CurrencyCode } from '@classytic/primitives/currency';
import { currencyCode } from '@classytic/primitives/currency';
import type {
  CreateIntentParams,
  PaymentResult,
  ProviderIntent,
  ProviderRefundSignal,
  RefundResult,
  WebhookEvent,
} from '@classytic/primitives/payment-gateway';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DomainEvent, PaymentProvider } from '../../revenue/src/index.js';
import { bindRevenue } from '../helpers/bind-revenue.js';
import { clearCollections, connectToMongoDB, disconnectFromMongoDB } from '../helpers/mongodb-memory.js';
import { warmModels } from '../helpers/warm-models.js';

const TIMEOUT = 20000;
const AMOUNT = 10_000;

/** Hosted checkout: intents are SESSIONS; the payment id appears only once paid. */
class HostedCheckoutProvider extends PaymentProvider {
  public override readonly name = 'hosted';
  private sessions = new Map<string, { amount: number; currency: CurrencyCode; pi: string }>();
  private seq = 0;

  constructor() {
    super({});
  }

  verifyWebhookSignature(): boolean {
    return true; // a test double has no signature to check — said explicitly
  }

  async createIntent(params: CreateIntentParams): Promise<ProviderIntent> {
    const id = `cs_${++this.seq}`;
    const amount = params.amount.amount;
    const currency = params.amount.currency ?? currencyCode('USD');
    this.sessions.set(id, { amount, currency, pi: `pi_${this.seq}` });
    // Like Stripe Checkout: no PaymentIntent exists at creation.
    return { id, sessionId: id, paymentIntentId: null, provider: 'hosted', status: 'requires_action', amount: { amount, currency }, metadata: {} };
  }

  async verifyPayment(sessionId: string): Promise<PaymentResult> {
    const s = this.sessions.get(sessionId);
    return {
      id: sessionId,
      provider: 'hosted',
      status: s ? 'succeeded' : 'failed',
      ...(s ? { amount: { amount: s.amount, currency: s.currency }, paymentIntentId: s.pi } : {}),
      metadata: {},
    };
  }

  async getStatus(id: string): Promise<PaymentResult> {
    return this.verifyPayment(id);
  }

  async refund(paymentId: string, amount?: number | null): Promise<RefundResult> {
    return { id: `re_engine_${paymentId}`, provider: 'hosted', status: 'succeeded', amount: { amount: amount ?? 0, currency: currencyCode('USD') }, refundedAt: new Date(), metadata: {} };
  }

  async handleWebhook(payload: unknown): Promise<WebhookEvent> {
    const p = payload as { id: string; type: string; sessionId?: string; paymentIntentId?: string; refund?: ProviderRefundSignal };
    return {
      id: p.id,
      provider: 'hosted',
      type: p.type,
      data: {
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.paymentIntentId ? { paymentIntentId: p.paymentIntentId } : {}),
        ...(p.refund ? { refund: p.refund } : {}),
      },
      createdAt: new Date(),
    };
  }
}

let mongoAvailable = false;
beforeAll(async () => {
  mongoAvailable = await connectToMongoDB();
}, TIMEOUT);
afterAll(async () => {
  await disconnectFromMongoDB();
});
beforeEach(async () => {
  if (mongoAvailable) await clearCollections();
});

async function world() {
  const published: DomainEvent[] = [];
  const engine = await bindRevenue({
    connection: mongoose.connection,
    defaultCurrency: 'USD',
    providers: { hosted: new HostedCheckoutProvider() },
    scope: false,
    forceRecreate: true,
    eventTransport: {
      name: 'test',
      async publish(e) {
        published.push(e);
      },
      async subscribe() {
        return () => {};
      },
    },
  });
  await warmModels(engine);
  const tx = engine.repositories.transaction;

  // Customer pays through hosted checkout; the webhook verifies by SESSION.
  const created = await tx.createPaymentIntent({ amount: AMOUNT, gateway: 'hosted', methodKind: 'card', idempotencyKey: 'order-1' });
  const sessionId = created.gateway!.sessionId as string;
  const paid = await tx.handleWebhook('hosted', { id: 'evt_paid', type: 'checkout.session.completed', sessionId });

  const deliver = (id: string, refund: ProviderRefundSignal, paymentIntentId = 'pi_1') =>
    tx.handleWebhook('hosted', { id, type: 'refund.updated', paymentIntentId, refund });
  const refunds = async () => (await tx.getAll({ filters: { type: 'refund' } }, {})).data;
  const original = () => tx.getById(String(created._id), {});
  const refundedEvents = () => published.filter((e) => e.type === 'payment.refunded');
  return { engine, tx, paid, deliver, refunds, original, refundedEvents, created };
}

describe('Scenario: refunds issued outside the engine', () => {
  it('verify links the payment id that later refunds are routed by', async () => {
    if (!mongoAvailable) return;
    const w = await world();
    try {
      expect(w.paid?.status).toBe('verified');
      expect(w.paid?.gateway?.paymentIntentId).toBe('pi_1');
    } finally {
      await w.engine.close();
    }
  }, TIMEOUT);

  it('a dashboard refund is recorded once — refund child, status, event', async () => {
    if (!mongoAvailable) return;
    const w = await w0();
    try {
      await w.deliver('evt_r1', { id: 're_dash_1', amount: AMOUNT });
      const original = (await w.original()) as { status: string; refundedAmount?: number };
      expect(original.status).toBe('refunded');
      expect(original.refundedAmount).toBe(AMOUNT);
      expect(await w.refunds()).toHaveLength(1);
      expect(w.refundedEvents()).toHaveLength(1);
    } finally {
      await w.engine.close();
    }
  }, TIMEOUT);

  it('the same refund delivered twice (created + updated) records once', async () => {
    if (!mongoAvailable) return;
    const w = await w0();
    try {
      await w.deliver('evt_created', { id: 're_dash_2', amount: 4_000 });
      await w.deliver('evt_updated', { id: 're_dash_2', amount: 4_000 });
      const original = (await w.original()) as { status: string; refundedAmount?: number };
      expect(original.refundedAmount).toBe(4_000);
      expect(original.status).toBe('partially_refunded');
      expect(await w.refunds()).toHaveLength(1);
      expect(w.refundedEvents()).toHaveLength(1);
    } finally {
      await w.engine.close();
    }
  }, TIMEOUT);

  it('two partial dashboard refunds add up to refunded', async () => {
    if (!mongoAvailable) return;
    const w = await w0();
    try {
      await w.deliver('evt_a', { id: 're_a', amount: 3_000 });
      await w.deliver('evt_b', { id: 're_b', amount: 7_000 });
      const original = (await w.original()) as { status: string; refundedAmount?: number };
      expect(original.refundedAmount).toBe(AMOUNT);
      expect(original.status).toBe('refunded');
      expect(await w.refunds()).toHaveLength(2);
    } finally {
      await w.engine.close();
    }
  }, TIMEOUT);

  it("a refund the engine issued itself is never recorded a second time", async () => {
    if (!mongoAvailable) return;
    const w = await w0();
    try {
      await w.tx.refund(String(w.created._id), 5_000, { idempotencyKey: 'support-refund-1' });
      // Stripe then reports that same refund, carrying our command ref.
      await w.deliver('evt_ours', { id: 're_engine_x', amount: 5_000, commandRef: 'ref-of-support-refund-1' });
      const original = (await w.original()) as { refundedAmount?: number };
      expect(original.refundedAmount).toBe(5_000);
      expect(await w.refunds()).toHaveLength(1);
      expect(w.refundedEvents()).toHaveLength(1);
    } finally {
      await w.engine.close();
    }
  }, TIMEOUT);

  it('a refund larger than what remains is refused, not recorded', async () => {
    if (!mongoAvailable) return;
    const w = await w0();
    try {
      await w.deliver('evt_part', { id: 're_p', amount: 8_000 });
      await w.deliver('evt_over', { id: 're_over', amount: 5_000 });
      const original = (await w.original()) as { refundedAmount?: number; pendingRefundAmount?: number };
      expect(original.refundedAmount).toBe(8_000);
      expect(original.pendingRefundAmount ?? 0).toBe(0); // no reservation leaked
      expect(await w.refunds()).toHaveLength(1);
    } finally {
      await w.engine.close();
    }
  }, TIMEOUT);
});

/** The paid world every refund case starts from. */
async function w0() {
  const w = await world();
  expect(w.paid?.status).toBe('verified');
  return w;
}
