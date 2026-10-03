import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  AppError,
  asUserId,
  type ReportRecipient,
  type ReportRhythm,
  type ReportRunSummary,
  type ReportScheduleInput,
  type ReportScheduleOptions,
  type ReportScheduleSummary,
} from '@axp/contracts';
import {
  type Database,
  dashboards,
  newId,
  reportRuns,
  reportSchedules,
  tenantMemberships,
  users,
} from '@axp/db';
import type { AuditService } from '../audit/audit-service';
import type { AccessService } from '../access/access-service';
import { resolveAuthContext } from '../access/auth-context';
import type { Clock } from '../clock';
import type { JobQueue } from '../jobs/job-queue';
import { isKnownTimezone, nextOccurrence } from './rhythm';

export interface ReportServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly access: AccessService;
  readonly jobs: JobQueue;
  readonly pptxEnabled: boolean;
}

type ScheduleRow = typeof reportSchedules.$inferSelect;
type RunRow = typeof reportRuns.$inferSelect;

/**
 * Scheduled reports, as their authors manage them (Master Spec §15).
 *
 * Validates everything that can be validated up front - a published dashboard
 * of this project, a real time zone, recipients who may see the dashboard -
 * and computes when the report next runs. Running it is the worker's job
 * (`ReportRunner`); this only ever enqueues.
 */
export class ReportService {
  constructor(private readonly deps: ReportServiceDeps) {}

