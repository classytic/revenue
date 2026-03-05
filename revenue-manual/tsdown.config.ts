import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  sourcemap: false,
  minify: false,
  external: ['@classytic/revenue', 'nanoid'],
});
