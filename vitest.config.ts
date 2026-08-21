import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@classytic/revenue/enums': path.resolve(__dirname, 'revenue/src/enums/index.ts'),
      '@classytic/revenue/events': path.resolve(__dirname, 'revenue/src/events/index.ts'),
      '@classytic/revenue/providers': path.resolve(__dirname, 'revenue/src/providers/index.ts'),
      '@classytic/revenue/bridges': path.resolve(__dirname, 'revenue/src/bridges/index.ts'),
      '@classytic/revenue': path.resolve(__dirname, 'revenue/src/index.ts'),
      '@classytic/revenue-manual': path.resolve(__dirname, 'revenue-manual/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    /**
     * BOTH the workspace suite and each sub-package's own tests.
     *
     * `tests/**` alone resolves from this directory, so the 12 test files under
     * `revenue/tests`, `revenue-manual/tests` and `revenue-stripe/tests` were never
     * collected — `port-boundary`, `provider-registry`, `command-context`,
     * `execute-command` and the audit-trail integration among them. `npm test`
     * reported a confident 434/434 while the payment kernel's own contract tests
     * had not executed at all. A suite that cannot see a file cannot fail for it.
     */
    include: ['tests/**/*.test.ts', '*/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/examples/**',
        '**/provider-patterns/**',
        '**/docs/**',
        '**/*.d.ts',
      ],
    },
  },
});

