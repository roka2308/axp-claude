import { char, index, json, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { AUDIT_ACTIONS, AUDIT_OUTCOMES } from '@axp/contracts';
import { createdAt, idColumn } from './_shared';

/**
 * Audit trail (Shared Contract §16).
 *
 * Append-only by convention: the domain layer exposes no update or delete.
 * Records never contain secrets, password hashes, tokens or analytics
 * payloads - `metadata` is sanitised before it is written.
 *
 * Deliberately without foreign keys: audit rows must survive the deletion of
 * the objects they describe (tenant purge, user cleanup).
 */
export const auditEvents = mysqlTable(
  'audit_events',
  {
    id: idColumn().primaryKey(),
    action: mysqlEnum(AUDIT_ACTIONS).notNull(),
    outcome: mysqlEnum(AUDIT_OUTCOMES).notNull(),
    actorUserId: char('actor_user_id', { length: 36 }),
    tenantId: char('tenant_id', { length: 36 }),
    projectId: char('project_id', { length: 36 }),
    targetType: varchar('target_type', { length: 64 }),
    targetId: varchar('target_id', { length: 64 }),
    correlationId: varchar('correlation_id', { length: 128 }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    metadata: json().$type<Record<string, unknown>>(),
    occurredAt: createdAt(),
  },
  (table) => [
    index('idx_audit_occurred').on(table.occurredAt),
    index('idx_audit_actor').on(table.actorUserId, table.occurredAt),
    index('idx_audit_tenant').on(table.tenantId, table.occurredAt),
    index('idx_audit_action').on(table.action, table.occurredAt),
  ],
);
