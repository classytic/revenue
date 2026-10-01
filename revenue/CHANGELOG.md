# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
adhering to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 2.13.0 — unreleased

### Fixed — canonical payment events never carry `null` for an optional field
`providerRef`, `methodCode` and `metadata.sourceModel` are read from the stored transaction, where Mongo
holds `null`; the builders only skipped `undefined`, so the payload broke the catalog's own
`optional()` contract. They are now omitted when null.

### Fixed — a retried transaction delivered the aborted attempt's event

`refund()` and escrow `split()` queued events outside the `withTransaction` body, so a
transient-error retry delivered the first attempt's event (its outbox row rolled back) AND the
second's: two `payment.refunded` for one refund on an inline host. Every transaction that emits
events now goes through `transactionWithEvents` (the base repository), which starts each attempt
with no events and delivers once after commit. `saveToOutbox` / `publishToTransport` are gone.
`afterCommit` now fires ONCE per commit with all of its events (`deliverAll`), as the order
kernel does per unit of work — one relay nudge, not one per event.

### Fixed — an outboxed event was delivered TWICE; `runtime.dispatch` picks who delivers

Every outboxed event was published live (inside the caller's request, awaited) and again by
the relay, because nothing acknowledged the row. On a web placement that is ~32 database
operations of payment subscribers (cash posting, invoice settlement, contracts, loyalty) run
inside the HTTP request, then re-run by the relay.

`bind` now takes the order kernel's contract:

- `dispatch: 'inline'` (DEFAULT) — publish live after commit, then acknowledge the row. The
  same timing as before, minus the duplicate, so an existing outbox host needs no change.
- `dispatch: 'relay'` — publish nothing; the relay delivers the committed row. Pair with
  `afterCommit` (arc's `createRelayNudge`) so delivery is prompt. Refused without an outbox.

Both delivery paths (`dispatch()` and the post-commit publish after `saveToOutbox`) go through
one `deliver()`, so they cannot disagree.

### Added — `engine.config.hasOutbox`

Whether the engine was bound with an outbox. A caller that wraps verbs in its own
transaction reads it before passing `ctx.session`: without an outbox every in-session
verb throws `UnmanagedSessionError` (409 `revenue.session.unmanaged`), by design. Nothing
reported it, so `@spinekit/revenue` wrapped `verify` unconditionally and every
production deployment without an outbox got a 409 on Confirm.

### Added — `refund(..., { metadata })`

The caller's facts about THIS refund (e.g. `{ cashDestination }` — the cash account it left
from) are stored on the refund transaction and carried on `payment.refunded` as
`metadata.refundMetadata`. Kept on the refund attempt too, so a RECOVERED refund
(`reconcileAttempt`) finalizes with them — and with its reason, which recovery used to drop.

### Added — `createPaymentIntent({ reference })`: the payer's reference on the canonical field

A manual payment's evidence (an MFS TrxID, a bank transfer reference) now lands on
the transaction's own `reference` field, trimmed; a blank one is not stored. Hosts
had been carrying it in `metadata.reference` or `paymentDetails.trxId`, and each
reader spelled it differently — the verifier saw one, the order confirmation read
another that nothing wrote, so the TrxID never reached the order.

## 2.12.0

### Fixed — a payment webhook dispatched its event untenanted

A webhook addresses the platform, not a business, so `handleWebhook` looked
the transaction up in whatever context it was given — none — then verified
and dispatched in that same empty context. On a scoped engine the lookup
itself refused; on any engine the resulting `payment.succeeded` carried no
`organizationId`, and every scoped subscriber downstream (order confirm,
reservation confirm) ran untenanted.

The lookup is now the one legitimate cross-tenant read here (by
provider-unique ids), and the ROW's `organizationId` is lifted into the
context for everything that follows, so the event carries the tenant the
payment actually belongs to.

### Changed — host `extraIndexes` are scope-aware, applied AFTER the tenant prepend

`schemaOptions.<model>.extraIndexes` used to be added to the schema by the
builder, BEFORE `injectTenantField` ran, so every host index came out led by
the tenant field whatever the host meant. A host whose buyers read their own
subscriptions across every seller (`bypassTenant`, filter on `customerId`)
therefore could not declare an index that served the read at all, and the
kernel's own global indexes (`gateway.sessionId`, `idempotencyKey`, `publicId`)
were declared by hand after the call, an ordering rule that lived in a comment.

The entries are now `IndexDeclaration`s from `@classytic/mongokit/tenant`
(re-exported here), applied by `create-models.ts` after the prepend:
`scope: 'tenant'` (default) is led by the tenant field exactly as before,
`scope: 'global'` is kept as written and must be named. A bad declaration is
refused at describe time. `RevenueModelExtensions` names the per-model shape.
Existing configs that never set `scope` behave identically.

### Changed — tenant injection is `@classytic/mongokit/tenant`'s

`src/models/inject-tenant.ts`, the copy PACKAGE_RULES told every kernel to
clone, now re-exports the shared implementation. Requires
`@classytic/mongokit >=3.39.0`.

### Changed — `breakdownByRecipient` is bounded by default

It grouped EVERY settlement row matching the filter and returned every
recipient. That is right for a reconciliation job and wrong for the screen
that calls it: a marketplace with a long tail of payees pays for the whole
tail to render one page of it, and the cost grows with the ledger's history
rather than with what is shown.

`BreakdownOptions` adds `limit` (default `DEFAULT_BREAKDOWN_LIMIT` 200,
clamped to `MAX_BREAKDOWN_LIMIT` 1000), a cursor on `recipientId`, and
`all: true` for the reconciliation case that genuinely wants every row — which
now has to say so, and enables disk use when it does.

### Changed — peer floors raised to current

- `@classytic/mongokit` `>=3.25.0` (devDependency) → **`^3.39.0`**
- `@classytic/primitives` `>=0.23.0` → **`>=0.28.0`**
- `@classytic/repo-core` `>=0.24.0` → **`>=0.28.0`**
- `@classytic/validation` `>=0.4.0` → **`>=0.6.0`**

## 2.11.0

### Added — `TransactionRepository.cancel()`, the VOID verb

The third sibling of `verify()`/`fail()`, and the correction path a posted
transaction had none of. Generic CRUD refuses to touch a row that has left
`pending`, so a mistaken capture could previously only be refunded — which
returns money that may never have been taken — or edited behind the guard,
which desyncs the GL silently.

- `fail()` — the gateway declined, no money ever moved.
- `refund()` — money moved and is being returned to the customer.
- `cancel()` — the settlement itself is unwound (operator error, duplicate
  capture, pre-clearing void). Consumers must reverse allocations, which is
  NOT what they do for a refund; approximating one as the other corrupts A/R
  in a way that still balances.

The CAS is the only guard: `TRANSACTION_STATE_MACHINE` already permits
`pending | payment_initiated | requires_action | verified → cancelled` and
nothing else, so a refunded, failed or already-cancelled row throws
`InvalidStateTransitionError` (409) natively — no hand-checked status list to
drift from the machine.

New `TransactionDocument` fields `cancelledAt`, `cancellationReason`,
`cancelledBy` — distinct from `failedAt`: a failure is the gateway's answer,
a cancellation is the operator's decision to void the payment.

### Added — `payment.reversed` event, published conditionally

New `PaymentReversed` event / `paymentReversedCanonicalSchema`, dispatched by
`cancel()` **only when the row was `verified`** — i.e. money had actually
been recognised. Cancelling a `pending` or `payment_initiated` row unwinds
nothing; emitting a reversal for it would tell the ledger to contra a posting
that was never made, producing a one-sided entry that balances on its own and
is therefore invisible. Unlike `payment.refunded`, `reason` is required: a
reversal is always somebody's decision, and the row it leaves is the only
record of why the money is not there.

`toPaymentReversed` (in `canonical-payment-events.ts`) shipped unused in an
earlier release; this release is what calls it.

### Added — provider port conformance suite

`tests/port-conformance.test.ts` runs the same scenario set (create → verify,
idempotent create, refund full/partial, refund idempotency, webhook capability
match, `getStatus` never fabricating success) against every registered
`PaymentProviderPort` adapter, so a scenario failing on one provider but not
another identifies the PORT as wrong, not the adapter. Currently covers
`ManualProvider`; `@classytic/revenue-stripe` has no case yet — nothing in
this workspace mocks the Stripe SDK client it wraps.

### Changed — shared MongoDB memory-server test helper moved to `@classytic/mongokit/testkit`

`tests/helpers/mongodb-memory.ts` now boots through `createMongoMemory()`
instead of a package-local `MongoMemoryReplSet.create()` call — dedupes the
in-memory replica-set bootstrap this workspace and mongokit's own test suite
were each maintaining separately. No behavior change for existing tests.

## 2.10.1 — 2026-08-21

- Patch release — version alignment.

## 2.10.0

### Added

- **`tax` on the engine runtime** — `defineRevenue(...).bind(conn, { tax })`, where
  `tax` is a `TaxConfig` **or a thunk** `() => TaxConfig | Promise<TaxConfig>`,
  resolved PER TRANSACTION. Prefer the thunk: a static config is captured at bind,
  and an operator flipping tax registration then produces a measured split brain —
  the next sale's invoice (live config) rated 27,000 while its transaction (bound
  config) recorded 0, until a restart. The bind-time FRACTION guard wraps a thunk
  so a percent-shaped rate throws on first resolution rather than mis-taxing.
  Threaded exactly like `commission`: same runtime option, same `deps` field, same
  calculator call in `createPaymentIntent`. No new mechanism.

