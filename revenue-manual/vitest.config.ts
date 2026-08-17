import { defineConfig } from 'vitest/config';

/**
 * `tests/manual-status.test.ts` existed with NO runner: no vitest dependency, no
 * config, and no `test` script. So the assertion it carries -- that a stateless
 * provider REFUSES to report `succeeded` for a payment it holds no record of -- had
 * never executed. That is a documented money-safety fix (AGENTS.md FAIL LOUD rule 3)
 * guarded by a file nothing ran.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
