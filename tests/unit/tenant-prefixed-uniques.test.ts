import mongoose from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';
import { bindRevenue } from '../helpers/bind-revenue.js';
import { FakeProvider } from '../helpers/fake-provider.js';

/**
 * Shard-readiness guard. MongoDB can only shard a collection by a key if every unique index starts
 * with that key, so a unique index without the tenant prefix makes its collection unshardable by
 * tenant. Nothing is global on purpose here (the browser-return owner lookup lives in the
 * `revenue_return_proof_routes` directory); a new entry needs a stated reason.
 */
const GLOBAL_UNIQUE_ALLOWLIST: Record<string, string> = {
};

describe('every unique index leads with the tenant field (field-scoped engine)', () => {
  const conn = mongoose.createConnection();
  const engine = bindRevenue({
    connection: conn,
    defaultCurrency: 'BDT',
    providers: { fake: new FakeProvider() },
    scope: { enabled: true, fieldType: 'string' },
    allowNonTransactional: true, // schema-only: no database is touched
    forceRecreate: true,
  });
  afterAll(async () => {
    await engine.close();
    await conn.close();
  });

  it('has no unique index missing the tenant prefix outside the allowlist', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const [modelName, model] of Object.entries(conn.models)) {
      for (const [fields, options] of model.schema.indexes()) {
        if (!options.unique) continue;
        const name = String(options.name ?? JSON.stringify(fields));
        seen.add(name);
        if (Object.keys(fields)[0] === 'organizationId') continue;
        if (name in GLOBAL_UNIQUE_ALLOWLIST) continue;
        offenders.push(`${modelName}.${name} ${JSON.stringify(fields)}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(seen.size).toBeGreaterThan(0);
  });

  it('keeps the allowlist honest: every entry is still a real unique index', () => {
    const names = new Set<string>();
    for (const model of Object.values(conn.models)) {
      for (const [, options] of model.schema.indexes()) if (options.unique) names.add(String(options.name));
    }
    for (const name of Object.keys(GLOBAL_UNIQUE_ALLOWLIST)) expect(names.has(name), name).toBe(true);
  });
});
