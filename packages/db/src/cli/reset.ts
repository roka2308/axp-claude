import type { RowDataPacket } from 'mysql2';
import { sql } from 'drizzle-orm';
import { loadConfig } from '@axp/config';
import { createDatabase } from '../client';

/**
 * Drops every table in the configured database.
 *
 * Development and test convenience only. Refuses to run against a production
 * APP_ENV so a mistyped environment cannot wipe a real product store.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.appEnv === 'production' || config.appEnv === 'staging') {
    throw new Error(`db:reset is refused for APP_ENV=${config.appEnv}.`);
  }

  const handle = createDatabase(config);
  try {
    const [rows] = await handle.pool.query<RowDataPacket[]>(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    );
    const tables = rows.map((row) => String(row.TABLE_NAME));
    if (tables.length === 0) {
      console.log('Database already empty.');
      return;
    }

    await handle.db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    for (const table of tables) {
      await handle.db.execute(sql.raw(`DROP TABLE IF EXISTS \`${table}\``));
    }
    await handle.db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
    console.log(`Dropped ${tables.length} table(s).`);
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('Reset failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
