import { sql } from 'drizzle-orm';
import { char, index, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { PLATFORM_INIT_STATES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';

/**
 * Secure initial bootstrap (Master Spec §6, Gap Review G4).
 *
 * A single row holds the persistent initialization state. There are no default
 * accounts and no default passwords; the setup path closes permanently once
 * `init_state` reaches `initialized` and a missing platform admin never
 * reopens it - that is what the separate break-glass path is for.
 */
export const platformState = mysqlTable('platform_state', {
  // Fixed to 'singleton' so a second row cannot exist.
  id: varchar({ length: 16 }).primaryKey(),
  initState: mysqlEnum('init_state', PLATFORM_INIT_STATES).notNull().default('uninitialized'),
  initializedAt: utcTimestamp(),
  initializedByUserId: char({ length: 36 }),
  /** Schema version the store was last migrated to; surfaced in diagnostics. */
  schemaVersion: varchar('schema_version', { length: 32 }).notNull().default('1'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const PLATFORM_STATE_ID = 'singleton';

export const BOOTSTRAP_TOKEN_PURPOSES = ['initial_bootstrap', 'break_glass_recovery'] as const;

/**
 * One-time, short-lived, cryptographically secure activation tokens.
 *
 * Only a hash is stored: a database read must never yield a usable token.
 * Consumed tokens are kept (without the secret) so the audit trail shows that
 * exactly one bootstrap happened.
 */
export const bootstrapTokens = mysqlTable(
  'bootstrap_tokens',
  {
    id: idColumn().primaryKey(),
    purpose: mysqlEnum(BOOTSTRAP_TOKEN_PURPOSES).notNull(),
    /** SHA-256 of the token, hex encoded. Never the token itself. */
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: utcTimestamp().notNull(),
    consumedAt: utcTimestamp(),
    consumedByUserId: char('consumed_by_user_id', { length: 36 }),
    /** Free-form note such as the operator who requested break-glass access. */
    requestedBy: varchar('requested_by', { length: 255 }),
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_bootstrap_tokens_expires').on(table.expiresAt),
    index('idx_bootstrap_tokens_purpose').on(table.purpose, table.consumedAt),
  ],
);

/** Convenience for `WHERE consumed_at IS NULL AND expires_at > NOW(3)`. */
export const bootstrapTokenUsable = sql`consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)`;