- **`createPaymentIntent` now records tax.** It wrote a literal `tax: 0`, so purchases,
  operational transactions and refunds all recorded tax while customer SALES never did.
  Consumers that build accounting entries from `transaction.tax` therefore booked input
  tax and no output tax — a filing gap that balances perfectly and surfaces only at audit.
  `refund()` already called `reverseTax(original.tax, …)`, reversing a number nothing set.

  The row now carries `tax`, `taxDetails: { type, rate, isInclusive }`, and
  `net = amount - fee - tax` — the mirror image of the formula `refund()` already used,
  so a full refund of a taxed sale leaves no residue in `net`.

### Compatibility

- **Omit `tax` and nothing changes.** `calculateTax(amount, category, null)` returns
  `isApplicable: false` with a zero amount, so an engine that wires no tax config behaves
  byte-identically to 2.9.x. Only a host that opts in starts recording tax.

### Guard

- **`bind` refuses a `tax.defaultRate` above 1**, as the first statement, before any model
  is compiled. The rate is a FRACTION (`amount / (1 + rate)`), while country configuration
  almost always states a percentage — passing `15` computes `amount / 16`, an effective 94%
  tax that is a positive integer below the gross, so every downstream check still passes.
  A tax rate at or above 100% does not exist, so this cannot reject a real configuration.



