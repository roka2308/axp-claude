import {
  char,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { SUPPORTED_LOCALES, TENANT_LIFECYCLE_STATES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { users } from './identity';

/**
 * Tenant - the isolation boundary (Shared Contract §4).
 *
 * Every tenant-owned record carries `tenant_id` directly or through an
 * unambiguous ownership path. Lifecycle follows
 * provisioning -> active <-> suspended -> offboarding -> deleted; `deleted` is
 * a state, not a row removal, so the audit trail survives.
 */
export const tenants = mysqlTable(
  'tenants',
  {
    id: idColumn().primaryKey(),
    /** Stable identifier for fixtures and configuration export. */
    portableId: varchar('portable_id', { length: 128 }).notNull(),
    name: varchar({ length: 200 }).notNull(),
    slug: varchar({ length: 100 }).notNull(),
    lifecycle: mysqlEnum(TENANT_LIFECYCLE_STATES).notNull().default('provisioning'),
    defaultLocale: mysqlEnum('default_locale', SUPPORTED_LOCALES).notNull().default('de'),
    lifecycleChangedAt: utcTimestamp(),
    lifecycleChangedByUserId: char('lifecycle_changed_by_user_id', { length: 36 }).references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_tenants_slug').on(table.slug),
    uniqueIndex('uq_tenants_portable_id').on(table.portableId),
    index('idx_tenants_lifecycle').on(table.lifecycle),
  ],
);

export const PROJECT_SETUP_STATES = ['setup_required', 'ready_with_limitations', 'ready'] as const;

/**
 * Project - the working context for dashboards, data and semantics.
 *
 * `timezone` is the IANA project/report timezone used for scheduling and
 * administration. The analytics calendar follows the Matomo site timezone
 * instead, which is stored with the site in a later milestone (§19).
 */
export const projects = mysqlTable(
  'projects',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    portableId: varchar('portable_id', { length: 128 }).notNull(),
    name: varchar({ length: 200 }).notNull(),
    slug: varchar({ length: 100 }).notNull(),
    description: varchar({ length: 1000 }),
    timezone: varchar({ length: 64 }).notNull().default('Europe/Berlin'),
    defaultLocale: mysqlEnum('default_locale', SUPPORTED_LOCALES).notNull().default('de'),
    setupState: mysqlEnum('setup_state', PROJECT_SETUP_STATES).notNull().default('setup_required'),
    /**
     * Resumable, non-linear setup checklist (Master Spec §13). Stored as a
     * declarative document because the item catalogue evolves with the product
     * and carries no analytics values.
     */
    setupChecklist: json('setup_checklist').$type<Record<string, unknown>>(),
    archivedAt: utcTimestamp(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_projects_tenant_slug').on(table.tenantId, table.slug),
    uniqueIndex('uq_projects_tenant_portable_id').on(table.tenantId, table.portableId),
    index('idx_projects_tenant').on(table.tenantId),
  ],
);

/**
 * Tenant membership is separate from global identity (Gap Review G5):
 * removing a tenant must not delete a user who is still needed elsewhere.
 */
export const tenantMemberships = mysqlTable(
  'tenant_memberships',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: char('user_id', { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_tenant_membership').on(table.tenantId, table.userId),
    index('idx_tenant_membership_user').on(table.userId),
  ],
);
