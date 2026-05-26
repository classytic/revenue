import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/saas/index.ts',
    'src/connect/index.ts',
    'src/checkout/index.ts',
    'src/webhooks/index.ts',
  ],
  format: 'esm',
  dts: true,
  sourcemap: false,
  minify: false,
  external: ['@classytic/revenue', '@classytic/primitives', 'stripe', 'nanoid'],
});