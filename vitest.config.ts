import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@classytic/revenue/core': path.resolve(__dirname, 'revenue/src/core/index.ts'),
      '@classytic/revenue/enums': path.resolve(__dirname, 'revenue/src/enums/index.ts'),
      '@classytic/revenue/events': path.resolve(__dirname, 'revenue/src/core/events.ts'),
      '@classytic/revenue/plugins': path.resolve(__dirname, 'revenue/src/infrastructure/plugins/index.ts'),
      '@classytic/revenue/providers': path.resolve(__dirname, 'revenue/src/providers/index.ts'),
      '@classytic/revenue/reconciliation': path.resolve(__dirname, 'revenue/src/reconciliation/index.ts'),
      '@classytic/revenue/schemas/validation': path.resolve(__dirname, 'revenue/src/schemas/validation.ts'),
      '@classytic/revenue/schemas': path.resolve(__dirname, 'revenue/src/schemas/index.ts'),
      '@classytic/revenue/services': path.resolve(__dirname, 'revenue/src/application/services/index.ts'),
      '@classytic/revenue/utils': path.resolve(__dirname, 'revenue/src/utils/index.ts'),
      '@classytic/revenue': path.resolve(__dirname, 'revenue/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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

