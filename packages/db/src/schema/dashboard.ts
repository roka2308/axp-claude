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
import { DASHBOARD_LIFECYCLE_STATES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { users } from './identity';
import { projects, tenants } from './tenancy';
import { matomoSites } from './matomo';

/**
 * Dashboard lifecycle (Master Spec §21).
 *
 * Three tables with three different jobs:
 *   - `dashboards` is the stable identity and the pointer to what is published;
 *   - `dashboard_drafts` is the single mutable working copy;
 *   - `dashboard_versions` holds immutable published snapshots.
 *
 * Publishing inserts a version and moves the pointer in one transaction, so it
 * is atomic; editing the draft afterwards cannot reach a published version.
 */
export const dashboards = mysqlTable(
  'dashboards',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    projectId: char('project_id', { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    siteId: char('site_id', { length: 36 }).references(() => matomoSites.id, {
      onDelete: 'restrict',
    }),
    name: varchar({ length: 200 }).notNull(),
    description: varchar({ length: 1000 }),
    lifecycle: mysqlEnum(DASHBOARD_LIFECYCLE_STATES).notNull().default('draft'),
    /** Points at the newest published version, or null before the first publish. */
    publishedVersionId: char('published_version_id', { length: 36 }),
    archivedAt: utcTimestamp(),
    trashedAt: utcTimestamp(),
    createdByUserId: char('created_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('idx_dashboards_project').on(table.projectId, table.lifecycle),
    index('idx_dashboards_tenant').on(table.tenantId),
  ],
);

/**
 * The mutable working copy. Exactly one per dashboard.
 *
 * `revisionId` changes on every autosave and is what an editor must present to
 * write: a stale revision means someone else changed the draft, and the write
 * is rejected instead of silently overwriting. The lease columns carry the
 * one-editor-at-a-time rule; the full takeover flow lands in Phase 2.
 */
export const dashboardDrafts = mysqlTable(
  'dashboard_drafts',
  {
    id: idColumn().primaryKey(),
    dashboardId: char('dashboard_id', { length: 36 })
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    revisionId: char('revision_id', { length: 36 }).notNull(),
    snapshot: json().$type<Record<string, unknown>>().notNull(),
    /** Whether the draft differs from the published version. */
    hasUnpublishedChanges: int('has_unpublished_changes').notNull().default(0),
    leaseUserId: char('lease_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    leaseExpiresAt: utcTimestamp(),
    updatedByUserId: char('updated_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('uq_dashboard_draft').on(table.dashboardId)],
);

export const DASHBOARD_VERSION_STATUSES = ['published', 'archived'] as const;

/**
 * An immutable published snapshot.
 *
 * Rows are inserted, never updated: a rollback creates a NEW version from an
 * older snapshot rather than resurrecting one (Master Spec §21).
 */
export const dashboardVersions = mysqlTable(
  'dashboard_versions',
  {
    id: idColumn().primaryKey(),
    dashboardId: char('dashboard_id', { length: 36 })
      .notNull()
      .references(() => dashboards.id, { onDelete: 'cascade' }),
    version: int().notNull(),
    status: mysqlEnum(DASHBOARD_VERSION_STATUSES).notNull().default('published'),
    snapshot: json().$type<Record<string, unknown>>().notNull(),
    /** Semantic version ids pinned by this snapshot, for impact analysis. */
    pinnedSemanticVersionIds: json('pinned_semantic_version_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Set when this version was produced by rolling back to an older one. */
    rolledBackFromVersion: int('rolled_back_from_version'),
    publishedByUserId: char('published_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_dashboard_version').on(table.dashboardId, table.version),
    index('idx_dashboard_versions_status').on(table.dashboardId, table.status),
  ],
);
