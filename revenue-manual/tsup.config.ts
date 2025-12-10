import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  treeshake: true,
  external: ['@classytic/revenue', 'nanoid'],
  outDir: 'dist',
  target: 'node18',
  shims: false,
  banner: {
    js: '// @classytic/revenue-manual - Manual Payment Provider',
  },
});

