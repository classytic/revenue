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
   * When `true`, the `multiTenantPlugin` wired by `createRevenue` skips
   * injecting the tenant filter/data field for this single call — so
   * `repo.getAll({}, { _bypassTenant: true })` can span organizations for
   * superadmin dashboards, audits, and cross-branch reports.
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
