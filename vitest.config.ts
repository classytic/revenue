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

