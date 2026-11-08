import type { ProviderCapabilities } from '@classytic/primitives/payment-gateway';

export const SANDBOX_BASE_URL = 'https://tokenized.sandbox.bka.sh/v2/tokenized-checkout';
export const LIVE_BASE_URL = 'https://tokenized.pay.bka.sh/v2/tokenized-checkout';
export const BKASH_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  supportsConfirmation: true, supportsIdempotentCreate: false, supportsWebhooks: false,
  supportsRefunds: true, supportsPartialRefunds: true, requiresManualVerification: false,
});

export const ENDPOINTS = {
  grant: '/auth/grant-token', refresh: '/auth/refresh-token',
  create: '/payment/create', execute: '/payment/execute', query: '/query/payment',
  refund: '/refund/payment/transaction', refundStatus: '/refund/payment/status',
} as const;

export const REQUEST_TIMEOUT_MS = 30_000;
