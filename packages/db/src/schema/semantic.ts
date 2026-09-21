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
import { SEMANTIC_LIFECYCLE_STATES, SEMANTIC_TYPES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { users } from './identity';
import { projects, tenants } from './tenancy';
import { matomoSites } from './matomo';

/**
 * Stable identity of a semantic definition (Shared Contract §7).
 *
 * `tenant_id` and `project_id` are both nullable: a definition may be global
 * (shipped with the product), tenant-wide, or project-specific. The portable id
 * is what survives export and import - never the database id.
 */
export const semanticDefinitions = mysqlTable(
  'semantic_definitions',
  {
    id: idColumn().primaryKey(),
    portableId: varchar('portable_id', { length: 128 }).notNull(),
    tenantId: char('tenant_id', { length: 36 }).references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    projectId: char('project_id', { length: 36 }).references(() => projects.id, {
      onDelete: 'cascade',
    }),
    type: mysqlEnum(SEMANTIC_TYPES).notNull(),
    name: varchar({ length: 200 }).notNull(),
    description: varchar({ length: 1000 }),
    /** The version currently marked active; published dashboards pin their own. */
    currentVersionId: char('current_version_id', { length: 36 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // Scoped uniqueness: the same portable id may exist once globally and once
    // per project, which is how a project overrides a shipped definition.
    uniqueIndex('uq_semantic_definition_scope').on(
      table.portableId,
      table.tenantId,
      table.projectId,
    ),
    index('idx_semantic_definitions_project').on(table.projectId),
    index('idx_semantic_definitions_tenant').on(table.tenantId),
  ],
);

/**
 * An immutable version of a definition.
 *
 * Never updated after activation: a changed business definition is a new
 * version, and published dashboards keep pointing at the version they pinned.
 */
export const semanticVersions = mysqlTable(
  'semantic_versions',
  {
    id: idColumn().primaryKey(),
    definitionId: char('definition_id', { length: 36 })
      .notNull()
      .references(() => semanticDefinitions.id, { onDelete: 'cascade' }),
    version: int().notNull(),
    status: mysqlEnum(SEMANTIC_LIFECYCLE_STATES).notNull().default('draft'),
    /** The definition body: native metric, custom metric, formula or score. */
    body: json().$type<Record<string, unknown>>().notNull(),
    /** Pinned dependencies, forming a DAG. Cycles are rejected before activation. */
    dependencyVersionIds: json('dependency_version_ids').$type<string[]>().notNull().default([]),
    createdByUserId: char('created_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_semantic_version').on(table.definitionId, table.version),
    index('idx_semantic_versions_status').on(table.status),
  ],
);

/**
 * Local mapping from a semantic requirement to something a site actually has.
 *
 * Deliberately separate from `semantic_versions`: correcting a mapping is a
 * technical fix and must not create a new business version, and a new business
 * version must not silently rewire a mapping (Master Spec §13).
 */
export const sourceBindings = mysqlTable(
  'source_bindings',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    projectId: char('project_id', { length: 36 }).references(() => projects.id, {
      onDelete: 'cascade',
    }),
    siteId: char('site_id', { length: 36 }).references(() => matomoSites.id, {
      onDelete: 'cascade',
    }),
    /** What the semantic layer asked for, e.g. `pulse.engaged_users`. */
    requirementKey: varchar('requirement_key', { length: 128 }).notNull(),
    /** How it is satisfied on this site: a normalised source descriptor. */
    binding: json().$type<Record<string, unknown>>().notNull(),
    createdByUserId: char('created_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * When somebody last looked at this mapping after drift was reported.
     *
     * Kept here rather than on a semantic version: acknowledging a technical
     * fact must not create a business version (Gate F3).
     */
    reviewedAt: utcTimestamp(),
    reviewedByUserId: char('reviewed_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * What the site looked like at the moment of the review.
     *
     * A review is an answer to a specific situation. When the situation
     * changes the answer goes stale, and the warning returns rather than
     * staying silently acknowledged.
     */
    reviewedFingerprint: varchar('reviewed_fingerprint', { length: 256 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_source_binding_scope').on(table.projectId, table.siteId, table.requirementKey),
    index('idx_source_bindings_tenant').on(table.tenantId),
  ],
);
