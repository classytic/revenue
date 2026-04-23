import { defineConfig } from 'tsdown';

export default defineConfig({
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