## 2.9.0 — 2026-08-17

**Version note (2026-08-16).** This span was briefly numbered 2.8.3 / 2.9.0 / 3.0.0 / 3.0.1
in the working tree. It is ONE unreleased release off the published `2.8.2`, and it is
**2.9.0**: `3.0.0` is reserved for the move to **mongoose 10 + mongokit 4**, which is the
next actual breaking change. The relicense below is deliberately NOT the major — a licence
term is not a semver API break, and spending the major on it would leave the DB-stack break
without one. Nothing was ever published above 2.8.2 (`npm view @classytic/revenue versions`),
so the renumber breaks no installed consumer; the declared ranges in be-prod,
`@spinekit/revenue` and `@spinekit/accounting` moved down with it.

### Changed
- **License:** relicensed from MIT to the **Classytic Source-Available License** (Community & Commercial). Evaluation/development use remains free; production use now requires a commercial license from Classytic LLC. See `LICENSE`.
- Versions published up to and including **2.8.2** remain under their original MIT terms; this release is the first under the new licence. (This bullet said "major bump marks the license change" while the span was numbered 3.0.0 — see the version note above for why the major is reserved instead.)

### Fixed — every canonical payment event was rejected by every consumer

`canonicalInstant` was `z.iso.datetime()` (a string) while the builders in
`canonical-payment-events.ts` emit `occurredAt: Date` — the type
`@classytic/primitives/events/payment-events` declares, correctly, as the
in-process shape. The two are INDEPENDENT declarations of one contract and never
meet in a type position, so `tsc --noEmit` was rc 0 with 0 errors while
consumers rejected **100% of deliveries**.

