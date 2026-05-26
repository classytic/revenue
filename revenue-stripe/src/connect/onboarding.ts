/**
 * Stripe Connect Express onboarding helpers.
 *
 * Flow:
 *  1. Host calls {@link createExpressAccount} → stores the returned
 *     `accountId` on its tenant-config doc.
 *  2. Host calls {@link createAccountLink} → redirects the founder to
 *     Stripe's hosted KYC.
 *  3. On return, host calls {@link getAccountStatus} to learn if
 *     `chargesEnabled` / `payoutsEnabled` so it can flip the tenant to
 *     "ready to accept payments".
 *
 * These are stateless utilities — the provider class doesn't need to
 * know about them, but exports them via `index.ts` for host code.
 */

import type Stripe from 'stripe';

export interface CreateAccountInput {
  /** Host-side tenant id — round-tripped via Stripe `metadata.tenantOrgId`. */
  tenantOrgId: string;
  /** ISO 3166-1 alpha-2 country code (Stripe requirement). Default `'US'`. */
  country?: string;
  /** Founder email. Stripe pre-fills the KYC form with this. */
  email: string;
  /** Legal business name (optional — founder can fill in onboarding). */
  businessName?: string;
  /** Additional capabilities to request. Default `card_payments` + `transfers`. */
  capabilities?: Stripe.AccountCreateParams.Capabilities;
  /** Pass-through metadata merged with `{ tenantOrgId }`. */
  metadata?: Record<string, string>;
}

export interface CreateAccountResult {
  accountId: string;
  raw: Stripe.Account;
}

/**
 * Create a Stripe Connect Express account for a tenant. Persist the
 * returned `accountId` on the tenant-config; it's the destination for
 * every future `transfer_data.destination`.
 */
export async function createExpressAccount(
  stripe: Stripe,
  input: CreateAccountInput,
): Promise<CreateAccountResult> {
  const account = await stripe.accounts.create({
    type: 'express',
    country: input.country ?? 'US',
    email: input.email,
    business_profile: input.businessName ? { name: input.businessName } : undefined,
    capabilities: input.capabilities ?? {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { tenantOrgId: input.tenantOrgId, ...(input.metadata ?? {}) },
  });
  return { accountId: account.id, raw: account };
}

export interface CreateAccountLinkInput {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
  /** `'account_onboarding'` (KYC) or `'account_update'` (re-verification). */
  type?: 'account_onboarding' | 'account_update';
}

export interface CreateAccountLinkResult {
  url: string;
  expiresAt: number;
  raw: Stripe.AccountLink;
}

/**
 * Mint a Stripe-hosted onboarding URL. Short-lived (Stripe expires
 * these in minutes), so call this on demand from the host route.
 */
export async function createAccountLink(
  stripe: Stripe,
  args: CreateAccountLinkInput,
): Promise<CreateAccountLinkResult> {
  const link = await stripe.accountLinks.create({
    account: args.accountId,
    refresh_url: args.refreshUrl,
    return_url: args.returnUrl,
    type: args.type ?? 'account_onboarding',
  });
  return { url: link.url, expiresAt: link.expires_at, raw: link };
}

export interface AccountStatus {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** `'pending'` | `'enabled'` | `'restricted'` | other Stripe states. */
  capabilitiesStatus: Record<string, Stripe.Account.Capabilities[keyof Stripe.Account.Capabilities]>;
  /** Currently required onboarding fields, if any. */
  requirementsCurrentlyDue: string[];
  raw: Stripe.Account;
}

/**
 * Inspect a Connect account's onboarding/KYC state. Host calls this
 * after `return_url` redirect to decide if the tenant can accept
 * charges yet.
 */
export async function getAccountStatus(
  stripe: Stripe,
  accountId: string,
): Promise<AccountStatus> {
  const account = await stripe.accounts.retrieve(accountId);
  const caps = (account.capabilities ?? {}) as Record<
    string,
    Stripe.Account.Capabilities[keyof Stripe.Account.Capabilities]
  >;
  return {
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    capabilitiesStatus: caps,
    requirementsCurrentlyDue: account.requirements?.currently_due ?? [],
    raw: account,
  };
}