# Changelog

## 0.2.0 - 2026-08-18

Catches this package up to the payment-gateway port it implements. Pre-1.0, so
the break lands in a minor.

### Breaking — the command context reaches every provider call

- **`refund(paymentId, amount, command, options?)`** — `PaymentCommandContext`
  is now the third argument, matching
  `@classytic/primitives/payment-gateway`. `createIntent` / `verifyPayment`
  take it too. 0.1.1 predates the port change and its `refund` was
  `(paymentId, amount?, options?)`, so pairing it with `@classytic/revenue`
  >=2.9.0 handed the command context to the slot that expected Stripe refund
  options — a mismatch TypeScript caught at the seam and that would have
  misbehaved at runtime.

- **`@classytic/revenue >=2.9.0` is now a declared peer.** It was absent
  entirely, which is why the 0.1.1-with-2.9.0 combination installed cleanly and
  broke later. `@classytic/revenue-manual` already declared it; this package
  simply had not. The contract itself lives in `@classytic/primitives`
  (`>=0.23.0`, unchanged) — the revenue peer records which registry the
  provider plugs into.

### Added

- **`getRefundStatus`** — resolves a refund whose create response was lost.
  Retrieves by `refundRef` when known, otherwise matches the stamped command
  ref among the intent's refunds, so a dropped connection mid-refund is
  recoverable instead of ambiguous. A deterministic reference derived from the
  refund command's idempotency key is stamped into Stripe metadata at create
  time to make that lookup possible.

### Changed

- **License:** relicensed from MIT to the **Classytic Source-Available License**
  (Community & Commercial). Evaluation/development use remains free; production
  use now requires a commercial license from Classytic LLC. See `LICENSE`.
  Versions published before 0.2.0 — 0.1.0 and 0.1.1 — remain under their
  original MIT terms.

## 0.1.0 — 2026-05-19

Initial release.

- `StripeConnectProvider` implementing `PaymentProvider` contract from `@classytic/revenue`.
- Stripe Payment Intents for `createIntent` / `verifyPayment` / `getStatus`.
- Refunds via `stripe.refunds.create`.
- Webhook router with HMAC signature verification (`stripe.webhooks.constructEvent`).
- Connect Express onboarding helpers (`createExpressAccount`, `createAccountLink`, `getAccountStatus`).
- Payment Link generator for AI-driven flows (`generatePaymentLink`).
- Stripe Subscriptions wrapper for recurring services.
- Vitest unit tests with mocked Stripe SDK; integration tests guarded by `STRIPE_TEST_SECRET`.