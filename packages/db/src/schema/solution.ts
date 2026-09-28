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
import { TEMPLATE_KINDS, TEMPLATE_LAYERS } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { users } from './identity';
import { projects, tenants } from './tenancy';

/**
 * One installation of a solution package into one project (Master Spec §14).
 *
 * Keeps the package exactly as installed - a declarative document, product
 * configuration and nothing else: it cannot hold analytics data, credentials
 * or users, because the package schema has nowhere to put them. It is kept so
 * dashboards can still be created from its templates, and so an update can be
 * compared against what is there.
 *
 * `objectMap` records which local rows the package's portable ids became:
 * portable id is not local id (Shared Contract §13).
 */
export const solutionInstallations = mysqlTable(
  'solution_installations',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    projectId: char('project_id', { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    packageId: varchar('package_id', { length: 128 }).notNull(),
    packageVersion: varchar('package_version', { length: 20 }).notNull(),
    name: varchar({ length: 200 }).notNull(),
    publisher: varchar({ length: 200 }).notNull(),
    content: json().$type<Record<string, unknown>>().notNull(),
    objectMap: json('object_map').$type<Record<string, string>>().notNull(),
    /** False once a later version of the same package was installed over it. */
    current: int().notNull().default(1),
    installedByUserId: char('installed_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    installedAt: utcTimestamp().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('idx_solution_installations_project').on(table.projectId, table.packageId),
    index('idx_solution_installations_tenant').on(table.tenantId),
  ],
);

/**
 * Widget and dashboard templates, in four layers (Master Spec §14):
 * global (shipped), solution (installed with a package), tenant and project.
 *
 * Copy-on-insert: a dashboard created from a template is an ordinary dashboard
 * with no link back. Changing a template later - by editing it or by updating
 * the package it came with - changes no existing dashboard.
 *
 * `body` references semantic definitions by portable id; they are resolved
 * when a widget or dashboard is created from it, in the target project.
 */
export const templates = mysqlTable(
  'templates',
  {
    id: idColumn().primaryKey(),
    kind: mysqlEnum(TEMPLATE_KINDS).notNull(),
    layer: mysqlEnum(TEMPLATE_LAYERS).notNull(),
    tenantId: char('tenant_id', { length: 36 }).references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    projectId: char('project_id', { length: 36 }).references(() => projects.id, {
      onDelete: 'cascade',
    }),
    portableId: varchar('portable_id', { length: 128 }).notNull(),
    name: varchar({ length: 200 }).notNull(),
    description: varchar({ length: 1000 }),
    body: json().$type<Record<string, unknown>>().notNull(),
    /** Increases whenever the body changes; nothing created from it follows. */
    version: int().notNull().default(1),
    installationId: char('installation_id', { length: 36 }).references(
      () => solutionInstallations.id,
      { onDelete: 'set null' },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_templates_scope').on(
      table.kind,
      table.portableId,
      table.tenantId,
      table.projectId,
    ),
    index('idx_templates_project').on(table.projectId),
  ],
);
