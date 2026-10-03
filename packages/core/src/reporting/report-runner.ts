import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import {
  type DashboardPresentation,
  type DashboardSnapshot,
  type Locale,
  type RecipientSkipReason,
  type ReportRhythm,
  type TimeRangePreset,
  type ComparisonMode,
} from '@axp/contracts';
import {
  type Database,
  dashboards,
  dashboardVersions,
  matomoSites,
  projects,
  projectSites,
  reportRuns,
  reportSchedules,
  tenants,
  users,
} from '@axp/db';
import type { Logger } from '@axp/observability';
import type { AuditService } from '../audit/audit-service';
import type { AttentionService } from '../attention/attention-service';
import type { Clock } from '../clock';
import type {
  BuildPresentationInput,
  PresentationBuilder,
} from '../dashboard/presentation-builder';
import type { ExportService } from '../export/export-service';
import { EXPORT_CONTENT_TYPES } from '../export/export-service';
import { buildExportDocument } from '../export/document';
import type { ClaimedJob, FailOutcome } from '../jobs/job-queue';
import type { JobHandler } from '../jobs/job-runner';
import type { MailTransport } from '../mail/mail-transport';
import type { ReportService } from './report-service';
import { nextOccurrence } from './rhythm';

export interface ReportRunnerDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly attention: AttentionService;
  readonly presentation: PresentationBuilder;
  readonly exports: ExportService;
  readonly reports: ReportService;
  readonly mail: MailTransport;
  readonly webUrl: string;
}

/** A failure the runner understands: an i18n key, and whether trying again can help. */
export class ReportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'ReportError';
  }
}

type ScheduleRow = typeof reportSchedules.$inferSelect;

/**
 * Runs scheduled reports (Master Spec §15).
 *
 * Every run reads the Published Runtime: the dashboard's latest published
 * version, never its draft. Every run re-checks what may have changed since
 * the schedule was written - the tenant's standing, the owner's access, each
 * recipient's access - and leaves out whoever may no longer see the
 * dashboard. The period is relative to when the run was due, in the site's
 * calendar, so a retry an hour later still describes the same days. Nothing
 * of the report is kept: the attachment exists while it is sent.
 */
export class ReportRunner {
  constructor(private readonly deps: ReportRunnerDeps) {}

  /**
   * Turns due schedules into queued runs. Idempotent per occurrence; a
   * suspended or offboarding tenant's reports are recorded as skipped and do
   * not run (Gate F8).
   */
  async scheduleDue(): Promise<{ queued: number; skipped: number }> {
    const now = this.deps.clock.now();
    const due = await this.deps.db
      .select({ schedule: reportSchedules, tenantLifecycle: tenants.lifecycle })
      .from(reportSchedules)
      .innerJoin(tenants, eq(tenants.id, reportSchedules.tenantId))
      .where(
        and(
          eq(reportSchedules.paused, 0),
          isNull(reportSchedules.deletedAt),
          lte(reportSchedules.nextRunAt, now),
        ),
      );

    let queued = 0;
    let skipped = 0;
    for (const { schedule, tenantLifecycle } of due) {
      const plannedFor = schedule.nextRunAt!;
      if (tenantLifecycle === 'active' || tenantLifecycle === 'provisioning') {
        await this.deps.reports.enqueueRun(schedule, plannedFor, 'schedule');
        queued += 1;
      } else {
        await this.recordSkippedOccurrence(schedule, plannedFor, 'report.tenant_inactive');
        skipped += 1;
      }
      // A worker that was down for a week sends the latest occurrence once,
      // not seven reports at once.
      const after = plannedFor > now ? plannedFor : now;
      await this.deps.db
        .update(reportSchedules)
        .set({
          nextRunAt: nextOccurrence(
            schedule.rhythm as unknown as ReportRhythm,
            schedule.timezone,
            after,
          ),
        })
        .where(eq(reportSchedules.id, schedule.id));
    }
    return { queued, skipped };
  }

  /** This runner as the queue's handler for `report.deliver`. */
  asJobHandler(): JobHandler {
    return {
      run: (job) => this.deliver(job),
      classify: (error) =>
        error instanceof ReportError
          ? { code: error.code, retryable: error.retryable }
          : { code: 'report.unexpected', retryable: true },
      onFailure: (job, error, outcome) => this.onFailure(job, error, outcome),
    };
  }

