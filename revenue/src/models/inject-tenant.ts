import type { Schema } from 'mongoose';
import mongoose from 'mongoose';
import type { ResolvedTenantConfig } from '@classytic/repo-core/tenant';

/**
 * Inject the tenant field into a schema and (when `enabled`) prepend it
 * to every existing compound index.
 *
 * When `enabled: false` the field is still added (domain verbs reference
 * it in raw queries even without the multi-tenant plugin) — just without
 * `required`, without index prepend, and WITHOUT an index (nothing queries
 * a tenant field the host opted out of scoping — a bare index there is
 * pure write amplification).
 *
 * When `enabled: true`, the tenant does NOT get its own single-field
 * index either: the prepend below puts the tenant as the LEADING key of
 * every compound, and MongoDB serves prefix queries from a compound — a
 * bare `tenantField_1` next to `{tenant, status, createdAt}` is a
 * redundant prefix (2.8.1 fix; found by index-usage audit). Only when a
 * schema declares NO indexes to prepend does the tenant field get its own
 * index, so scoped list queries always have one to ride.
 *
 * The field storage type follows `scope.fieldType` (`'objectId'` →
 * `Schema.Types.ObjectId` + `ref`, `'string'` → `String`). No hardcoding
 * here — callers must pass a `ResolvedTenantConfig` from
 * `@classytic/repo-core/tenant` via `resolveTenantConfig(...)`.
 */
export function injectTenantField(schema: Schema, scope: ResolvedTenantConfig): void {
  schema.add({
    [scope.tenantField]: {
      type: scope.fieldType === 'objectId' ? mongoose.Schema.Types.ObjectId : String,
      ...(scope.required ? { required: true } : {}),
      ...(scope.fieldType === 'objectId' && scope.ref ? { ref: scope.ref } : {}),
    },
  });

  if (!scope.enabled) return;

  const existingIndexes = (
    schema as unknown as {
      _indexes: Array<[Record<string, unknown>, Record<string, unknown>]>;
    }
  )._indexes;
  if (existingIndexes && existingIndexes.length > 0) {
    for (const indexEntry of existingIndexes) {
      const fields = indexEntry[0];
      if (fields[scope.tenantField] !== undefined) continue;
      const newFields: Record<string, unknown> = { [scope.tenantField]: 1 };
      for (const [key, val] of Object.entries(fields)) {
        newFields[key] = val;
      }
      indexEntry[0] = newFields;
    }
  }

  // Guarantee at least one tenant-leading index. After the prepend, any
  // compound serves tenant-only queries via the prefix rule — a dedicated
  // single is only needed when the schema declared nothing to prepend.
  const hasTenantLeading = (existingIndexes ?? []).some(
    ([fields]) => Object.keys(fields)[0] === scope.tenantField,
  );
  if (!hasTenantLeading) {
    schema.index({ [scope.tenantField]: 1 } as Record<string, 1>);
  }
}
