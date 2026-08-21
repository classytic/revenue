/**
 * Kernel Construction Standard conformance — the EXECUTABLE §11 invariant list.
 *
 * The suite lives in `@classytic/mongokit/kernel-conformance` (a kernel may never depend on
 * arc, and every kernel already depends on mongokit), and is RUN here rather than
 * copy-pasted: when the standard gains a check, this file gets it on the next install.
 *
 * `mongoose.createConnection()` is never connected, which is all these checks need: model
 * registration, schema identity and the index-call spies are registry-level, and an
 * unconnected connection also guarantees mongoose's own `autoIndex` cannot muddy the
 * "bind performs no index I/O" observation. This is the same no-server posture the
 * hand-written `tests/unit/define-revenue.test.ts` already uses.
 */
import { describeKernelConformance } from '@classytic/mongokit/kernel-conformance';
import type { EventTransport } from '@classytic/primitives/events';
import mongoose from 'mongoose';
import { describe, it } from 'vitest';
import type { RevenueBlueprint } from '../../revenue/src/engine/define-revenue.js';
import type { RevenueEngine } from '../../revenue/src/engine/engine-types.js';
import * as kernel from '../../revenue/src/index.js';

/** Quiet the engine's default `console` logger for the conformance binds. */
const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeKernelConformance<RevenueBlueprint, RevenueEngine>({
  name: 'revenue',
  runner: { describe, it },

  // A FACTORY, so the suite can watch `defineRevenue` run and prove it registers nothing.
  // No `forceRecreate` — the collision check needs a real collision.
  blueprint: () => kernel.defineRevenue({ scope: false, autoIndex: false }),

  connect: async () => mongoose.createConnection(),

  // These connections are never opened, so mongokit cannot OBSERVE transaction support and
  // reports it unknown — which revenue's boot gate (correctly) refuses. Every check here is
  // registry-level, so accepting the degradation explicitly is the honest way to say "no
  // deployment is under test".
  bind: (blueprint, connection, ctx) =>
    blueprint.bind(connection, {
      defaultCurrency: 'USD',
      allowNonTransactional: true,
      logger: silentLogger,
      ...(ctx.transport ? { eventTransport: ctx.transport as unknown as EventTransport } : {}),
    }),

  // The DEFAULT module set: Transaction + PaymentAttempt are core, Subscription defaults ON
  // and Settlement defaults OFF (src/models/create-models.ts). Pinning it here is what makes
  // a default flip — the kind that silently changes which collections a deployment owns —
  // a failing test rather than a surprise in production.
  expectedModelNames: ['Transaction', 'PaymentAttempt', 'Subscription'],
  moduleExports: kernel,

  // §11.10 — revenue genuinely gates REGISTRATION, not just materialisation: with
  // `modules.subscription: false` the Subscription spec is never pushed onto the spec array,
  // so the disabled module declares no model, no collection and no index.
  minimalBlueprint: () =>
    kernel.defineRevenue({
      scope: false,
      autoIndex: false,
      modules: { subscription: false, settlement: false },
    }),

  // §11.5 — the same unopened connection, bound WITHOUT the opt-in, must be refused.
  //
  // This was a [NOT EXERCISED] marker until 2026-08-05, and the reason it records is worth
  // keeping: revenue's bind genuinely had NO runtime capability gate. `defaultCurrency` and
  // the provider ports are enforced by the TYPE, so the only way to force a throw was to pass
  // `undefined as never` — which asserts a TypeError, not a verified capability, and would
  // have reported §11.5 as satisfied while nothing verified anything.
  //
  // Revenue now HAS one (`assertRevenueCapabilities`), added because it is the money kernel:
  // capture settlement and refund claim/rollback run through `withTransaction` with no
  // fallback, so a standalone deployment used to fail at the first real refund instead of at
  // boot. mongokit observing the live topology is what makes the check falsifiable rather
  // than the tautology every other kernel's gate was.
  bindWithUnmetRequirement: (connection) =>
    kernel
      .defineRevenue({ scope: false, autoIndex: false })
      .bind(connection, { defaultCurrency: 'USD', logger: silentLogger }),

  /**
   * The dedicated outbox-atomicity check, distinct from the transaction gate above.
   *
   * `transactionalSave` is ABSENT here, not `false` — the shape a hand-rolled host store
   * actually has. Deliberately WITHOUT `allowNonTransactional`: the outbox gate is the FIRST
   * statement in `bind`, and because this check asserts the error names `transactionalSave`,
   * it passes only while that ordering holds. A ghost `payment.succeeded` for a capture that
   * rolled back is a fulfilment, an entitlement, or a payout for money that never arrived.
   */
  bindWithNonTransactionalOutbox: (connection) =>
    kernel.defineRevenue({ scope: false, autoIndex: false }).bind(connection, {
      defaultCurrency: 'USD',
      logger: silentLogger,
      outbox: { save: async () => undefined } as never,
    }),
});