The narrowing rested on a false premise, written into the docblock it replaced:
"a subscriber receives JSON: the event is persisted to the outbox and relayed, so
`occurredAt` arrives serialised." A Mongo-backed outbox does not serialise —
`@classytic/mongokit/outbox` stores the envelope as `Schema.Types.Mixed` ("the
event, verbatim, as the relay will republish it"), so a `Date` round-trips
through BSON as a `Date`. And the transaction repositories publish TWICE
(`saveToOutbox` in-transaction, `publishToTransport` after commit), so the
in-process path never serialised either. **Both paths deliver a `Date`.**

Observed live on 2026-08-16 in a commerce deployment: a refund executed, the
customer was refunded, the RMA stamped `settledAt` — and `@spinekit/accounting`
logged `posting: payload validation failed — skipping` (WARN, no throw, no
dead-letter) once per delivery path. **No revenue or output-VAT reversal journal
entry was ever posted.** A refunded sale overstates both and carries the
overstatement into the VAT return. `payment.succeeded` and `payment.failed`
share `canonicalInstant` and were equally affected.

- `canonicalInstant` is a `z.union([z.iso.datetime(), z.date()])` — what the
  original docblock described, restored. The union is kept rather than plain
  `z.date()` so a future HTTP/Kafka relay, which does serialise, cannot
  reproduce this bug with the paths swapped.
- `defineRevenueEvent` now converts with `z.toJSONSchema(schema, {
  unrepresentable: 'any' })`. It ran with zod's default `'throw'` and runs
  EAGERLY at module load, so a single `z.date()` anywhere threw
  `Date cannot be represented in JSON Schema` at import — that pressure is what
  narrowed the schema in the first place. The DOCS projection must never dictate
  the VALIDATION contract; this matches `@classytic/arc`'s own converter for
  every non-throw mode.

### Added
- `tests/builder-payload-satisfies-schema.test.ts` — every canonical builder's
  output is parsed by the event's own `zodSchema`, in BOTH the live (`Date`) and
  serialised (`JSON.parse(JSON.stringify(...))`) shapes. The pre-existing
  `canonical-payment-events.test.ts` asserted builder output against the
  primitive TYPE only, which is why it stayed green through this bug.
  Both mechanisms falsified independently: re-narrowing the union fails the three
  LIVE assertions with the exact production message
  (`Invalid input: expected string, received Date`), and restoring the default
  converter throws at import (`Test Files 1 failed`, `Tests no tests`).

### Added — idempotent refunds

`TransactionRepository.refund()` now accepts `options.idempotencyKey`, making a
refund safely RETRYABLE — the missing primitive for host-side refund sagas that
must recover from a crash between "gateway charged" and "refund recorded".

- **Pre-check replay**: when the key matches an existing `type: 'refund'`
  transaction, that transaction is returned WITHOUT calling the gateway again
  (mirrors `create()`'s existing charge idempotency).
- **Gateway pass-through**: the key is forwarded to `provider.refund(id, amount,
  { reason, idempotencyKey })` so a gateway that honours it (Stripe-style) dedups
  a concurrent / retried first-time refund at the source, before any local row
  exists.
- **Persisted on the refund txn**: the existing partial-unique `idempotencyKey`
  index becomes the last-resort guard against a same-key race.

`PaymentProvider.refund`'s `options` gained an optional `idempotencyKey`
(additive — existing providers stay structurally compatible and may ignore it).
No behaviour change when the key is omitted.

### Added — operator payment-failure verb

`TransactionRepository.fail(id, { reason, failedBy })` — the sibling of
`verify()` for an operator declining a payment-flow transaction the gateway
never confirmed (manual-payment rejection). Machine-gated CAS to `FAILED`
(fail-closed on an already-verified or terminal row) + `revenue:payment.failed`
event, with no provider read. Replaces hosts hand-checking status before a raw
`update({ status: 'failed' })`.

## 2.8.3 - 2026-07-22 (unpublished)

### Changed
- Internal: `InProcess*Bus` is now a thin subclass of `@classytic/primitives/event-infra`'s shared `InProcessEventBus` (dedup / error-isolation / close semantics unchanged); `MemoryOutboxStore` re-exported from the shared runtime where applicable. No public API, event-name, or wire-envelope change. Requires `@classytic/primitives >=0.13.0`.

## [2.8.2] — 2026-07-17

### Fixed — event catalog drift vs actual dispatch shapes

The catalog schemas for the payment family never matched what the
repository verbs actually emit. Invisible while events died on the isolated
in-process bus; the moment a host injects `outbox` + `eventTransport`
(be-prod's transactional-outbox wiring) subscribers validate REAL payloads
and every refund event failed validation.

- **`paymentRefundedSchema`**: `refundAmount` is a plain minor-unit
  `number` (what `refund()` dispatches), not a `{ amount, currency }`
  money object; required `originalAmount` removed (never emitted).
- **`transactionRef`**: `amount` accepts the doc's plain number (was
  money-shaped only — rejected every real transaction doc); `methodKind`
  now optional — a REF only guarantees identity fields, and host test
  fixtures legitimately publish `{ _id }` alone.

Subscribers keying on these schemas (arc-accounting posting handlers) get
the corrected inferred payload types.

## [2.8.1] — 2026-07-16

### Fixed — redundant-prefix indexes removed (write amplification, zero read benefit)

- **`kind` field-level index dropped** (transaction schema): kind-prefix
  queries are served by the `{ kind, status, createdAt }` compound (and the
  match-candidates indexes when bank-feed is on). The bare `kind_1` was a
  redundant prefix — every insert paid for it, no query needed it.
- **`injectTenantField` no longer force-indexes the tenant field.** When
  scoped, the prepend pass makes the tenant the LEADING key of every
  compound — MongoDB serves tenant-only queries from any of those prefixes,
  so the bare `tenantField_1` was redundant on every scoped host (and a
  zero-use index on scope-disabled hosts). A dedicated single-field tenant
  index is still created when a schema declares no other indexes to prepend,
  so scoped list queries always have one to ride.

Found by be-prod's `db:ensure-indexes --stats` usage/redundancy audit. Pure
index-declaration change — no query, verb, or wire behavior touched.

## [2.8.0] — 2026-07-15

### Changed — mongokit `applyTransition()` adopted across the transaction lifecycle (peer floors: mongokit >=3.22.2, repo-core >=0.13.0, primitives >=0.11.0)

- **Requires mongokit ≥3.22.2** — this migration is what motivated (and
  battle-tests) 3.22.1's re-claim fix: a from-array member equal to `to`
  is an idempotent RE-CLAIM (match's `matched → matched`
  re-match-with-new-mapping), which 3.22.0 wrongly asserted against the
  transition table.
- **Seven verbs migrated**: `verify` (was assert-then-plain-`update` — the
  status write is now a machine-gated CAS; safe because the provider call
  is a verification READ), `match`, `unmatch`, `settle`, `unsettle`,
  `journalize`, `reject`. The `StateMachine` facade now satisfies
  mongokit's structural `TransitionMachine` directly (`name` +
  `assertTransition`), so per-kind machines (`smFor`) pass straight in.
- **New `fromSet(machine, candidates, to)` helper** — CAS breadth is now
  the per-kind table's TRUTH: candidates filter to (target-itself =
  re-claim) ∪ (machine-legal sources). This preserves the historical
  multi-source tolerance while TIGHTENING it — the old shared arrays
  (e.g. `[imported, matched, pending]` across both kinds) could let the
  CAS write an edge the kind's machine never declared.
