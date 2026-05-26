# Changelog

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