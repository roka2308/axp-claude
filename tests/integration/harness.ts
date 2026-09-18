import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import type { RowDataPacket } from 'mysql2';
import { type AppConfig, loadConfig } from '@axp/config';
import { createDatabase, type DatabaseHandle } from '@axp/db';
import { createLogger, type Logger } from '@axp/observability';
import { type Container, createContainer, fixedClock } from '@axp/core';

/**
 * Integration test harness.
 *
 * These tests run against real MySQL, because the behaviour they verify -
 * transactional bootstrap, uniqueness, `FOR UPDATE` serialisation, cascade
 * rules - does not exist in a fake. The database comes from the docker stack
 * and is a separate schema (`axp_test`) from development data.
 *
 * Time is supplied by a fixed clock so expiry and lockout windows can be
 * exercised without sleeping.
 */

export const TEST_NOW = new Date('2026-09-18T10:00:00.000Z');

export interface TestContext {
  readonly container: Container;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: ReturnType<typeof fixedClock>;
  readonly handle: DatabaseHandle;
}

let sharedHandle: DatabaseHandle | undefined;
let migrated = false;

function testConfig(): AppConfig {
  const config = loadConfig();
  if (!config.database.url.includes('test')) {
    // A misconfigured TEST_DATABASE_URL would truncate a development database.
    throw new Error(
      `Refusing to run integration tests against ${config.database.url.replace(/\/\/[^@]*@/, '//***@')}: ` +
        'the database name must contain "test". Set TEST_DATABASE_URL.',
    );
  }
  return config;
}

/** Opens the shared pool and applies migrations once per test run. */
export async function setupDatabase(): Promise<DatabaseHandle> {
  const config = testConfig();
  sharedHandle ??= createDatabase(config);

  if (!migrated) {
    await migrate(sharedHandle.db, {
      migrationsFolder: path.resolve('packages/db/migrations'),
    });
    migrated = true;
  }

  return sharedHandle;
}

export async function createTestContext(): Promise<TestContext> {
  const config = testConfig();
  const handle = await setupDatabase();
  const clock = fixedClock(TEST_NOW);
  const logger = createLogger({
    level: 'silent' as never,
    format: 'json',
    service: 'integration-test',
    version: '0.0.0-test',
    appEnv: 'test',
  });

  const container = createContainer({ config, logger, clock, databaseHandle: handle });
  return { container, config, logger, clock, handle };
}

/**
 * Empties every table between test cases.
 *
 * TRUNCATE rather than DELETE so auto-increment state and page allocation reset
 * too; foreign key checks are disabled for the duration because the tables form
 * a cycle-free but order-dependent graph.
 */
export async function resetDatabase(): Promise<void> {
  const handle = await setupDatabase();
  const [rows] = await handle.pool.query<RowDataPacket[]>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '__drizzle_migrations'",
  );

  await handle.db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const row of rows) {
    await handle.db.execute(sql.raw(`TRUNCATE TABLE \`${String(row.TABLE_NAME)}\``));
  }
  await handle.db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

export async function closeDatabase(): Promise<void> {
  if (sharedHandle) {
    await sharedHandle.close();
    sharedHandle = undefined;
    migrated = false;
  }
}

/** Lists the tables that currently exist, for schema assertions. */
export async function listTables(): Promise<string[]> {
  const handle = await setupDatabase();
  const [rows] = await handle.pool.query<RowDataPacket[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  );
  return rows.map((row) => String(row.TABLE_NAME)).sort();
}

/** Lists the columns of a table, for persistence-rule assertions. */
export async function listColumns(table: string): Promise<string[]> {
  const handle = await setupDatabase();
  const [rows] = await handle.pool.query<RowDataPacket[]>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table],
  );
  return rows.map((row) => String(row.COLUMN_NAME)).sort();
}

export const STRONG_TEST_PASSWORD = 'korrekt-pferd-batterie-heftklammer';
