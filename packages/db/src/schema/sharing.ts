import {
  char,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { EXPORT_FORMATS } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { users } from './identity';
import { projects, tenants } from './tenancy';
import { dashboards } from './dashboard';

/**
 * External shares (Master Spec §15, Shared Contract §11).
 *
 * Configuration only: which published dashboard, until when, with which
 * rights. The link token is stored as a SHA-256 hash and the optional
 * password as an Argon2id hash, so a database read yields neither. Whether a
 * share still works is decided on every access - expiry, revocation, the
 * dashboard's lifecycle, the tenant's and the creator's standing - rather
 * than by a job that might run late.
 */
export const dashboardShares = mysqlTable(
  'dashboard_shares',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    projectId: char('project_id', { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    dashboardId: char('dashboard_id', { length: 36 })
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    label: varchar({ length: 120 }).notNull(),
    expiresAt: utcTimestamp().notNull(),
    allowTimeRange: int('allow_time_range').notNull().default(0),
    allowComparison: int('allow_comparison').notNull().default(0),
    allowDetail: int('allow_detail').notNull().default(0),
    allowExport: int('allow_export').notNull().default(0),
    passwordHash: varchar('password_hash', { length: 255 }),
    /** Failed password attempts since the last success, for the lockout. */
    failedUnlocks: int('failed_unlocks').notNull().default(0),
    unlockBlockedUntil: utcTimestamp(),
    createdByUserId: char('created_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: utcTimestamp(),
    revokedByUserId: char('revoked_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    lastAccessedAt: utcTimestamp(),
    accessCount: int('access_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_dashboard_shares_token').on(table.tokenHash),
    index('idx_dashboard_shares_dashboard').on(table.dashboardId),
    index('idx_dashboard_shares_tenant').on(table.tenantId),
  ],
);

/**
 * Proof that a recipient gave a share's password.
 *
 * Short-lived and bound to one share; it never outlives the share itself.
 * Only the hash of the session token is kept.
 */
export const shareSessions = mysqlTable(
  'share_sessions',
  {
    id: idColumn().primaryKey(),
    shareId: char('share_id', { length: 36 })
      .notNull()
      .references(() => dashboardShares.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    expiresAt: utcTimestamp().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_share_sessions_token').on(table.tokenHash),
    index('idx_share_sessions_expiry').on(table.expiresAt),
  ],
);

/**
 * A finished export file, by reference.
 *
 * The row is metadata - format, name, size, owner, expiry - and holds no
 * analytics values. The file itself is encrypted on disk under
 * `storageKey` and deleted with the row when it expires (Master Spec §4:
 * nothing analytical outlives the processing that needed it).
 */
export const exportArtifacts = mysqlTable(
  'export_artifacts',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dashboardId: char('dashboard_id', { length: 36 })
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    format: mysqlEnum(EXPORT_FORMATS).notNull(),
    /** Exactly one of the two: a signed-in requester, or a share. */
    requestedByUserId: char('requested_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'cascade',
    }),
    shareId: char('share_id', { length: 36 }).references(() => dashboardShares.id, {
      onDelete: 'cascade',
    }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    byteSize: int('byte_size').notNull(),
    storageKey: char('storage_key', { length: 64 }).notNull(),
    expiresAt: utcTimestamp().notNull(),
    downloadCount: int('download_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_export_artifacts_storage').on(table.storageKey),
    index('idx_export_artifacts_expiry').on(table.expiresAt),
  ],
);
