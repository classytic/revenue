/**
 * Tenant injection for the revenue kernel is `@classytic/mongokit/tenant`'s.
 *
 * This file was the reference copy the other kernels were told to clone (rule P11,
 * "copy from `@classytic/revenue` >= 2.8.1"), and cloning is how 38 of them drifted.
 * The shared implementation keeps everything this copy did, exempts TTL indexes from
 * the prepend (which this copy did not), and honours `IndexDeclaration.scope`: a host's
 * `extraIndexes` used to be applied BEFORE the prepend, so a host could never declare
 * an unscoped index at all, while the kernel's own global indexes (`gateway.sessionId`,
 * `idempotencyKey`, `publicId`) were declared by hand AFTER the call, an ordering rule
 * that lived only in a comment. Re-exported so the model factory's import path is
 * unchanged.
 */
export {
  assertIndexDeclaration,
  injectTenantField,
  type IndexDeclaration,
  type IndexScope,
  type InjectTenantFieldOptions,
} from '@classytic/mongokit/tenant';
