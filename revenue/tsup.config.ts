import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    // Core modules
    'src/core/index.ts',
    'src/enums/index.ts',
    'src/schemas/index.ts',
    'src/utils/index.ts',
    'src/providers/index.ts',
    'src/services/index.ts',
    // New validation schemas
    'src/schemas/validation.ts',
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

