/**
 * Connect account inspection + management helpers beyond onboarding.
 *
 * Kept separate from `onboarding.ts` so the surface there stays
 * focused on the "first time" flow. These helpers cover login links,
 * delete (for test-mode cleanup), and balance inspection.
 */

import type Stripe from 'stripe';

/**
 * Mint a Stripe Express dashboard login link. Tenants click this to
 * see payouts / dispute / payment history in Stripe's hosted UI.
 *
 * Caveat: Stripe expires these in ~5 minutes; treat as ephemeral.
 */
export async function createLoginLink(
  stripe: Stripe,
  accountId: string,
): Promise<{ url: string; raw: Stripe.LoginLink }> {
  const link = await stripe.accounts.createLoginLink(accountId);
  return { url: link.url, raw: link };
}

/**
 * Fetch the connected account's available / pending balance.
 *
 * Use the `stripeAccount` request option to scope the call to the
 * connected account (otherwise we'd see the platform balance).
 */
export async function getAccountBalance(
  stripe: Stripe,
  accountId: string,
): Promise<Stripe.Balance> {
  // `stripeAccount` is a request-option (second arg) used to scope the
  // call to a connected account, not a body param.
  return stripe.balance.retrieve(undefined, { stripeAccount: accountId });
}

/**
 * Delete a Connect account. Only allowed for test-mode accounts or
 * accounts with no transactions. Useful in CI for tearing down test
 * tenants — production hosts should rarely call this.
 */
export async function deleteAccount(
  stripe: Stripe,
  accountId: string,
): Promise<{ deleted: boolean; id: string }> {
  const result = await stripe.accounts.del(accountId);
  return { deleted: result.deleted === true, id: result.id };
}