import { defineConfig } from 'tsdown';

export default defineConfig({
  // Validate the PUBLISHED package shape (exports/main/types resolution against
  // the real dist) on every build. `true`, not 'ci-only': publishing happens from
  // a laptop via `prepublishOnly` -> `npm run build`, so a CI-only gate would never
  // run for the person actually publishing. publint errors set process.exitCode=1,
  // which fails the build.
  publint: true,
  entry: ['src/index.ts'],
  format: 'esm',
  // Declaration maps leak source too — tsconfig `declarationMap` is what tsdown
  // reads when `dts` is bare `true`, so state it HERE as well.
  dts: { sourcemap: false },
  sourcemap: false,
  // Without `clean`, artifacts from an earlier config (here: sourcemaps) survive
  // every subsequent build and keep shipping.
  clean: true,
  minify: false,
  external: ['@classytic/primitives'],
});
