/**
 * Host `extraIndexes` are scope-aware and applied AFTER the tenant prepend.
 *
 * Before 2.12 a builder added them to the schema BEFORE `injectTenantField` ran,
 * so every host index came out led by the tenant field whatever the host
 * meant: a host whose buyers read their own subscriptions across every seller
 * (`bypassTenant`, filter on `customerId`) could not declare an index that
 * served the read at all.
 *
 * Unit-only: `mongoose.createConnection()` is never opened, so model
 * registration and `schema.indexes()` are registry-level (see
 * define-revenue.test.ts for why `allowNonTransactional` is stated).
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { defineRevenue, type IndexDeclaration } from '../../revenue/src/index.js';

const RUNTIME = { defaultCurrency: 'USD', allowNonTransactional: true } as const;

type IndexEntry = [Record<string, unknown>, { name?: string }];

function byName(indexes: IndexEntry[], name: string): string[] {
  const found = indexes.find(([, options]) => options?.name === name);
  if (!found) throw new Error(`index ${name} not declared`);
  return Object.keys(found[0]);
}

const buyerHistory: IndexDeclaration = {
  fields: { customerId: 1, createdAt: -1 },
  scope: 'global',
  options: { name: 'subscription_buyer_history_global' },
};

describe('host extraIndexes', () => {
  it('prefixes a tenant declaration and keeps a global one as written, on every model', () => {
    const engine = defineRevenue({
      scope: { fieldType: 'objectId' },
      modules: { settlement: true },
      schemaOptions: {
        transaction: { extraIndexes: [{ fields: { method: 1, createdAt: -1 }, options: { name: 'host_txn_by_method' } }] },
        subscription: { extraIndexes: [buyerHistory] },
        settlement: { extraIndexes: [{ fields: { recipientId: 1 }, options: { name: 'host_stl_by_recipient' } }] },
      },
    }).bind(mongoose.createConnection(), RUNTIME);

    const txn = engine.models.Transaction.schema.indexes() as IndexEntry[];
    expect(byName(txn, 'host_txn_by_method')).toEqual(['organizationId', 'method', 'createdAt']);

    const sub = engine.models.Subscription!.schema.indexes() as IndexEntry[];
    expect(byName(sub, 'subscription_buyer_history_global')).toEqual(['customerId', 'createdAt']);

    const stl = engine.models.Settlement!.schema.indexes() as IndexEntry[];
    expect(byName(stl, 'host_stl_by_recipient')).toEqual(['organizationId', 'recipientId']);
  });

  it("the kernel's own global indexes are still unscoped beside a host's", () => {
    const engine = defineRevenue({ scope: { fieldType: 'objectId' } }).bind(mongoose.createConnection(), RUNTIME);
    const txn = engine.models.Transaction.schema.indexes() as IndexEntry[];
    const idempotency = txn.find(([fields]) => Object.keys(fields).join(',') === 'idempotencyKey');
    expect(idempotency).toBeDefined();
  });

  it('refuses an unnamed global declaration at describe time, before any bind', () => {
    expect(() =>
      defineRevenue({
        scope: { fieldType: 'objectId' },
        schemaOptions: { subscription: { extraIndexes: [{ fields: { customerId: 1 }, scope: 'global' }] } },
      }),
    ).toThrow(/must be named/);
  });
});
