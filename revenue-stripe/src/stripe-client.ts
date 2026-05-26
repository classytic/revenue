/**
 * Stripe SDK client factory.
 *
 * Centralises construction so the provider can accept either a raw
 * secret key (the 99% case) or an already-built client (tests, hosts
 * that share a single SDK instance across multiple integrations).
 */

import Stripe from 'stripe';
import type { StripeConnectProviderConfig } from './types.js';

/**
 * Build (or pass through) the Stripe SDK client. Tests pass `stripe`
 * directly with their mock; runtime callers pass `secretKey`.
 *
 * @throws Error when neither `stripe` nor `secretKey` are supplied.
 */
export function createStripeClient(config: StripeConnectProviderConfig): Stripe {
  if (config.stripe) return config.stripe;
  if (!config.secretKey) {
    throw new Error(
      '[revenue-stripe] config.secretKey is required when no `stripe` client is provided',
    );
  }
  // Stripe SDK config type lives outside the `Stripe` namespace
  // (in `./lib.js`), so we type the literal locally rather than
  // importing through a brittle deep path.
  const opts: Record<string, unknown> = {
    typescript: true,
    appInfo: {
      name: '@classytic/revenue-stripe',
      version: '0.1.0',
      url: 'https://github.com/classytic/revenue',
    },
  };
  if (config.apiVersion) opts.apiVersion = config.apiVersion;
  return new Stripe(config.secretKey, opts);
}