import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/db/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Use the injected Clock (@axp/core) instead of new Date() so time behaviour stays testable.',
        },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Architecture boundary: the browser-facing app must never reach into the
    // persistence or domain layer directly. It talks to the API over HTTP only.
    // See docs/adr/0001-modular-monolith-three-processes.md
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@axp/db',
              message:
                'apps/web must not access the database directly. Call the API (apps/api) instead.',
            },
            {
              name: '@axp/core',
              message:
                'apps/web must not import domain logic directly. Call the API (apps/api) instead.',
            },
          ],
          patterns: ['@axp/db/*', '@axp/core/*', 'mysql2*', 'drizzle-orm*'],
        },
      ],
    },
  },
  {
    // CLI entry points are allowed to write to stdout.
    files: ['**/cli/**/*.ts', '**/scripts/**/*.ts', '**/*.config.{ts,js,mjs}'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
