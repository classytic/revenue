/**
 * Revenue request-scoped context.
 *
 * Extends `@classytic/primitives`' {@link OperationContext} so identity +
 * tracing fields (`actorId`, `organizationId`, `traceId`, `correlationId`,
 * `requestId`, `idempotencyKey`, `session`, `metadata`) stay uniform with
 * every other Classytic package. Revenue-specific additions: `roles`,
 * `currency`, `custom`.
 */
import type { OperationContext } from '@classytic/primitives/context';

export interface RevenueContext extends OperationContext {
  /** Narrowed from primitives' `IdLike` to string. */
  organizationId?: string;
  /** Narrowed from primitives' `IdLike` to string. */
  actorId?: string;
  /** Actor roles for permission checks at the consumer level. */
  roles?: string[];
  /** Override currency for this operation. */
  currency?: string;
  /** Bridge-specific free-form context. */
  custom?: Record<string, unknown>;
  /**
   * Platform-admin bypass for tenant scoping.
   *
   * A caller-facing convenience that maps to mongokit's canonical per-call escape
   * hatch: `optsFromCtx` translates `ctx._bypassTenant === true` to `bypassTenant: true`
   * in the options bag, which the `multiTenantPlugin` wired by `defineRevenue` honors
   * natively (skipping tenant filter/data injection for that single call, and emitting an
   * `after:tenant-bypass` audit event) — so a superadmin dashboard, audit, or cross-branch
   * report can span organizations. Trusted maintenance code may instead pass mongokit's
   * `systemContext()` (which IS `{ bypassTenant: true }`) directly.
   *
   * **The repo does NOT authorize this flag.** Setting it is the caller's
   * responsibility and MUST be gated behind a platform-role check at the
   * route/service layer. Never forward this flag from untrusted input.
   *
   * Events, validation, soft-delete, and pagination all continue to fire —
   * only the tenant policy is bypassed. Write paths (create/update/delete)
   * still pick up `organizationId` from `ctx.organizationId` if provided,
   * so cross-org mutations require an explicit per-doc tenant in `data`.
   */
  _bypassTenant?: boolean;
}
