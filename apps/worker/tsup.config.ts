import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  /**
   * Bundle the workspace packages, because they ship TypeScript sources that
   * Node cannot execute, and keep every third-party import external.
   *
   * The negative lookahead covers transitive dependencies too. Pulling a
   * CommonJS package such as dotenv into an ESM bundle turns its `require()`
   * calls into a dynamic require, which fails at runtime - so the rule is
   * "bundle ours, load theirs" rather than a list that drifts.
   */
  noExternal: [/^@axp\//],
  external: [/^(?!@axp\/|\.{1,2}\/|\/)/],
});
