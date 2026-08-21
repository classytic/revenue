/**
 * Test helper — bridges the flat legacy config the scenario/integration suites were written
 * against onto the describe/bind construction API. It splits the bag into the DESCRIBE-time
 * `RevenueShape` and the BIND-time `RevenueRuntime`, then `defineRevenue(shape).bind(conn, runtime)`.
 *
 * Behavioural suites (payment flow, webhooks, outbox, tenancy, settlement) care about engine
 * BEHAVIOUR, not the construction seam, so routing them through this helper keeps them focused.
 * The describe/bind seam ITSELF is proven directly (no helper) in `unit/define-revenue.test.ts`.
 */
import type { Connection } from 'mongoose';
import { defineRevenue } from '../../revenue/src/index.js';
import type { RevenueEngine, RevenueRuntime, RevenueShape } from '../../revenue/src/index.js';

export type BindRevenueConfig = RevenueShape & RevenueRuntime & { connection: Connection };

export function bindRevenue(config: BindRevenueConfig): RevenueEngine {
  const {
    connection,
    scope,
    modules,
    schemaOptions,
    collectionPrefix,
    autoIndex,
    forceRecreate,
    ...runtime
  } = config;

  const shape: RevenueShape = {
    scope,
    modules,
    schemaOptions,
    collectionPrefix,
    autoIndex,
    forceRecreate,
  };

  return defineRevenue(shape).bind(connection, runtime as RevenueRuntime);
}
