import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { loadConfig } from '@axp/config';
import { createDatabase } from '../client';

/**
 * Applies pending migrations.
 *
 * Migrations are deterministic, repo-versioned and forward-only (Master Spec
 * §25). There are deliberately no DOWN migrations: rolling a schema backwards
 * in place is not a supported operation.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const migrationsFolder = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../migrations',
  );
  const handle = createDatabase(config);

  const redactedTarget = config.database.url.replace(/\/\/[^@]*@/, '//***@');
  console.log(`Applying migrations to ${redactedTarget}`);

  try {
    await migrate(handle.db, { migrationsFolder });
    console.log('Migrations applied.');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  // DDL is not transactional in MySQL: a partially applied migration leaves
  // tables behind, and the driver's own message is what says which statement
  // actually refused. Without it the next run only reports "table exists".
  const cause = (error as { cause?: unknown })?.cause;
  if (cause instanceof Error) console.error('Cause:', cause.message);
  process.exitCode = 1;
});
