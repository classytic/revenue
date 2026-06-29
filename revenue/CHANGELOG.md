# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.0]

### Added — generalized settlement rollups (`summary` + `breakdownByRecipient`)

`recipientBalance` only rolled up ONE recipient, forcing hosts to hand-roll raw
aggregations for platform-wide / per-recipient / cross-org views. Two reusable
primitives now cover all of them (the `recipientBalance` status+due bucketing,
generalized — one tenant-scoped `aggregatePipeline`, never a raw `Model.aggregate`):

- **`summary(filter = {}, ctx)` → `SettlementSummary`** — the money-state
  (`held / available / processing / paidOut / pending / failed / lifetime /
  currency`) for an ARBITRARY filter: a recipient, an org, or the whole platform
  (pass `_bypassTenant` in ctx). Backs platform reconciliation + cross-org
  earnings.
- **`breakdownByRecipient(filter = {}, ctx)` → `RecipientBreakdown[]`** — one
  rollup per distinct `(recipientId, recipientType)` (plus first-seen `role`),
  for a "who is owed what" platform view.

`recipientBalance` is now a thin wrapper over `summary({ recipientId, … })`.
Exported types: `SettlementSummary`, `RecipientBreakdown`. No migration; no
breaking change to `recipientBalance`'s shape.

## [2.5.0]

### Added — `SettlementRepository.recipientBalance()` (the seller/creator "wallet")

`recipientBalance(recipientId, { recipientType?, currency? }, ctx)` returns a
recipient's payout balance bucketed by settlement status —
`{ pending, held, available, processing, paidOut, failed, lifetime, currency }`
in minor units. `pending` splits into `held` (escrowed — `scheduledAt` in the
future) and `available` (cleared — due now), so a marketplace can show "in
clearance" vs "ready to pay". One tenant-scoped `aggregatePipeline` over the
`{ recipientId, status }` index, so hosts stop hand-rolling a raw
`Model.aggregate` (which bypasses multi-tenant scope).

### Added — `processPending({ recipientId })` filter

`processPending` now accepts an optional `recipientId` so a host can pay out a
single seller/participant (gating each via their own KYC/eligibility check)
instead of only by organization.

## [2.4.0] - 2026-06-14

### Added — `settled` bank-feed/manual status + `settle()` / `unsettle()` verbs

New `BANK_FEED_STATUS.SETTLED` (`'settled'`) for a bank line that was reconciled
by a **linked document** (an invoice/bill whose payment already posted the cash
JE, `Dr Bank / Cr AR`). The line itself posts **no second journal entry**.

- `transaction.settle(id, { settledBy?, metadata? })` — `imported → settled`
  (bank_feed) / `pending → settled` (manual). Does **not** call the ledger
  bridge (no JE). Idempotent (re-running on a `settled` row is a no-op).
  `metadata` is shallow-merged (dotted `$set`) so the host can stamp the link
  back to the settling document.
- `transaction.unsettle(id, { unsettledBy?, clearMetadata? })` — reverses to the
  birth status (`settled → imported` bank_feed / `settled → pending` manual) and
  clears the named metadata keys.

Unlike `reconciled_external` (vendor-owned, born terminal, no edges), `settled`
is **reachable and reversible** but never enters the JE bridge. This replaces the
host-side pattern of a raw `updateOne` parking invoice-settled rows at `matched`
(which overloaded `matched` and forced every consumer to sniff
`metadata.matchedVia` to tell "done" from "needs a JE"). `status` is now the
single source of truth.

## [2.3.0] - 2026-06-02

### Added — `reconciled_external` terminal bank-feed status

New `BANK_FEED_STATUS.RECONCILED_EXTERNAL` (`'reconciled_external'`) for rows
that are already reconciled at the source vendor (e.g. synced Xero Payments or
bank-transfer legs whose GL the vendor already owns). It is a **terminal island**
in the bank-feed state machine: no inbound edge (cannot be flipped in from
`imported`/`matched`) and no outbound edge — so `match()`/`journalize()`/
`unmatch()` all throw `InvalidStateTransition`. Such rows can never post a
journal entry, so surfacing them for visibility can't double-count the ledger.

### Added — `initialStatus` option on `TransactionRepository.import()`

`import(rows, { …, initialStatus }, ctx)` overrides the born status of newly
inserted bank-feed rows (default `imported`). Pass `reconciled_external` so
vendor-reconciled rows are **born** terminal + non-matchable (closes the
race where a row could be matched in the window between insert and a later
status flip). Applies to `$setOnInsert` only — re-imports never overwrite an
existing row's status.

## [2.2.0] - 2026-05-26

### Added — auth/capture + dispute event coverage

Seven new event constants on `REVENUE_EVENTS` aligning with the
`@classytic/primitives@0.7.1` payment event catalogue:
`PAYMENT_AUTHORIZED`, `PAYMENT_CAPTURED`, `PAYMENT_AUTH_VOIDED`,
`PAYMENT_DISPUTED`, `PAYMENT_DISPUTE_WON`, `PAYMENT_DISPUTE_LOST`,
`PAYMENT_SETTLED`. Catalog payload schemas updated to match.

### Added — `RevenueError.httpStatus`

`RevenueError` carries an optional `httpStatus` field so Arc / Express
hosts can map errors to response codes without per-error switch
statements. Defaults to 500 in the host mapper when unset.

### Added — `MethodKindLockedError` (409)

New error thrown by `TransactionRepository.backfillMethodKind` when the
existing doc is not backfill-eligible (methodKind already specific OR
status no longer `pending`). 409 because the request is well-formed but
conflicts with current resource state.

### Changed — peer bump: `@classytic/primitives` `>=0.7.1`

Catalogue now imports `PAYMENT_METHOD_KIND` from
`@classytic/primitives/payment-method-kind`. Hosts must bump primitives
to `>=0.7.1`.

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
