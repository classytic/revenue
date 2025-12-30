import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    // Core modules
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
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  treeshake: true,
  external: ['mongoose', 'nanoid', 'zod'],
  outDir: 'dist',
  target: 'node18',
  shims: false,
  banner: {
    js: '// @classytic/revenue - Enterprise Revenue Management System',
  },
});

