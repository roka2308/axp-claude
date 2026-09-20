import { defineConfig } from 'drizzle-kit';
import { loadConfig } from '@axp/config';

const config = loadConfig();

export default defineConfig({
  dialect: 'mysql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: config.database.url },
  // Must match the runtime client in src/client.ts, otherwise generated SQL and
  // the queries the application issues would disagree on column names.
  casing: 'snake_case',
  // Deterministic, repo-versioned migrations (Master Spec §25). Never push
  // schema changes straight into a database.
  strict: true,
  verbose: true,
});
