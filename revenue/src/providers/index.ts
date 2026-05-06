// Revenue owns only the abstract `PaymentProvider` contract + the registry.
// Payment-gateway data shapes (`CreateIntentParams`, `PaymentIntent`,
// `PaymentResult`, `RefundResult`, `WebhookEvent`, `ProviderCapabilities`)
// live in `@classytic/primitives/payment-gateway`. Hosts MUST import
// them from primitives directly — no re-exports per PACKAGE_RULES P2.
//
//   import type {
//     CreateIntentParams, PaymentIntent, PaymentResult,
//     RefundResult, WebhookEvent, ProviderCapabilities,
//   } from '@classytic/primitives/payment-gateway';
export { PaymentProvider } from './base.js';
export { ProviderRegistry, createProviderRegistry } from './registry.js';
export {
  BankFeedProvider,
  BankFeedProviderRegistry,
  createBankFeedProviderRegistry,
  type BankFeedProviderCapabilities,
  type FetchTransactionsParams,
  type FetchTransactionsResult,
  type ParseUploadParams,
  type ParseUploadResult,
} from './bank-feed.js';

// Canonical bank-transaction shapes are owned by `@classytic/primitives`
// (see /bank-transaction subpath). No re-export here — hosts import
// from primitives directly to keep the dep graph + tree-shake honest.
// PACKAGE_RULES P2.
