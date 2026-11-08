# @classytic/revenue-bd

Bangladesh payment adapters implementing `PaymentProviderPort` from `@classytic/primitives/payment-gateway`. Import the provider you use; there is no root barrel or automatic registration.

```ts
import { BkashProvider, createBkashTokenSource } from '@classytic/revenue-bd/bkash';
```

Only `/bkash` is implemented. Nagad and BD method/profile factories are future entries, not stub exports. This package does not depend on Arc, Mongoose or the Revenue engine.

## bKash

The adapter targets **Tokenized Checkout v2 without agreement**, documented at [Create Payment](https://developer.bka.sh/docs/create-payment-3), [Execute Payment](https://developer.bka.sh/docs/execute-payment-4), [Query Payment](https://developer.bka.sh/docs/query-payment), [Refund](https://developer.bka.sh/docs/refund) and [Refund Status](https://developer.bka.sh/docs/refund-status), inspected 2026-11-01. Do not use it with a v1 merchant integration. Merchant-specific sandbox verification is still required.

Configure the server with an app key, a token source and a fixed callback URL. The default endpoint is the documented v2 sandbox. Production requires the merchant-approved v2 base URL. API and hosted-checkout origins are validated; credential-bearing requests do not follow redirects.

`createBkashTokenSource` uses [Grant Token](https://developer.bka.sh/docs/grant-token) initially and [Refresh Token](https://developer.bka.sh/docs/refresh-token) before expiry. Supply a `BkashTokenStore` with encrypted persistence and a distributed `exclusive` lock scoped to the merchant account and environment. Tokens must survive restarts and be shared by replicas: the documented grant limit is two calls per hour. There is deliberately no default in-memory production store or automatic grant fallback after an ambiguous refresh failure. The store and source must belong to the same app key/account. A custom token source can integrate an existing credential manager.

Register `BkashProvider` with Revenue and authorize browser returns through `transaction.confirmReturn`. Create returns a **server-only** `returnProof`: Revenue stores its digest and expiry on the existing attempt before exposing checkout. Never spread the raw adapter intent into a client response. The proof authorizes an execution request; the provider result still determines whether payment succeeded. Confirmation requires a transactional outbox and a replica set. `confirmPayment` is a low-level mutating adapter method; calling it directly does not supply engine-level deduplication. `verifyPayment` and `getStatus` only query. A payment ID is single-use for execution according to the v2 guide; query after uncertainty and never blindly execute again. Same-reference create calls are not claimed to be idempotent.

The browser return is not the generic webhook transport. This adapter rejects webhook signatures and payloads. The shared return flow must persist/validate the provider's creation-time callback signature and its own order/account correlation before authorizing execution; this transport is not implemented by this package. A callback status is never payment evidence.

Amounts are BDT integer minor units at the port, exact decimal strings at the gateway. Unknown or malformed native statuses remain unavailable. Responses expose only normalized money, references and safe native status; payer account and raw gateway/auth responses are not returned or logged.

The documented execution error `2023` is normalized as an insufficient-funds decline. The same code on a read is not evidence that the original payment failed. Other unmapped responses remain unknown. Operator reject/void cannot decide this provider's payment outcome; reconcile it or refund a verified collection.

Refunds query the original payment and its coupon-adjusted refundable limit first. Refund status resolves only an exact known refund reference. The documented refund-history shape has no command/SKU field, so a lost response without a refund reference remains unresolved for operator reconciliation. Matching by amount or timestamp alone is not proof. Revenue retains the reservation instead of issuing another refund. Payment acceptance does not implement payouts, recurring agreements or auth/capture.

## Development

Use Node 22.18+ (or supported Node 24) and local primitives artifacts. Build with pinned tsdown 0.23.4. Run `typecheck`, `test`, `build` and `check:bundle`; the latter bundles a consumer and checks that unused token-source code, other providers and engine dependencies are absent. Peer dependencies remain external. Publish only after workspace/consumer and merchant sandbox gates pass.

Provider folders are independent modules within one versioned distribution. Shared releases and package-wide installed dependencies are the tradeoff for fewer packages. Keep protocol clients and endpoint paths private; expose another subpath only when its implementation exists.

`createBkashTokenStore(slot)` adapts an encrypted string-map slot with `get`, `set` and distributed `exclusive` operations. The persistence owner supplies encryption and lease fencing. `BKASH_CAPABILITIES`, `SANDBOX_BASE_URL` and `LIVE_BASE_URL` support explicit composition without constructing a credentialed provider to discover its capabilities.

## Browser return composition

`callbackUrl` must point to the application's dedicated return landing page. The shared Spine exchange is **POST**, not the provider's browser GET callback. The page must set `Referrer-Policy: no-referrer`/no-store, avoid analytics and third-party resources, remove the query from browser history, then post normalized `paymentId` (bKash `paymentID`), `token` (bKash `signature`) and `status` to the allowlisted Spine endpoint. Query-string status is never proof of payment. The signature does not cryptographically distinguish success, failure and cancellation; actual capture must be verified by the execute/query result.

Do not enable the checkout until the landing page, order/obligation linkage, encrypted token store and durable outcome consumers are composed and merchant sandbox acceptance passes.

Before first execution, the return command queries readiness and correlates amount/currency/reference. The bKash adapter also re-queries immediately before execution: it requires the documented `verificationStatus: Complete` on an Initiated payment, or returns an already Completed observation without executing again. Missing/incomplete approval is never inferred from the callback status. Query errors are not execution declines. Merchant sandbox tests must verify these exact approval states and race behavior.
