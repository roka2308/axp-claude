import {
  char,
  index,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { OBJECT_ACCESS_LEVELS, SCOPE_TYPES, SUBJECT_TYPES, SYSTEM_ROLES } from '@axp/contracts';
import { createdAt, idColumn, updatedAt } from './_shared';
import { users } from './identity';
import { tenants } from './tenancy';

/** Groups are the preferred way to scale access; direct grants are exceptions (§7). */
export const groups = mysqlTable(
  'groups',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar({ length: 200 }).notNull(),
    description: varchar({ length: 1000 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('uq_groups_tenant_name').on(table.tenantId, table.name)],
);

export const groupMembers = mysqlTable(
  'group_members',
  {
    id: idColumn().primaryKey(),
    groupId: char('group_id', { length: 36 })
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: char('user_id', { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_group_member').on(table.groupId, table.userId),
    index('idx_group_members_user').on(table.userId),
  ],
);

/**
 * Scoped role assignment (Shared Contract §3).
 *
 * `scope_id` is empty for the platform scope. Assignments are additive: a
 * subject's effective capabilities are the union across all of its rows. No row
 * here ever grants analytics data access on its own.
 */
export const roleAssignments = mysqlTable(
  'role_assignments',
  {
    id: idColumn().primaryKey(),
    subjectType: mysqlEnum('subject_type', SUBJECT_TYPES).notNull(),
    subjectId: char('subject_id', { length: 36 }).notNull(),
    role: mysqlEnum(SYSTEM_ROLES).notNull(),
    scopeType: mysqlEnum('scope_type', SCOPE_TYPES).notNull(),
    /** Tenant id, project id, or '' for the platform scope. */
    scopeId: varchar('scope_id', { length: 36 }).notNull().default(''),
    grantedByUserId: char('granted_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_role_assignment').on(
      table.subjectType,
      table.subjectId,
      table.role,
      table.scopeType,
      table.scopeId,
    ),
    index('idx_role_assignments_subject').on(table.subjectType, table.subjectId),
    index('idx_role_assignments_scope').on(table.scopeType, table.scopeId),
  ],
);

/**
 * Positive object grants only - there are no deny rules in MVP (§7).
 * `object_type` stays a string so later object kinds do not need a migration
 * of every existing row; allowed values are validated in the domain layer.
 */
export const objectGrants = mysqlTable(
  'object_grants',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subjectType: mysqlEnum('subject_type', SUBJECT_TYPES).notNull(),
    subjectId: char('subject_id', { length: 36 }).notNull(),
    objectType: varchar('object_type', { length: 40 }).notNull(),
    objectId: char('object_id', { length: 36 }).notNull(),
    access: mysqlEnum(OBJECT_ACCESS_LEVELS).notNull(),
    grantedByUserId: char('granted_by_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_object_grant').on(
      table.subjectType,
      table.subjectId,
      table.objectType,
      table.objectId,
      table.access,
    ),
    index('idx_object_grants_object').on(table.objectType, table.objectId),
    index('idx_object_grants_tenant').on(table.tenantId),
  ],
);
