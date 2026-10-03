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
import {
  ATTENTION_KINDS,
  ATTENTION_SEVERITIES,
  ATTENTION_STATUSES,
  JOB_KINDS,
  JOB_STATUSES,
  REPORT_DELIVERY_MODES,
  REPORT_FORMATS,
  REPORT_RUN_STATUSES,
} from '@axp/contracts';
import { createdAt, idColumn, updatedAt, utcTimestamp } from './_shared';
import { users } from './identity';
import { projects, tenants } from './tenancy';
import { dashboards } from './dashboard';

/**
 * The durable job queue (development plan, Phase 8).
 *
 * A job names its work by reference (`payload` holds ids, validated per kind)
 * and never carries analytics data. Claiming is a lease: `lockedUntil` expires
 * if a worker dies mid-job, and the job becomes claimable again. `dedupeKey`
 * makes enqueueing idempotent - one report occurrence is one job, however
 * often the scheduler looks.
 */
export const jobs = mysqlTable(
  'jobs',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 }).references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    kind: mysqlEnum(JOB_KINDS).notNull(),
    payload: json().$type<Record<string, unknown>>().notNull(),
    status: mysqlEnum(JOB_STATUSES).notNull().default('queued'),
    attempts: int().notNull().default(0),
    maxAttempts: int('max_attempts').notNull().default(3),
    runAfter: utcTimestamp().notNull(),
    lockedBy: varchar('locked_by', { length: 64 }),
    lockedUntil: utcTimestamp(),
    dedupeKey: varchar('dedupe_key', { length: 191 }),
    /** An i18n key and a code - never a raw error text or a payload. */
    lastErrorCode: varchar('last_error_code', { length: 100 }),
    correlationId: varchar('correlation_id', { length: 64 }),
    startedAt: utcTimestamp(),
    finishedAt: utcTimestamp(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_jobs_dedupe').on(table.dedupeKey),
    index('idx_jobs_claim').on(table.status, table.runAfter),
    index('idx_jobs_tenant').on(table.tenantId),
  ],
);

/**
 * A scheduled report (Master Spec §15, Shared Contract §12).
 *
 * Which published dashboard, which relative period, in which time zone, how
 * often, to whom and how. `nextRunAt` is derived from the rhythm and kept so
 * the scheduler can find due reports with one indexed query.
 */
export const reportSchedules = mysqlTable(
  'report_schedules',
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
    name: varchar({ length: 120 }).notNull(),
    format: mysqlEnum(REPORT_FORMATS).notNull(),
    period: varchar({ length: 32 }).notNull(),
    comparison: varchar({ length: 32 }).notNull(),
    rhythm: json().$type<Record<string, unknown>>().notNull(),
    timezone: varchar({ length: 64 }).notNull(),
    deliveryMode: mysqlEnum('delivery_mode', REPORT_DELIVERY_MODES).notNull(),
    recipientUserIds: json('recipient_user_ids').$type<string[]>().notNull(),
    paused: int().notNull().default(0),
    nextRunAt: utcTimestamp(),
    /** The person whose access the report runs under. */
    ownerUserId: char('owner_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    deletedAt: utcTimestamp(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('idx_report_schedules_due').on(table.paused, table.nextRunAt),
    index('idx_report_schedules_project').on(table.projectId),
  ],
);

/**
 * One occurrence of a schedule: when it was due, what happened, to whom.
 *
 * Status and counts only. The period it covered is kept as dates, because
 * "which week did Monday's report show" is a question people ask; the values
 * in it are not kept.
 */
export const reportRuns = mysqlTable(
  'report_runs',
  {
    id: idColumn().primaryKey(),
    scheduleId: char('schedule_id', { length: 36 })
      .notNull()
      .references(() => reportSchedules.id, { onDelete: 'cascade' }),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    plannedFor: utcTimestamp().notNull(),
    trigger: mysqlEnum(['schedule', 'manual']).notNull(),
    status: mysqlEnum(REPORT_RUN_STATUSES).notNull().default('queued'),
    attempts: int().notNull().default(0),
    jobId: char('job_id', { length: 36 }),
    publishedVersion: int('published_version'),
    periodFrom: varchar('period_from', { length: 10 }),
    periodTo: varchar('period_to', { length: 10 }),
    delivered: int().notNull().default(0),
    /** Who was left out and why: user ids and a reason code. */
    skipped: json().$type<{ userId: string; reason: string }[]>().notNull().default([]),
    errorKey: varchar('error_key', { length: 120 }),
    startedAt: utcTimestamp(),
    finishedAt: utcTimestamp(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_report_runs_occurrence').on(table.scheduleId, table.plannedFor, table.trigger),
    index('idx_report_runs_schedule').on(table.scheduleId, table.plannedFor),
  ],
);

/**
 * Attention Center items (Master Spec §15).
 *
 * One row per problem, not per occurrence: `groupKey` identifies the problem
 * (kind and subject), and a repeat updates `occurrences` and `lastSeenAt`.
 * Who sees an item is decided by `audienceCapability` within its tenant or
 * project, plus `ownerUserId` when one person is concerned.
 */
export const attentionItems = mysqlTable(
  'attention_items',
  {
    id: idColumn().primaryKey(),
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    projectId: char('project_id', { length: 36 }).references(() => projects.id, {
      onDelete: 'cascade',
    }),
    kind: mysqlEnum(ATTENTION_KINDS).notNull(),
    severity: mysqlEnum(ATTENTION_SEVERITIES).notNull(),
    status: mysqlEnum(ATTENTION_STATUSES).notNull().default('open'),
    groupKey: varchar('group_key', { length: 191 }).notNull(),
    audienceCapability: varchar('audience_capability', { length: 64 }).notNull(),
    ownerUserId: char('owner_user_id', { length: 36 }).references(() => users.id, {
      onDelete: 'set null',
    }),
    messageKey: varchar('message_key', { length: 120 }).notNull(),
    /** Names and counts for the message - never analytics values. */
    messageParams: json('message_params')
      .$type<Record<string, string | number>>()
      .notNull()
      .default({}),
    href: varchar({ length: 255 }),
    occurrences: int().notNull().default(1),
    firstSeenAt: utcTimestamp().notNull(),
    lastSeenAt: utcTimestamp().notNull(),
    acknowledgedAt: utcTimestamp(),
    acknowledgedByUserId: char('acknowledged_by_user_id', { length: 36 }).references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    resolvedAt: utcTimestamp(),
    /** When the owner was told by mail; at most once per group. */
    mailedAt: utcTimestamp(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_attention_group').on(table.tenantId, table.groupKey),
    index('idx_attention_open').on(table.tenantId, table.status),
  ],
);
