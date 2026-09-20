import {
  char,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { AUTH_PROVIDER_TYPES, SUPPORTED_LOCALES, USER_STATUSES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';

/**
 * Identity is separate from authentication (Master Spec §6).
 *
 * `id` is the primary key; email is mutable and only uniquely indexed so two
 * accounts cannot claim the same address. Normal admin flows deactivate rather
 * than hard delete.
 */
export const users = mysqlTable(
  'users',
  {
    id: idColumn().primaryKey(),
    email: varchar({ length: 320 }).notNull(),
    /** Lowercased email for case-insensitive lookup and uniqueness. */
    emailNormalized: varchar('email_normalized', { length: 320 }).notNull(),
    emailVerifiedAt: utcTimestamp(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    status: mysqlEnum(USER_STATUSES).notNull().default('invited'),
    locale: mysqlEnum(SUPPORTED_LOCALES).notNull().default('de'),
    lastLoginAt: utcTimestamp(),
    deactivatedAt: utcTimestamp(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_users_email_normalized').on(table.emailNormalized),
    index('idx_users_status').on(table.status),
  ],
);

/**
 * Link between a user and an authentication provider.
 *
 * `password_hash` is only populated for `local`. `managed_attributes` records
 * which profile fields the provider owns, so the UI can show them as
 * "managed by identity provider" and read-only (Master Spec §12).
 */
export const authIdentities = mysqlTable(
  'auth_identities',
  {
    id: idColumn().primaryKey(),
    userId: char('user_id', { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerType: mysqlEnum('provider_type', AUTH_PROVIDER_TYPES).notNull(),
    /** Stable provider identifier; for local auth the normalized email. */
    providerSubject: varchar('provider_subject', { length: 320 }).notNull(),
    /** Argon2id hash. Never returned by any API. */
    passwordHash: text('password_hash'),
    passwordUpdatedAt: utcTimestamp(),
    /** Forces a password change at next login (invited or admin-reset users). */
    mustChangePassword: int('must_change_password').notNull().default(0),
    managedAttributes: json('managed_attributes').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_auth_identity_provider_subject').on(table.providerType, table.providerSubject),
    index('idx_auth_identities_user').on(table.userId),
  ],
);

/**
 * Password history for the configurable "last N passwords" policy (§6).
 * Stores hashes only.
 */
export const passwordHistory = mysqlTable(
  'password_history',
  {
    id: idColumn().primaryKey(),
    userId: char('user_id', { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('idx_password_history_user').on(table.userId, table.createdAt)],
);

/**
 * Server-side sessions. The browser only ever holds an opaque signed id.
 *
 * Idle timeout and absolute lifetime are enforced separately (§6), and
 * `authenticated_at` backs the re-authentication window for sensitive actions.
 */
export const sessions = mysqlTable(
  'sessions',
  {
    id: idColumn().primaryKey(),
    userId: char('user_id', { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the session token. The plaintext lives only in the cookie. */
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    authenticatedAt: utcTimestamp().notNull(),
    lastSeenAt: utcTimestamp().notNull(),
    absoluteExpiresAt: utcTimestamp().notNull(),
    idleExpiresAt: utcTimestamp().notNull(),
    revokedAt: utcTimestamp(),
    revokedReason: varchar('revoked_reason', { length: 64 }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_sessions_user').on(table.userId, table.revokedAt),
    index('idx_sessions_expiry').on(table.absoluteExpiresAt),
  ],
);

/**
 * Graduated brute-force protection (§6): rate limit, progressive delay,
 * temporary lock. Keyed by normalized email and by client ip so neither a
 * single account nor a single origin can be hammered.
 */
export const loginAttempts = mysqlTable(
  'login_attempts',
  {
    id: idColumn().primaryKey(),
    /** `email:<normalized>` or `ip:<address>`. */
    subjectKey: varchar('subject_key', { length: 128 }).notNull(),
    failedCount: int('failed_count').notNull().default(0),
    firstFailedAt: utcTimestamp().notNull(),
    lastFailedAt: utcTimestamp().notNull(),
    lockedUntil: utcTimestamp(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_login_attempts_subject').on(table.subjectKey),
    index('idx_login_attempts_locked').on(table.lockedUntil),
  ],
);
