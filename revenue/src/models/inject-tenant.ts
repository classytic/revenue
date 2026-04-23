import type { Schema } from 'mongoose';
import mongoose from 'mongoose';
import type { ResolvedTenantConfig } from '@classytic/primitives/tenant';

/**
 * Inject the tenant field into a schema and (when `enabled`) prepend it
 * to every existing compound index.
 *
 * When `enabled: false` the field is still added (domain verbs reference
 * it in raw queries even without the multi-tenant plugin) — just without
 * `required` and without index prepend.
 *
 * The field storage type follows `scope.fieldType` (`'objectId'` →
 * `Schema.Types.ObjectId` + `ref`, `'string'` → `String`). No hardcoding
 * here — callers must pass a `ResolvedTenantConfig` from
 * `@classytic/primitives/tenant` via `resolveTenantConfig(...)`.
 */
export function injectTenantField(schema: Schema, scope: ResolvedTenantConfig): void {
  schema.add({
    [scope.tenantField]: {
      type: scope.fieldType === 'objectId' ? mongoose.Schema.Types.ObjectId : String,
      ...(scope.required ? { required: true } : {}),
      index: true,
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
}
