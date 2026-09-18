import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@axp\//],
  external: ['@node-rs/argon2', 'mysql2', 'pino', 'pino-pretty'],
});