  async options(
    tenantId: string,
    projectId: string,
    timezone: string,
  ): Promise<ReportScheduleOptions> {
    const published = await this.deps.db
      .select({ id: dashboards.id, name: dashboards.name, lifecycle: dashboards.lifecycle })
      .from(dashboards)
      .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.projectId, projectId)));
    const candidates = await this.members(tenantId);
    return {
      dashboards: published
        .filter((entry) => entry.lifecycle === 'published')
        .map((entry) => ({ id: entry.id, name: entry.name })),
      recipients: candidates.map((member) => ({ userId: member.userId, name: member.name })),
      timezone,
      pptxEnabled: this.deps.pptxEnabled,
    };
  }

  /** Who may receive a dashboard's report right now, and who may not. */
  async recipientsFor(tenantId: string, dashboardId: string): Promise<ReportRecipient[]> {
    const members = await this.members(tenantId);
    return Promise.all(
      members.map(async (member) => ({
        userId: member.userId,
        name: member.name,
        hasAccess: await this.mayView(member.userId, dashboardId),
      })),
    );
  }

  async list(tenantId: string, projectId: string): Promise<ReportScheduleSummary[]> {
    const rows = await this.deps.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.tenantId, tenantId),
          eq(reportSchedules.projectId, projectId),
          isNull(reportSchedules.deletedAt),
        ),
      )
      .orderBy(desc(reportSchedules.createdAt));
    return Promise.all(rows.map((row) => this.summarize(row)));
  }

  async get(tenantId: string, scheduleId: string): Promise<ReportScheduleSummary> {
    return this.summarize(await this.requireSchedule(tenantId, scheduleId));
  }

  async runs(tenantId: string, scheduleId: string): Promise<ReportRunSummary[]> {
    const schedule = await this.requireSchedule(tenantId, scheduleId);
    const rows = await this.deps.db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.scheduleId, schedule.id))
      .orderBy(desc(reportRuns.plannedFor))
      .limit(25);
    const names = await this.namesOf(
      rows.flatMap((row) => row.skipped.map((entry) => entry.userId)),
    );
    return rows.map((row) => toRunSummary(row, names));
  }

  async create(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly actorUserId: string;
    readonly request: ReportScheduleInput;
  }): Promise<ReportScheduleSummary> {
    await this.validate(input.tenantId, input.projectId, input.request);
    const id = newId();
    await this.deps.db.insert(reportSchedules).values({
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      dashboardId: input.request.dashboardId,
      name: input.request.name,
      format: input.request.format,
      period: input.request.period,
      comparison: input.request.comparison,
      rhythm: input.request.rhythm as unknown as Record<string, unknown>,
      timezone: input.request.timezone,
      deliveryMode: input.request.deliveryMode,
      recipientUserIds: [...new Set(input.request.recipientUserIds)],
      paused: 0,
      nextRunAt: nextOccurrence(
        input.request.rhythm,
        input.request.timezone,
        this.deps.clock.now(),
      ),
      ownerUserId: input.actorUserId,
    });
    await this.audited(
      'report_schedule.created',
      input.tenantId,
      input.projectId,
      id,
      input.actorUserId,
      {
        format: input.request.format,
        frequency: input.request.rhythm.frequency,
        recipients: input.request.recipientUserIds.length,
      },
    );
    return this.get(input.tenantId, id);
  }

  async update(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly scheduleId: string;
    readonly actorUserId: string;
    readonly request: ReportScheduleInput;
  }): Promise<ReportScheduleSummary> {
    const row = await this.requireSchedule(input.tenantId, input.scheduleId, input.projectId);
    await this.validate(input.tenantId, input.projectId, input.request);
    await this.deps.db
      .update(reportSchedules)
      .set({
        dashboardId: input.request.dashboardId,
        name: input.request.name,
        format: input.request.format,
        period: input.request.period,
        comparison: input.request.comparison,
        rhythm: input.request.rhythm as unknown as Record<string, unknown>,
        timezone: input.request.timezone,
        deliveryMode: input.request.deliveryMode,
        recipientUserIds: [...new Set(input.request.recipientUserIds)],
        nextRunAt: row.paused
          ? null
          : nextOccurrence(input.request.rhythm, input.request.timezone, this.deps.clock.now()),
        // The person who last changed it answers for it from now on.
        ownerUserId: input.actorUserId,
      })
      .where(eq(reportSchedules.id, row.id));
    await this.audited(
      'report_schedule.updated',
      input.tenantId,
      input.projectId,
      row.id,
      input.actorUserId,
      {
        format: input.request.format,
        frequency: input.request.rhythm.frequency,
        recipients: input.request.recipientUserIds.length,
      },
    );
    return this.get(input.tenantId, row.id);
  }

  async setPaused(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly scheduleId: string;
    readonly actorUserId: string;
    readonly paused: boolean;
  }): Promise<ReportScheduleSummary> {
    const row = await this.requireSchedule(input.tenantId, input.scheduleId, input.projectId);
    await this.deps.db
      .update(reportSchedules)
      .set({
        paused: input.paused ? 1 : 0,
        nextRunAt: input.paused
          ? null
          : nextOccurrence(
              row.rhythm as unknown as ReportRhythm,
              row.timezone,
              this.deps.clock.now(),
            ),
      })
      .where(eq(reportSchedules.id, row.id));
    await this.audited(
      input.paused ? 'report_schedule.paused' : 'report_schedule.resumed',
      input.tenantId,
      input.projectId,
      row.id,
      input.actorUserId,
      {},
    );
    return this.get(input.tenantId, row.id);
  }

  async remove(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly scheduleId: string;
    readonly actorUserId: string;
  }): Promise<void> {
    const row = await this.requireSchedule(input.tenantId, input.scheduleId, input.projectId);
    await this.deps.db
      .update(reportSchedules)
      .set({ deletedAt: this.deps.clock.now(), nextRunAt: null, paused: 1 })
      .where(eq(reportSchedules.id, row.id));
    await this.audited(
      'report_schedule.deleted',
      input.tenantId,
      input.projectId,
      row.id,
      input.actorUserId,
      {},
    );
  }

  /** "Send now": one run outside the rhythm, through the same queue and checks. */
  async runNow(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly scheduleId: string;
  }): Promise<ReportRunSummary> {
    const row = await this.requireSchedule(input.tenantId, input.scheduleId, input.projectId);
    const run = await this.enqueueRun(row, this.deps.clock.now(), 'manual');
    return toRunSummary(run, new Map());
  }

  /** Creates the run row and its job; idempotent per occurrence. */
  async enqueueRun(
    schedule: ScheduleRow,
    plannedFor: Date,
    trigger: 'schedule' | 'manual',
  ): Promise<RunRow> {
    const existing = await this.findRun(schedule.id, plannedFor, trigger);
    if (existing) return existing;

    const id = newId();
    await this.deps.db.insert(reportRuns).values({
      id,
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      plannedFor,
      trigger,
      status: 'queued',
    });
    const job = await this.deps.jobs.enqueue({
      kind: 'report.deliver',
      payload: { runId: id },
      tenantId: schedule.tenantId,
      dedupeKey: `report-run:${id}`,
    });
    await this.deps.db.update(reportRuns).set({ jobId: job.id }).where(eq(reportRuns.id, id));
    return (await this.findRun(schedule.id, plannedFor, trigger))!;
  }

  /**
   * An occurrence that did not run - the tenant was stopped - recorded as
   * such, without a job, so the history shows the gap and why.
   */
  async recordSkippedRun(schedule: ScheduleRow, plannedFor: Date, errorKey: string): Promise<void> {
    if (await this.findRun(schedule.id, plannedFor, 'schedule')) return;
    const now = this.deps.clock.now();
    await this.deps.db.insert(reportRuns).values({
      id: newId(),
      scheduleId: schedule.id,
      tenantId: schedule.tenantId,
      plannedFor,
      trigger: 'schedule',
      status: 'skipped',
      errorKey,
      finishedAt: now,
    });
  }

  // --- internals ---------------------------------------------------------------

  private async validate(tenantId: string, projectId: string, request: ReportScheduleInput) {
    const fieldErrors: Record<string, string> = {};

    const [dashboard] = await this.deps.db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.id, request.dashboardId), eq(dashboards.tenantId, tenantId)))
      .limit(1);
    if (!dashboard || dashboard.projectId !== projectId) {
      fieldErrors.dashboardId = 'report.dashboard_not_in_project';
    } else if (!dashboard.publishedVersionId || dashboard.lifecycle !== 'published') {
      // Reports read the Published Runtime only.
      fieldErrors.dashboardId = 'report.dashboard_not_published';
    }
    if (!isKnownTimezone(request.timezone)) fieldErrors.timezone = 'report.timezone_unknown';
    if (request.format === 'pptx' && !this.deps.pptxEnabled) {
      fieldErrors.format = 'report.pptx_not_released';
    }

    if (!fieldErrors.dashboardId) {
      const members = new Set((await this.members(tenantId)).map((member) => member.userId));
      for (const userId of request.recipientUserIds) {
        if (!members.has(userId) || !(await this.mayView(userId, request.dashboardId))) {
          // Recipients are checked here and again at every run.
          fieldErrors.recipientUserIds = 'report.recipient_without_access';
          break;
        }
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError('validation_failed', {
        code: 'report_schedule_invalid',
        messageKey: Object.values(fieldErrors)[0]!,
        fieldErrors,
        internalMessage: `Report schedule refused: ${Object.keys(fieldErrors).join(', ')}.`,
      });
    }
  }

  /** Whether a person may see a dashboard now: role and grant (ADR 0006). */
  async mayView(userId: string, dashboardId: string): Promise<boolean> {
    const context = await resolveAuthContext(this.deps.db, asUserId(userId), this.deps.clock.now());
    if (!context) return false;
    return (await this.deps.access.decideDashboard(context, dashboardId, 'view')).granted;
  }

  private async members(tenantId: string) {
    const rows = await this.deps.db
      .select({ userId: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(users.status, 'active')))
      .orderBy(users.lastName, users.firstName);
    return rows.map((row) => ({
      userId: row.userId,
      name: `${row.firstName} ${row.lastName}`.trim(),
    }));
  }

  private async summarize(row: ScheduleRow): Promise<ReportScheduleSummary> {
    const [dashboard] = await this.deps.db
      .select({ name: dashboards.name })
      .from(dashboards)
      .where(eq(dashboards.id, row.dashboardId))
      .limit(1);
    const names = await this.namesOf(row.recipientUserIds);
    const recipients = await Promise.all(
      row.recipientUserIds.map(async (userId) => ({
        userId,
        name: names.get(userId) ?? '—',
        hasAccess: await this.mayView(userId, row.dashboardId),
      })),
    );
    const [lastRun] = await this.deps.db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.scheduleId, row.id), ne(reportRuns.status, 'queued')))
      .orderBy(desc(reportRuns.plannedFor))
      .limit(1);
    const owner = row.ownerUserId
      ? (await this.namesOf([row.ownerUserId])).get(row.ownerUserId)
      : undefined;
    const skippedNames = lastRun
      ? await this.namesOf(lastRun.skipped.map((entry) => entry.userId))
      : new Map<string, string>();

    return {
      id: row.id,
      projectId: row.projectId,
      dashboardId: row.dashboardId,
      dashboardName: dashboard?.name ?? '—',
      name: row.name,
      format: row.format,
      period: row.period as ReportScheduleSummary['period'],
      comparison: row.comparison as ReportScheduleSummary['comparison'],
      rhythm: row.rhythm as unknown as ReportRhythm,
      timezone: row.timezone,
      deliveryMode: row.deliveryMode,
      recipients,
      status: row.paused ? 'paused' : 'active',
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRun: lastRun ? toRunSummary(lastRun, skippedNames) : null,
      createdBy: owner ?? null,
    };
  }

  private async namesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const rows = await this.deps.db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(rows.map((row) => [row.id, `${row.firstName} ${row.lastName}`.trim()]));
  }

  private async findRun(scheduleId: string, plannedFor: Date, trigger: 'schedule' | 'manual') {
    const [row] = await this.deps.db
      .select()
      .from(reportRuns)
      .where(
        and(
          eq(reportRuns.scheduleId, scheduleId),
          eq(reportRuns.plannedFor, plannedFor),
          eq(reportRuns.trigger, trigger),
        ),
      )
      .limit(1);
    return row;
  }

  private async requireSchedule(tenantId: string, scheduleId: string, projectId?: string) {
    const [row] = await this.deps.db
      .select()
      .from(reportSchedules)
      .where(
        and(
          eq(reportSchedules.id, scheduleId),
          eq(reportSchedules.tenantId, tenantId),
          isNull(reportSchedules.deletedAt),
          ...(projectId ? [eq(reportSchedules.projectId, projectId)] : []),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError('not_found', {
        code: 'report_schedule_not_found',
        messageKey: 'report.not_found',
        internalMessage: `Report schedule ${scheduleId} not found.`,
      });
    }
    return row;
  }

  private async audited(
    action:
      | 'report_schedule.created'
      | 'report_schedule.updated'
      | 'report_schedule.paused'
      | 'report_schedule.resumed'
      | 'report_schedule.deleted',
    tenantId: string,
    projectId: string,
    scheduleId: string,
    actorUserId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.deps.audit.record({
      action,
      outcome: 'success',
      actorUserId,
      tenantId,
      projectId,
      targetType: 'report_schedule',
      targetId: scheduleId,
      metadata,
    });
  }
}

export function toRunSummary(row: RunRow, names: ReadonlyMap<string, string>): ReportRunSummary {
  return {
    id: row.id,
    plannedFor: row.plannedFor.toISOString(),
    trigger: row.trigger,
    status: row.status,
    attempts: row.attempts,
    publishedVersion: row.publishedVersion,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    delivered: row.delivered,
    skipped: row.skipped.map((entry) => ({
      name: names.get(entry.userId) ?? '—',
      reason: entry.reason as ReportRunSummary['skipped'][number]['reason'],
    })),
    errorKey: row.errorKey,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
