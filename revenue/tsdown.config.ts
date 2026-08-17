import { defineConfig } from 'tsdown';

export default defineConfig({
  // Validate the PUBLISHED package shape (exports/main/types resolution against
  // the real dist) on every build. `true`, not 'ci-only': publishing happens from
  // a laptop via `prepublishOnly` -> `npm run build`, so a CI-only gate would never
  // run for the person actually publishing. publint errors set process.exitCode=1,
  // which fails the build.
  publint: true,
  entry: [
    'src/index.ts',
    'src/enums/index.ts',
    'src/events/index.ts',
    'src/validators/index.ts',
    'src/providers/index.ts',
    'src/bridges/index.ts',
    'src/repositories/create-repositories.ts',
    'src/shared/index.ts',
    'src/core/state-machines.ts',
    'src/plugins/plugin.interface.ts',
  ],
  format: 'esm',
  dts: {
    sourcemap: false,
  },
  clean: true,
  sourcemap: false,
  minify: false,
  deps: {
    neverBundle: ['mongoose', 'zod', /^@classytic\//],
  },
});