  /** The job handler for `report.deliver`. */
  async deliver(job: ClaimedJob): Promise<'done' | 'cancelled'> {
    const runId = String(job.payload.runId);
    const [run] = await this.deps.db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.id, runId))
      .limit(1);
    if (!run) return 'cancelled';
    const [schedule] = await this.deps.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, run.scheduleId))
      .limit(1);

    await this.deps.db
      .update(reportRuns)
      .set({ status: 'running', attempts: job.attempt, startedAt: this.deps.clock.now() })
      .where(eq(reportRuns.id, run.id));

    if (!schedule || schedule.deletedAt || (schedule.paused && run.trigger === 'schedule')) {
      await this.finishSkipped(run.id, 'report.schedule_inactive');
      return 'cancelled';
    }

    const [context] = await this.deps.db
      .select({
        tenantLifecycle: tenants.lifecycle,
        tenantName: tenants.name,
        projectName: projects.name,
        dashboardLifecycle: dashboards.lifecycle,
        publishedVersionId: dashboards.publishedVersionId,
      })
      .from(dashboards)
      .innerJoin(tenants, eq(tenants.id, dashboards.tenantId))
      .innerJoin(projects, eq(projects.id, dashboards.projectId))
      .where(eq(dashboards.id, schedule.dashboardId))
      .limit(1);

    // Stopped tenants stop their reports, even ones queued before the stop.
    if (
      !context ||
      (context.tenantLifecycle !== 'active' && context.tenantLifecycle !== 'provisioning')
    ) {
      await this.finishSkipped(run.id, 'report.tenant_inactive');
      return 'cancelled';
    }
    if (!context.publishedVersionId || context.dashboardLifecycle !== 'published') {
      throw new ReportError('report.dashboard_not_published', false);
    }
    if (
      !schedule.ownerUserId ||
      !(await this.deps.reports.mayView(schedule.ownerUserId, schedule.dashboardId))
    ) {
      throw new ReportError('report.owner_lost_access', false);
    }

    // Published Runtime: the latest published version, never the draft.
    const [version] = await this.deps.db
      .select()
      .from(dashboardVersions)
      .where(eq(dashboardVersions.id, context.publishedVersionId))
      .limit(1);
    const snapshot = version!.snapshot as unknown as DashboardSnapshot;
    const [site] = await this.deps.db
      .select({ id: matomoSites.id, name: matomoSites.name, timezone: matomoSites.timezone })
      .from(projectSites)
      .innerJoin(matomoSites, eq(matomoSites.id, projectSites.siteId))
      .where(
        and(
          eq(projectSites.projectId, schedule.projectId),
          eq(projectSites.siteId, snapshot.siteId),
        ),
      )
      .limit(1);
    if (!site) throw new ReportError('report.site_not_assigned', false);

    // Recipients, checked at this moment.
    const wanted = new Set(schedule.recipientUserIds);
    const recipients = await this.deps.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        locale: users.locale,
        status: users.status,
      })
      .from(users)
      .where(inArray(users.id, wanted.size > 0 ? [...wanted] : ['-']));
    const eligible: { id: string; email: string; name: string; locale: Locale }[] = [];
    const skipped: { userId: string; reason: RecipientSkipReason }[] = [];
    for (const person of recipients.filter((entry) => wanted.has(entry.id))) {
      if (person.status !== 'active') {
        skipped.push({ userId: person.id, reason: 'inactive' });
      } else if (!(await this.deps.reports.mayView(person.id, schedule.dashboardId))) {
        skipped.push({ userId: person.id, reason: 'no_access' });
      } else {
        eligible.push({
          id: person.id,
          email: person.email,
          name: `${person.firstName} ${person.lastName}`.trim(),
          locale: person.locale,
        });
      }
    }
    for (const userId of wanted) {
      if (!recipients.some((entry) => entry.id === userId))
        skipped.push({ userId, reason: 'inactive' });
    }

    await this.reportSkippedRecipients(schedule, skipped);
    if (eligible.length === 0) throw new ReportError('report.no_recipients', false);

    const view: BuildPresentationInput = {
      snapshot,
      meta: {
        dashboardId: schedule.dashboardId,
        name: snapshot.name,
        ...(snapshot.description ? { description: snapshot.description } : {}),
        publishedVersion: version!.version,
        isDraftPreview: false,
        projectName: context.projectName,
        tenantName: context.tenantName,
      },
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      site,
      timeRangePreset: schedule.period as TimeRangePreset,
      comparisonMode: schedule.comparison as ComparisonMode,
      breakpoint: 'desktop',
      locale: 'de',
      permissionContextId: `report:${schedule.id}`,
      audience: 'export',
      at: run.plannedFor,
    };

    // One rendering per language, one mail per person.
    const byLocale = new Map<Locale, typeof eligible>();
    for (const person of eligible)
      byLocale.set(person.locale, [...(byLocale.get(person.locale) ?? []), person]);

    let delivered = 0;
    let failedSends = 0;
    let period: { from: string; to: string } | undefined;
    for (const [locale, people] of byLocale) {
      const localized: BuildPresentationInput = { ...view, locale };
      let presentation: DashboardPresentation;
      let attachment: { content: Buffer; fileName: string } | undefined;

      if (schedule.deliveryMode === 'attachment') {
        const rendered = await this.deps.exports.render({
          view: localized,
          format: schedule.format,
          audience: 'internal',
        });
        presentation = rendered.presentation;
        attachment = { content: rendered.content, fileName: rendered.fileName };
        // Every value unavailable means the source is down: a report of gaps
        // helps nobody, so try again later instead of sending it.
        const measured = presentation.widgets.filter((widget) => widget.family !== 'context_text');
        if (measured.length > 0 && measured.every((widget) => widget.state === 'unavailable')) {
          throw new ReportError('report.source_unavailable', true);
        }
      } else {
        // A link stores nothing and fetches nothing now; the period is named
        // in the mail, the numbers are seen under the recipient's own rights.
        presentation = { ...this.deps.presentation.buildLayout(localized), widgets: [] };
      }
      period = { from: presentation.timeRange.from, to: presentation.timeRange.to };

      const document = buildExportDocument(presentation, {
        locale,
        generatedAt: this.deps.clock.now(),
        audience: 'internal',
      });
      const link = `${this.deps.webUrl}/dashboards/${schedule.dashboardId}?timeRange=${schedule.period}&comparison=${schedule.comparison}`;

      for (const person of people) {
        try {
          await this.deps.mail.send({
            to: { address: person.email, name: person.name },
            subject: `${schedule.name} – ${document.periodText}`,
            text: reportMailText(locale, schedule.deliveryMode, document.meta, link),
            ...(attachment
              ? {
                  attachments: [
                    {
                      filename: attachment.fileName,
                      content: attachment.content,
                      contentType: EXPORT_CONTENT_TYPES[schedule.format],
                    },
                  ],
                }
              : {}),
          });
          delivered += 1;
        } catch (error) {
          failedSends += 1;
          this.deps.logger.warn({ err: error, runId: run.id }, 'Report mail could not be sent');
        }
      }
    }

    if (delivered === 0) throw new ReportError('report.mail_failed', true);

    const status = skipped.length > 0 || failedSends > 0 ? 'partially_delivered' : 'delivered';
    await this.deps.db
      .update(reportRuns)
      .set({
        status,
        delivered,
        skipped,
        publishedVersion: version!.version,
        periodFrom: period?.from ?? null,
        periodTo: period?.to ?? null,
        errorKey: failedSends > 0 ? 'report.mail_failed' : null,
        finishedAt: this.deps.clock.now(),
      })
      .where(eq(reportRuns.id, run.id));

    await this.deps.attention.resolve(schedule.tenantId, `report_failed:${schedule.id}`);
    await this.deps.audit.record({
      action: 'report.run_finished',
      outcome: 'success',
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      targetType: 'report_schedule',
      targetId: schedule.id,
      metadata: {
        runId: run.id,
        status,
        delivered,
        skipped: skipped.length,
        publishedVersion: version!.version,
        trigger: run.trigger,
      },
    });
    return 'done';
  }

  /**
   * After a failed attempt: either it waits for its retry, or it is over and
   * the schedule's owner hears about it - once per schedule, however often it
   * fails (grouping).
   */
  async onFailure(job: ClaimedJob, error: unknown, outcome: FailOutcome): Promise<void> {
    const code = error instanceof ReportError ? error.code : 'report.unexpected';
    const runId = String(job.payload.runId);
    const [run] = await this.deps.db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.id, runId))
      .limit(1);
    if (!run) return;

    if (outcome.status === 'queued') {
      await this.deps.db
        .update(reportRuns)
        .set({ status: 'queued', errorKey: code })
        .where(eq(reportRuns.id, run.id));
      return;
    }

    await this.deps.db
      .update(reportRuns)
      .set({ status: 'failed', errorKey: code, finishedAt: this.deps.clock.now() })
      .where(eq(reportRuns.id, run.id));

    const [schedule] = await this.deps.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.id, run.scheduleId))
      .limit(1);
    if (!schedule) return;

    await this.deps.attention.raise({
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      kind: 'report_failed',
      severity: 'action_required',
      groupKey: `report_failed:${schedule.id}`,
      audienceCapability: 'report.manage',
      ownerUserId: schedule.ownerUserId,
      messageKey: 'attention.report_failed',
      messageParams: { report: schedule.name, reason: code },
      href: `/projects/${schedule.projectId}/reports?schedule=${schedule.id}`,
    });
    await this.deps.audit.record({
      action: 'report.run_finished',
      outcome: 'failure',
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      targetType: 'report_schedule',
      targetId: schedule.id,
      metadata: { runId: run.id, status: 'failed', reason: code, attempts: job.attempt },
    });
  }

  private async reportSkippedRecipients(
    schedule: ScheduleRow,
    skipped: readonly { userId: string; reason: RecipientSkipReason }[],
  ) {
    const groupKey = `report_recipients:${schedule.id}`;
    if (skipped.length === 0) {
      await this.deps.attention.resolve(schedule.tenantId, groupKey);
      return;
    }
    await this.deps.attention.raise({
      tenantId: schedule.tenantId,
      projectId: schedule.projectId,
      kind: 'report_recipient_without_access',
      severity: 'warning',
      groupKey,
      audienceCapability: 'report.manage',
      ownerUserId: schedule.ownerUserId,
      messageKey: 'attention.report_recipient_without_access',
      messageParams: { report: schedule.name, count: skipped.length },
      href: `/projects/${schedule.projectId}/reports?schedule=${schedule.id}`,
    });
  }

  private async recordSkippedOccurrence(schedule: ScheduleRow, plannedFor: Date, errorKey: string) {
    await this.deps.reports.recordSkippedRun(schedule, plannedFor, errorKey);
  }

  private async finishSkipped(runId: string, errorKey: string) {
    await this.deps.db
      .update(reportRuns)
      .set({ status: 'skipped', errorKey, finishedAt: this.deps.clock.now() })
      .where(eq(reportRuns.id, runId));
  }
}

/** The mail around a report: what it is, which period, and - for a link - where. */
function reportMailText(
  locale: Locale,
  mode: 'attachment' | 'link',
  meta: readonly { label: string; value: string }[],
  link: string,
): string {
  const english = locale === 'en';
  const lines = meta.map((row) => `${row.label}: ${row.value}`);
  return [
    english
      ? 'Your scheduled report from Analytics Experience.'
      : 'Ihr geplanter Bericht aus Analytics Experience.',
    '',
    ...lines,
    '',
    mode === 'attachment'
      ? english
        ? 'The report is attached.'
        : 'Der Bericht ist als Datei angehängt.'
      : english
        ? `Open the dashboard (sign-in required; it shows the current state when opened): ${link}`
        : `Dashboard öffnen (Anmeldung erforderlich; zeigt beim Öffnen den aktuellen Stand): ${link}`,
    '',
    english
      ? 'You receive this report because you were added as a recipient. Its owner can change the recipients in the project under Reports.'
      : 'Sie erhalten diesen Bericht, weil Sie als Empfänger:in eingetragen sind. Die Empfänger:innen ändert die verantwortliche Person im Projekt unter „Reports“.',
  ].join('\n');
}