- Error contracts: pure races / vanished rows still throw the historical
  per-verb `ValidationError` messages; a race into a now-illegal state
  throws `InvalidStateTransitionError` with the ON-DISK status (same type
  the pre-flight always threw — previously that edge case collapsed into
  the generic ValidationError).
- **DELIBERATELY kept**: `refund`'s post-provider status write stays a
  plain update inside its transaction — a CAS must never introduce a new
  throw AFTER an irreversible external money movement; pre-flight
  validation + provider idempotency govern that path.
- Workspace note: kits hoist at the `revenue-workspace` root
  (`revenue-manual` / `revenue-stripe` peer on revenue itself, not the
  kits).

## Changed — kit refresh (peer floors: mongokit >=3.22.0, repo-core >=0.13.0, primitives >=0.11.0)

- Verified against the mongokit 3.22 sweep and DELIBERATELY not migrated
  to `applyTransition`: revenue's transition pattern is more
  sophisticated than the boilerplate it absorbs — verbs validate the
  CURRENT status via the per-kind machine (`smFor(kind).validate`) and
  then CAS over a BROADER multi-source `from` array to allow idempotent
  re-entries (`matched → matched` re-match, unsettle no-ops), guarded by
  `where: { kind }`. `applyTransition` asserts EVERY source in a
  from-array, which would reject those re-entry shapes unless the machine
  tables were reworked. Payments semantics win; adoption would be a
  scoped design pass, not a sweep item.
