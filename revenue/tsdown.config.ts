import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/core/index.ts',
    'src/core/events.ts',
    'src/enums/index.ts',
    'src/infrastructure/plugins/index.ts',
    'src/reconciliation/index.ts',
    'src/schemas/index.ts',
    'src/schemas/validation.ts',
    'src/utils/index.ts',
    'src/providers/index.ts',
    'src/application/services/index.ts',
  ],
  format: 'esm',
  dts: {
    sourcemap: false,
  },
  clean: true,
  sourcemap: false,
  minify: false,
  external: ['mongoose', 'nanoid', 'zod', 'bson', '@classytic/shared-types'],
});
