# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] — multi-tenant scope correctness across all repos

**Fix.** `SubscriptionRepository` and `SettlementRepository` lifecycle verbs
were calling internal `getById` / `update` / `getAll` without threading
`ctx.organizationId` into the mongokit options bag. The moment a host
enabled `multiTenantPlugin` (the recommended default — see PACKAGE_RULES
§9), every verb threw `Missing 'organizationId' in context for 'getById'`
mid-flow and the lifecycle was unusable.

Affected verbs (all now threaded correctly):

- `SubscriptionRepository.{activate,cancel,pause,resume}` — every internal
  `getById` and `update` now forwards `ctx`.
- `SettlementRepository.{schedule,processPending,complete,fail}` — every
  internal `getById`, `getAll`, `update` now forwards `ctx`.

**Refactor.** Introduces `RevenueRepositoryBase<TDoc, TDeps>` (abstract;
internal — not exported) consolidating the two cross-cutting concerns
that were previously hand-rolled in three places:

- `protected optsFromCtx(ctx, extra?)` — thin adapter over mongokit's
  canonical `repoOptionsFromCtx` extractor, plus revenue's `_bypassTenant`
  flag for platform-admin cross-org reads. **Adding a new canonical context
  field is now a single edit in `repo-options.ts` upstream, not three.**
- `protected dispatch(event, ctx)` — outbox-save (session-bound when
  `ctx.session` is present) → transport-publish, with isolated try/catch
  on each step (PACKAGE_RULES P8 / §5.5).

`TransactionRepository`, `SubscriptionRepository`, `SettlementRepository`
all extend the base. `BaseRevenueRepoDeps` (the shared `events` / `outbox`
/ `logger` trio) is now the canonical superset every per-repo `Deps`
interface extends.

### Added

- **`tests/scenarios/subscription-tenancy.scenario.test.ts`** — 6 tests
  proving each lifecycle verb works under `scope: { enabled, required }`,
  cross-tenant access is rejected with `SubscriptionNotFoundError`, and
  `multiTenantPlugin` is wired (canary: omitting ctx throws
  `Missing organizationId`).
- **`tests/scenarios/settlement-tenancy.scenario.test.ts`** — 5 tests for
  the same matrix on settlements: schedule, processPending, complete, fail,
  cross-tenant rejection.

### Internal

- `RevenueRepositoryBase` is unexported on purpose — kept private to
  the package. Adding a new repo means subclassing it; consumers stay
  on the existing engine factory surface (`createRevenue(...)`).
- No public API change. Engine factory, repo method signatures, and
  exported types are all byte-stable.

### Migration

None — this is a behavioural fix. If you were running 2.1.0 with
`scope: false` as a workaround for the lifecycle bugs, you can now turn
scope back on. Recommended config:

```ts
await createRevenue({
  connection: mongoose.connection,
  scope: { enabled: true, fieldType: 'objectId', required: true },
  // ...
});
```

## [2.0.0] — major rewrite

Payment lifecycle engine refactored around unified transactions, an
explicit state-machine core, and a compact 9-subpath surface. The old
`src/application/services/*` indirection + `src/core/container.ts` /
`src/core/events.ts` / `src/core/revenue.ts` / `src/core/plugin.ts` /
`src/core/result.ts` layers are gone — repositories + the engine factory
are the surface.

### Added

- **`/core` subpath** — exposes `state-machines.ts` (TRANSACTION/HOLD/SPLIT
  transitions + the generic `StateMachine<TState>` runtime) and the
  `StateChangeEvent` shape so hosts can wire audit trails without pulling
  in the full engine.
- **`/bridges` subpath** — host-side integration bridges (pricing, credit,
  catalog, etc.) as typed ports; no side effects, no runtime coupling.
- **`/providers` subpath** — payment-provider adapter contracts consumed
  by concrete adapter packages (`@classytic/revenue-manual` today; Stripe,
  SSLCommerz, bKash etc. as separate packages).
- **`/utils` subpath** — shared helpers (audit trail, context resolution,
  money conversion).
- **Unified transaction model** — single `Transaction` document carries
  payment, subscription, escrow hold, split, and settlement context.
  Status transitions validated by the state-machine core.
- **Audit trail helpers** (`appendAuditEvent`, `getAuditTrail`,
  `getLastStateChange`) in `/utils`. Every state change emits a typed
  `StateChangeEvent` (resourceType, resourceId, fromState, toState,
  changedAt, changedBy?, reason?, metadata?).
- **Split-payment + tax features** and bug fixes from the 1.1 line folded
  into 2.0.
- **Multi-payment support** on a single transaction (partial capture,
  retry-with-different-method).

### Changed

- **Dropped `src/application/services/*`** (escrow/monetization/payment/
  settlement/subscription/transaction services). Equivalent logic now
  lives on the repositories or the engine factory.
- **Dropped `src/core/` scaffolding** (container.ts, events.ts,
  plugin.ts, result.ts, revenue.ts, state-machine/ subdir) in favor of
  the flatter `state-machines.ts` + engine factory shape.
- **Peer deps standardized on `>=`** — `@classytic/mongokit >=3.11.0`,
  `@classytic/primitives >=0.1.0`, `@classytic/repo-core >=0.2.0`,
  `mongoose >=9.4.1`, `zod >=4.0.0`.
- **DevDeps:** `@classytic/primitives` moved off `file:` link onto
  `>=0.1.0` now that primitives ships on npm.
- **Build migrated to tsdown** — per `tsdown.config.ts`, nine entries
  aligned with the subpath exports.

### Removed

- `src/application/index.ts` + every service module under it.
- `src/core/container.ts`, `events.ts`, `plugin.ts`, `result.ts`,
  `revenue.ts`, and the `state-machine/` subdirectory (replaced by
  `state-machines.ts`).
- Internal barrels under `src/` — only `src/index.ts` re-exports now.

### Peer compatibility

Consumers on 1.x that imported from `@classytic/revenue` root will need
to migrate:
- Any `services.transaction.*` / `services.payment.*` / `services.escrow.*`
  / `services.settlement.*` / `services.subscription.*` / `services.monetization.*`
  calls move to the engine repositories.
- Custom state transitions move from the old container-based events to
  the `StateMachine<TState>` API in `/core`.
- Providers move to the `/providers` contract; the manual reference
  implementation ships as `@classytic/revenue-manual`.

### Tests

252 tests across 25 files (unit + integration + scenarios), run via
`vitest` at the workspace root. `mongodb-memory-server` for integration.

## [1.1.x]

Refinements on the 1.x line — split payment feature, tax feature, bug
fixes. Unified transaction shape landed here before the 2.0 restructure.

## [1.0.0]

Initial stable release on npm. Payment lifecycle engine —
transactions, subscriptions, escrow, settlements, commissions.
MongoKit-powered, framework-agnostic, Arc-compatible event shape.
