import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'bkash/index': 'src/bkash/index.ts' },
  format: 'esm',
  outExtensions: () => ({ js: '.mjs', dts: '.d.mts' }),
  dts: true,
  clean: true,
  publint: true,
  deps: { neverBundle: [/^@classytic\//, /^node:/] },
});
