/**
 * Full revenue event catalog — unit tests.
 *
 * Asserts:
 *   - Every `REVENUE_EVENTS.*` constant has a matching `RevenueEventDefinition`
 *     (no-drift invariant — adding a constant without a schema fails CI).
 *   - Each definition is structurally compatible with Arc's EventRegistry
 *     (register → catalog → validate round-trip).
 *   - Zod schemas accept valid payloads and reject malformed ones.
 *   - `z.toJSONSchema()` produces a usable JSON Schema on each event.
 *
 * See PACKAGE_RULES §18.5 for the pattern.
 */
import { describe, it, expect } from 'vitest';
import {
  revenueEventDefinitions,
  PaymentVerified,
  PaymentRefunded,
  MonetizationCreated,
  SubscriptionActivated,
  SubscriptionRenewed,
  SubscriptionCancelled,
  EscrowHeld,
  EscrowReleased,
  EscrowSplit,
  SettlementScheduled,
  SettlementFailed,
  WebhookProcessed,
} from '../../src/events/revenue-event-catalog.js';
import { REVENUE_EVENTS } from '../../src/events/event-constants.js';

describe('revenueEventDefinitions', () => {
  it('covers every REVENUE_EVENTS constant (no-drift invariant)', () => {
    const defined = new Set(revenueEventDefinitions.map((d) => d.name));
    const declared = Object.values(REVENUE_EVENTS);
    const missing = declared.filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('has no duplicate event names', () => {
    const names = revenueEventDefinitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('each definition has name, version, schema, zodSchema, create()', () => {
    for (const def of revenueEventDefinitions) {
      expect(typeof def.name).toBe('string');
      expect(def.version).toBeGreaterThanOrEqual(1);
      expect(def.schema).toBeTruthy();
      expect(def.schema.type).toBe('object');
      expect(def.zodSchema).toBeTruthy();
      expect(typeof def.create).toBe('function');
    }
  });

  it('every definition produces a non-empty JSON Schema via z.toJSONSchema()', () => {
    for (const def of revenueEventDefinitions) {
      expect(def.schema.type).toBe('object');
      expect(def.schema.properties).toBeTruthy();
    }
  });
});

describe('Zod schemas — happy paths', () => {
  it('PaymentVerified accepts a minimal transaction payload', () => {
    const r = PaymentVerified.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', status: 'verified', methodKind: 'card' },
      verifiedBy: 'user_1',
    });
    expect(r.success).toBe(true);
  });

  it('PaymentVerified accepts new 0.8.0 kinds (mobile_money, bnpl)', () => {
    for (const methodKind of ['mobile_money', 'bnpl', 'direct_debit', 'instant_bank_transfer', 'gift_card'] as const) {
      const r = PaymentVerified.zodSchema.safeParse({
        transaction: { publicId: `txn_${methodKind}`, status: 'verified', methodKind },
        verifiedBy: 'user_1',
      });
      expect(r.success, `methodKind=${methodKind}`).toBe(true);
    }
  });

  it('PaymentRefunded requires refundAmount as money + isPartialRefund boolean', () => {
    const r = PaymentRefunded.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', methodKind: 'card' },
      refundTransaction: { publicId: 'txn_refund_1', methodKind: 'card' },
      refundAmount: { amount: 500, currency: 'USD' },
      originalAmount: { amount: 1000, currency: 'USD' },
      isPartialRefund: true,
      reason: 'customer request',
    });
    expect(r.success).toBe(true);
  });

  it('MonetizationCreated requires monetizationType + transaction', () => {
    const r = MonetizationCreated.zodSchema.safeParse({
      monetizationType: 'purchase',
      transaction: { publicId: 'txn_1', methodKind: 'card' },
    });
    expect(r.success).toBe(true);
  });

  it('SubscriptionActivated requires activatedAt as ISO datetime', () => {
    const r = SubscriptionActivated.zodSchema.safeParse({
      subscription: { publicId: 'sub_1', status: 'active' },
      activatedAt: '2026-05-05T10:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('SubscriptionRenewed accepts optional nextPeriod fields', () => {
    expect(
      SubscriptionRenewed.zodSchema.safeParse({
        subscription: { publicId: 'sub_1' },
        renewedAt: '2026-05-05T10:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      SubscriptionRenewed.zodSchema.safeParse({
        subscription: { publicId: 'sub_1' },
        renewedAt: '2026-05-05T10:00:00.000Z',
        nextPeriodStart: '2026-06-05T10:00:00.000Z',
        nextPeriodEnd: '2026-07-05T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('SubscriptionCancelled accepts optional immediate + reason', () => {
    const r = SubscriptionCancelled.zodSchema.safeParse({
      subscription: { publicId: 'sub_1' },
      immediate: true,
      reason: 'customer_request',
    });
    expect(r.success).toBe(true);
  });

  it('EscrowHeld requires heldAmount money', () => {
    const r = EscrowHeld.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', methodKind: 'card' },
      heldAmount: { amount: 10000, currency: 'USD' },
      reason: 'marketplace_hold',
    });
    expect(r.success).toBe(true);
  });

  it('EscrowReleased requires isFullRelease + isPartialRelease booleans', () => {
    const r = EscrowReleased.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', methodKind: 'card' },
      releaseAmount: { amount: 5000, currency: 'USD' },
      recipientId: 'seller_1',
      recipientType: 'seller',
      isFullRelease: false,
      isPartialRelease: true,
    });
    expect(r.success).toBe(true);
  });

  it('EscrowSplit validates splits array with recipient + amount', () => {
    const r = EscrowSplit.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', methodKind: 'card' },
      splits: [
        { recipientId: 'seller_1', amount: { amount: 7000, currency: 'USD' } },
        { recipientId: 'platform', amount: { amount: 3000, currency: 'USD' }, recipientType: 'platform' },
      ],
      organizationPayout: { amount: 3000, currency: 'USD' },
    });
    expect(r.success).toBe(true);
  });

  it('SettlementScheduled requires scheduledAt ISO datetime', () => {
    const r = SettlementScheduled.zodSchema.safeParse({
      settlement: { publicId: 'stl_1', status: 'scheduled' },
      scheduledAt: '2026-05-10T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('SettlementFailed requires reason', () => {
    const r = SettlementFailed.zodSchema.safeParse({
      settlement: { publicId: 'stl_1' },
      reason: 'insufficient_funds',
      code: 'BANK_NSF',
      retry: true,
    });
    expect(r.success).toBe(true);
  });

  it('WebhookProcessed carries provider + event body', () => {
    const r = WebhookProcessed.zodSchema.safeParse({
      webhookType: 'payment.verified',
      provider: 'stripe',
      event: { id: 'evt_1', object: 'event' },
    });
    expect(r.success).toBe(true);
  });
});

describe('Zod schemas — rejection paths', () => {
  it('PaymentRefunded rejects missing refundAmount', () => {
    const r = PaymentRefunded.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', methodKind: 'card' },
      refundTransaction: { publicId: 'txn_refund_1', methodKind: 'card' },
      isPartialRefund: false,
    });
    expect(r.success).toBe(false);
  });

  it('EscrowHeld rejects 2-char currency', () => {
    const r = EscrowHeld.zodSchema.safeParse({
      transaction: { publicId: 'txn_1', methodKind: 'card' },
      heldAmount: { amount: 1000, currency: 'US' },
    });
    expect(r.success).toBe(false);
  });

  it('SubscriptionActivated rejects malformed ISO datetime', () => {
    const r = SubscriptionActivated.zodSchema.safeParse({
      subscription: { publicId: 'sub_1' },
      activatedAt: 'not-a-date',
    });
    expect(r.success).toBe(false);
  });

  it('SettlementFailed rejects missing reason', () => {
    const r = SettlementFailed.zodSchema.safeParse({
      settlement: { publicId: 'stl_1' },
    });
    expect(r.success).toBe(false);
  });
});

