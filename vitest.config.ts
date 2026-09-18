import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = {
  '@axp/contracts': path.resolve('./packages/contracts/src/index.ts'),
  '@axp/config': path.resolve('./packages/config/src/index.ts'),
  '@axp/observability': path.resolve('./packages/observability/src/index.ts'),
  '@axp/db': path.resolve('./packages/db/src/index.ts'),
  '@axp/core': path.resolve('./packages/core/src/index.ts'),
  '@axp/fixtures': path.resolve('./packages/fixtures/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        // Fast, hermetic tests. No database, no network, no filesystem writes.
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        // Tests that exercise real MySQL behaviour: migrations, transactions,
        // uniqueness and cross-tenant authorization. They need the docker stack.
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          // Argon2 hashing and migrations make these slower than unit tests.
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // One database, so cases must not race each other.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      exclude: ['**/dist/**', '**/*.config.*', '**/cli/**', 'tests/**'],
    },
  },
});
