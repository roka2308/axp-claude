import mysql from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '@axp/config';
import * as schema from './schema/index';

export type Database = MySql2Database<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: mysql.Pool;
  close(): Promise<void>;
}

export function createDatabase(config: AppConfig): DatabaseHandle {
  const pool = mysql.createPool({
    uri: config.database.url,
    connectionLimit: config.database.poolLimit,
    waitForConnections: true,
    // All instants are UTC (Master Spec §19). Pinning the connection time zone
    // keeps stored DATETIME values independent of the server's local setting.
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    enableKeepAlive: true,
    charset: 'utf8mb4_0900_ai_ci',
    // Multi-statement execution is a SQL-injection amplifier; migrations run
    // statements one by one instead.
    multipleStatements: false,
  });

  const db = drizzle(pool, { schema, mode: 'default', casing: 'snake_case' });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

export interface DatabaseHealth {
  readonly reachable: boolean;
  readonly latencyMs: number;
  /** Safe summary only - never a raw driver error. */
  readonly detail?: string;
}

/** Cheap readiness probe. Used by `/readyz`, never on a hot path. */
export async function checkDatabaseHealth(db: Database): Promise<DatabaseHealth> {
  const startedAt = performance.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { reachable: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: error instanceof Error ? error.name : 'unknown_error',
    };
  }
}