describe('DomainEvent envelope', () => {
  it('PaymentVerified.create() emits a well-formed DomainEvent', () => {
    const event = PaymentVerified.create(
      { transaction: { publicId: 'txn_1', status: 'verified', methodKind: 'card' }, verifiedBy: 'u_1' },
      { organizationId: 'org_1', correlationId: 'c_1' },
    );
    expect(event.type).toBe('revenue:payment.verified');
    expect(event.meta.organizationId).toBe('org_1');
    expect(event.meta.id).toBeTruthy();
  });

  it('MonetizationCreated carries the transaction through the envelope', () => {
    const event = MonetizationCreated.create({
      monetizationType: 'purchase',
      transaction: { publicId: 'txn_1', methodKind: 'card' },
    });
    expect(event.type).toBe('revenue:monetization.created');
    expect((event.payload.transaction as { publicId?: string }).publicId).toBe('txn_1');
  });
});

describe('Arc EventRegistry structural compatibility', () => {
  // Mirror arc's registry without a runtime arc dep.
  function makeArcLikeRegistry() {
    const defs = new Map<string, { name: string; version: number; schema: unknown }>();
    return {
      register(def: { name: string; version: number; schema?: unknown }) {
        defs.set(def.name, { name: def.name, version: def.version, schema: def.schema });
      },
      catalog() {
        return [...defs.values()];
      },
      get(name: string) {
        return defs.get(name);
      },
    };
  }

  it('every definition registers cleanly into an Arc-shaped registry', () => {
    const registry = makeArcLikeRegistry();
    for (const def of revenueEventDefinitions) registry.register(def);
    expect(registry.catalog()).toHaveLength(revenueEventDefinitions.length);
    expect(registry.get('revenue:payment.verified')?.version).toBe(1);
    expect(registry.get('revenue:escrow.split')?.version).toBe(1);
    expect(registry.get('revenue:settlement.failed')?.version).toBe(1);
  });

  it('every entry carries a JSON Schema with type=object', () => {
    const registry = makeArcLikeRegistry();
    for (const def of revenueEventDefinitions) registry.register(def);
    for (const entry of registry.catalog()) {
      expect(entry.schema).toMatchObject({ type: 'object' });
    }
  });
});
