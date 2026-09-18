import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/cli/bootstrap-admin.ts', 'src/cli/recover-admin.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace packages are bundled so the deployed artifact is self-contained;
  // native and heavy runtime deps stay external.
  noExternal: [/^@axp\//],
  external: ['@node-rs/argon2', 'mysql2', 'pino', 'pino-pretty', 'fastify'],
});