- Workspace note: kits hoist at the `revenue-workspace` root
  (`revenue-manual` / `revenue-stripe` peer on revenue itself, not the
  kits); the workspace suite runs against 3.22/0.13.

## [Unreleased] → 2.7.0

### Fixed (behavioral) — 2026-07-05 addendum

- **Ghost-event publish under host sessions (§P8.1).** `dispatch` published
  regardless of `ctx.session`. Now: session + NO outbox throws the new
  `UnmanagedSessionError` (`revenue.session.unmanaged`); session + outbox is
  durable-relay-only (row joins the host tx, immediate publish skipped —
  the relay delivers post-commit).

### Changed — ISO 4217 currency gate via primitives (P1, 2026-07-04)

- Every zod currency validator (payment / settlement / subscription /
  transaction / bank-feed schemas + the revenue event catalog) replaced
  its hand-rolled `length(3)` / `min(3).max(3)` checks (which accepted
  lowercase `usd`) with `CURRENCY_PATTERN` from
  `@classytic/primitives/currency`. Primitives peer floor raised to
  `>=0.9.1`.

### Fixed — subscription period math via `@classytic/primitives/calendar`

- `subscription.activate` computed `endDate` with LOCAL `setMonth` /
  `setFullYear` / `setDate`: (1) the boundary silently shifted with the deploy
  machine's `TZ` env, and (2) month-ends overflowed — a Jan 31 monthly
  activation ended **Mar 2/3** instead of Feb 28/29. Now `addMonths` /
  `addYears` / `addDays` from `@classytic/primitives/calendar` (UTC-stable,
  month-end clamping). Primitives peer bumped to `>=0.9.0`.

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
