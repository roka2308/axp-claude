import {
  char,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { THEME_SCOPES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { users } from './identity';
import { projects, tenants } from './tenancy';

/**
 * Themes (Master Spec §16): Platform -> Tenant -> optional Project.
 *
 * One row per scope, holding its working copy (the draft); published versions
 * are immutable rows in `theme_versions`, and `published_version_id` points at
 * the current one - the same shape as dashboards, for the same reason: a
 * published theme never changes under anyone's feet, and rollback is a new
 * version. Values are token values from the allowlist only, validated before
 * they are stored; there is no column that could hold CSS or script.
 */
export const themes = mysqlTable(
  'themes',
  {
    id: idColumn().primaryKey(),
    scope: mysqlEnum(THEME_SCOPES).notNull(),
    /** `platform`, `tenant:<id>` or `project:<id>` - unique, unlike nullable pairs. */
    scopeKey: varchar('scope_key', { length: 64 }).notNull(),
    tenantId: char('tenant_id', { length: 36 }).references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    projectId: char('project_id', { length: 36 }).references(() => projects.id, {
      onDelete: 'cascade',
    }),
    publishedVersionId: char('published_version_id', { length: 36 }),
    draftName: varchar('draft_name', { length: 120 }),
    draftTokens: json('draft_tokens').$type<Record<string, string>>(),
    draftDarkTokens: json('draft_dark_tokens').$type<Record<string, string>>(),
    draftUpdatedAt: utcTimestamp(),
    draftUpdatedByUserId: char('draft_updated_by_user_id', { length: 36 }).references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('uq_themes_scope').on(table.scopeKey)],
);

export const themeVersions = mysqlTable(
  'theme_versions',
  {
    id: idColumn().primaryKey(),
    themeId: char('theme_id', { length: 36 })
      .notNull()
      .references(() => themes.id, { onDelete: 'cascade' }),
    version: int().notNull(),
    name: varchar({ length: 120 }).notNull(),
    tokens: json().$type<Record<string, string>>().notNull(),
    darkTokens: json('dark_tokens').$type<Record<string, string>>().notNull(),
    rolledBackFromVersion: int('rolled_back_from_version'),
    publishedByUserId: char('published_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('uq_theme_versions').on(table.themeId, table.version)],
);

/**
 * Which modules a customer has (Master Spec §23). A row exists only once a
 * platform administrator decided; without one, the deployment default
 * applies. Switching a module off leaves everything configured for it in
 * place.
 */
export const tenantEntitlements = mysqlTable(
  'tenant_entitlements',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    entitlement: varchar({ length: 64 }).notNull(),
    enabled: int().notNull(),
    changedByUserId: char('changed_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    changedAt: utcTimestamp().notNull(),
  },
  (table) => [uniqueIndex('uq_tenant_entitlement').on(table.tenantId, table.entitlement)],
);

/**
 * A generated diagnostic bundle, by reference (Master Spec §24). The file is
 * sanitised, encrypted on disk, readable by its creator only, and deleted
 * when it expires.
 */
export const diagnosticArtifacts = mysqlTable(
  'diagnostic_artifacts',
  {
    id: idColumn().primaryKey(),
    createdByUserId: char('created_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'cascade',
    }),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    byteSize: int('byte_size').notNull(),
    storageKey: char('storage_key', { length: 64 }).notNull(),
    expiresAt: utcTimestamp().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_diagnostic_artifacts_storage').on(table.storageKey),
    index('idx_diagnostic_artifacts_expiry').on(table.expiresAt),
  ],
);
