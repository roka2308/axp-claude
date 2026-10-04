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

/**
 * A pending invitation (D5: invite).
 *
 * The token is shown once to the inviting administrator, who passes it on;
 * only its hash is stored, like every other secret token in the product. An
 * invitation is single-use and expires, and accepting it is the moment the
 * invited person chooses their own password - nobody else ever knows it.
 */
export const userInvitations = mysqlTable(
  'user_invitations',
  {
    id: idColumn().primaryKey(),
    userId: char('user_id', { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The tenant the invitation was issued for; memberships follow from it. */
    tenantId: char('tenant_id', { length: 36 }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    /**
     * The link's token, encrypted and bound to this row, only until the
     * invitation mail is sent (Phase 10). Null afterwards.
     */
    sealedToken: text('sealed_token'),
    expiresAt: utcTimestamp().notNull(),
    usedAt: utcTimestamp(),
    createdByUserId: char('created_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [index('idx_user_invitations_user').on(table.userId)],
);

/**
 * Single-use links sent to a person's own mailbox (Master Spec §6, §12):
 * "Passwort vergessen" and the verification of a new e-mail address.
 *
 * Like invitations, only the token's hash identifies a link. The token itself
 * is kept encrypted until the mail is sent and then removed, so the job queue
 * carries ids only and nothing in the database opens an account afterwards.
 */
export const accountTokens = mysqlTable(
  'account_tokens',
  {
    id: idColumn().primaryKey(),
    userId: char('user_id', { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: mysqlEnum(['password_reset', 'email_change']).notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    /** For an address change: the address being verified. */
    newEmail: varchar('new_email', { length: 320 }),
    sealedToken: text('sealed_token'),
    expiresAt: utcTimestamp().notNull(),
    usedAt: utcTimestamp(),
    createdAt: createdAt(),
  },
  (table) => [index('idx_account_tokens_user_purpose').on(table.userId, table.purpose)],
);
