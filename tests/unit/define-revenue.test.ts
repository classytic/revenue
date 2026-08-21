/**
 * `defineRevenue` describe/bind blueprint — falsification tests
 * (STANDARDIZATION-PLAN §9 Phase 3, invariants §11.1/§11.3/§11.4/§11.7/§11.10/§11.12).
 *
 * Unit-only — no MongoMemoryServer. `mongoose.createConnection()` (unconnected) gives a real
 * per-connection model registry, and describing + registering models is registry-only with no
 * network I/O. These fail against an eager (register-at-describe) implementation.
 */
import { ModelCollisionError } from '@classytic/mongokit';
import type { EventTransport } from '@classytic/primitives/events';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { defineRevenue } from '../../revenue/src/index.js';

function freshConnection() {
  return mongoose.createConnection();
}

/**
 * `allowNonTransactional` is REQUIRED here, not incidental. These connections
 * are never opened, so mongokit cannot OBSERVE transaction support and reports
 * it unknown — and unknown fails closed at revenue's boot gate (an unobserved
 * outcome is never a positive one, AGENTS.md FAIL LOUD rule 3). Every check in
 * this file is registry-level, so stating the degradation explicitly is the
 * honest way to say "no deployment is under test here". The gate itself is
 * falsified against real topologies in
 * `tests/integration/capability-gate.test.ts`.
 */
const RUNTIME = { defaultCurrency: 'USD', allowNonTransactional: true } as const;

describe('defineRevenue — describe is pure', () => {
  it('registers NO model at describe time (global registry untouched)', () => {
    const before = {
      Transaction: mongoose.models.Transaction,
      PaymentAttempt: mongoose.models.PaymentAttempt,
      Subscription: mongoose.models.Subscription,
      Settlement: mongoose.models.Settlement,
    };
    const bp = defineRevenue({ scope: false });
    expect(bp.id).toBe('revenue');
    // Describe compiled no schema and registered no model on the global registry.
    expect(mongoose.models.Transaction).toBe(before.Transaction);
    expect(mongoose.models.PaymentAttempt).toBe(before.PaymentAttempt);
    expect(mongoose.models.Subscription).toBe(before.Subscription);
    expect(mongoose.models.Settlement).toBe(before.Settlement);
  });

  it('exposes model names without a connection (Transaction + PaymentAttempt + Subscription by default)', () => {
    const bp = defineRevenue({ scope: false });
    expect(Array.isArray(bp.modelNames)).toBe(true);
    expect(bp.modelNames).toEqual(['Transaction', 'PaymentAttempt', 'Subscription']);
  });
});

describe('defineRevenue — optional models gate on their module (invariant §11.10)', () => {
  it('omits Subscription when the module is off', () => {
    const bp = defineRevenue({ scope: false, modules: { subscription: false } });
    expect(bp.modelNames).toEqual(['Transaction', 'PaymentAttempt']);
    const engine = bp.bind(freshConnection(), RUNTIME);
    expect(engine.models.Subscription).toBeUndefined();
    expect(engine.repositories.subscription).toBeUndefined();
  });

  it('includes Settlement only when the module is on (default off)', () => {
    const off = defineRevenue({ scope: false });
    expect(off.modelNames).not.toContain('Settlement');
    const on = defineRevenue({ scope: false, modules: { settlement: true } });
    expect(on.modelNames).toContain('Settlement');
    const engine = on.bind(freshConnection(), RUNTIME);
    expect(engine.models.Settlement).toBeDefined();
    expect(engine.repositories.settlement).toBeDefined();
  });
});

describe('defineRevenue — bind is where registration happens', () => {
  it('registers the expected models on the SUPPLIED connection (not the global registry)', () => {
    const conn = freshConnection();
    const engine = defineRevenue({ scope: false }).bind(conn, RUNTIME);
    expect(conn.models.Transaction).toBeDefined();
    expect(conn.models.PaymentAttempt).toBeDefined();
    expect(conn.models.Subscription).toBeDefined();
    expect(engine.models.Transaction.modelName).toBe('Transaction');
    // Connection-local — not leaked to the global registry.
    expect(mongoose.models.Transaction).toBeUndefined();
  });

  it('two connections from one blueprint get distinct models', () => {
    const bp = defineRevenue({ scope: false });
    const a = bp.bind(freshConnection(), RUNTIME);
    const b = bp.bind(freshConnection(), RUNTIME);
    expect(a.models.Transaction).not.toBe(b.models.Transaction);
    expect(a.models.PaymentAttempt).not.toBe(b.models.PaymentAttempt);
  });

  it('scope shape reaches the compiled schema (organizationId present only when scoped)', () => {
    const off = defineRevenue({ scope: false }).bind(freshConnection(), RUNTIME);
    expect(off.models.Transaction.schema.path('organizationId')).toBeDefined();
    // scope:false still injects the field (raw queries reference it) but without required/index —
    // presence alone does not prove scoping; the on-case proves the required flag differs.
    const on = defineRevenue({ scope: { enabled: true, fieldType: 'string', required: true } }).bind(
      freshConnection(),
      RUNTIME,
    );
    expect(on.models.Transaction.schema.path('organizationId')?.isRequired).toBe(true);
  });

  it('exposes an idempotent close()', async () => {
    const engine = defineRevenue({ scope: false }).bind(freshConnection(), RUNTIME);
    expect(engine.close).toBeTypeOf('function');
    await engine.close();
    await engine.close(); // idempotent, no throw
  });
});

describe('defineRevenue — transport ownership (finding #7)', () => {
  it('does NOT close a host-SUPPLIED (external) transport on engine.close()', async () => {
    const close = vi.fn(async () => {});
    const transport = {
      name: 'external',
      publish: async () => {},
      subscribe: () => () => {},
      close,
    } as unknown as EventTransport;
    const engine = defineRevenue({ scope: false }).bind(freshConnection(), {
      ...RUNTIME,
      eventTransport: transport,
    });
    await engine.close();
    // Shared host transport — revenue must never close it.
    expect(close).not.toHaveBeenCalled();
  });
});

describe('defineRevenue — collision surfaces the typed mongokit error', () => {
  it('binding twice on one connection throws ModelCollisionError', () => {
    const conn = freshConnection();
    const bp = defineRevenue({ scope: false });
    bp.bind(conn, RUNTIME);
    expect(() => bp.bind(conn, RUNTIME)).toThrow(ModelCollisionError);
  });
});
