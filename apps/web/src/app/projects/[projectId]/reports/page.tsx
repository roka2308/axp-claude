import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReportRhythm, ReportRunSummary, ReportScheduleSummary } from '@axp/contracts';
import { Callout, DataTable } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { ThemeStyle } from '@/components/ThemeStyle';
import { CauseSurface } from '@/components/viewer/CauseSurface';
import { ReportScheduleForm } from '@/components/reporting/ReportScheduleForm';
import { ScheduleActions } from '@/components/reporting/ScheduleActions';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getProject } from '@/lib/analytics';
import { getReportRuns, getReports } from '@/lib/reporting';
import styles from './reports.module.css';

interface ReportsPageProps {
  readonly params: Promise<{ readonly projectId: string }>;
  readonly searchParams: Promise<{ readonly schedule?: string; readonly edit?: string }>;
}

/**
 * Projekt → Reports (Master Spec §15).
 *
 * Every schedule says what it sends, how often, in which time zone, to whom -
 * including who would be left out today because they may no longer see the
 * dashboard - and how its last run went.
 */
export default async function ReportsPage({ params, searchParams }: ReportsPageProps) {
  const t = await getTranslations();
  const format = await getFormatter();
  const { projectId } = await params;
  const search = await searchParams;
  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  let loaded;
  try {
    const [project, reports] = await Promise.all([getProject(projectId), getReports(projectId)]);
    loaded = { project, reports };
  } catch (error) {
    return (
      <AppShell activeKey="projects" version={version}>
        <CauseSurface error={error} />
      </AppShell>
    );
  }
  const { project, reports } = loaded;
  const selected = reports.schedules.find((entry) => entry.id === search.schedule);
  const editing = reports.schedules.find((entry) => entry.id === search.edit);
  const runs = selected ? await getReportRuns(projectId, selected.id).catch(() => []) : [];

  const inZone = (iso: string, timezone: string) =>
    `${format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })} (${timezone})`;

  const rhythmText = (rhythm: ReportRhythm) => {
    const time = rhythm.time;
    switch (rhythm.frequency) {
      case 'daily':
        return t('reports.rhythm.daily', { time });
      case 'weekly':
        return t('reports.rhythm.weekly', { day: t(`reports.weekday.${rhythm.weekday}`), time });
      case 'monthly':
        return rhythm.dayOfMonth === 'last'
          ? t('reports.rhythm.monthlyLast', { time })
          : t('reports.rhythm.monthly', { day: rhythm.dayOfMonth ?? 1, time });
      case 'quarterly':
        return rhythm.dayOfMonth === 'last'
          ? t('reports.rhythm.quarterlyLast', { time })
          : t('reports.rhythm.quarterly', { day: rhythm.dayOfMonth ?? 1, time });
      case 'custom':
        return t('reports.rhythm.custom', {
          days: (rhythm.weekdays ?? []).map((day) => t(`reports.weekday.${day}`)).join(', '),
          time,
        });
    }
  };

  const runText = (run: ReportRunSummary) =>
    `${t(`reports.runStatus.${run.status}`)}${run.errorKey && t.has(run.errorKey) ? ` – ${t(run.errorKey)}` : ''}`;

  return (
    <AppShell activeKey="projects" version={version}>
      <ThemeStyle projectId={projectId} />
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <Link href={`/projects/${projectId}` as Route} className={styles.back}>
            {t('reports.backToProject', { project: project.project.name })}
          </Link>
          <h1>{t('reports.title')}</h1>
          <p className="text-secondary">{t('reports.intro')}</p>
        </header>

        <section className="stack" aria-labelledby="reports-list">
          <h2 id="reports-list" className={styles.heading}>
            {t('reports.listTitle')}
          </h2>
          {reports.schedules.length === 0 ? (
            <p className="text-muted">{t('reports.empty')}</p>
          ) : (
            <ul className={styles.schedules}>
              {reports.schedules.map((schedule: ReportScheduleSummary) => {
                const withoutAccess = schedule.recipients.filter(
                  (recipient) => !recipient.hasAccess,
                );
                return (
                  <li key={schedule.id} className={styles.schedule} aria-label={schedule.name}>
                    <div className={styles.scheduleHead}>
                      <strong>{schedule.name}</strong>
                      <span className={styles.status} data-status={schedule.status}>
                        {t(`reports.status.${schedule.status}`)}
                      </span>
                    </div>
                    <dl className={styles.facts}>
                      <div>
                        <dt>{t('reports.facts.dashboard')}</dt>
                        <dd>{schedule.dashboardName}</dd>
                      </div>
                      <div>
                        <dt>{t('reports.facts.content')}</dt>
                        <dd>
                          {t(`reports.period.${schedule.period}`)} ·{' '}
                          {t(`reports.comparison.${schedule.comparison}`)} ·{' '}
                          {schedule.format.toUpperCase()} ·{' '}
                          {t(`reports.deliveryMode.${schedule.deliveryMode}`)}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('reports.facts.rhythm')}</dt>
                        <dd>
                          {rhythmText(schedule.rhythm)} ({schedule.timezone})
                        </dd>
                      </div>
                      <div>
                        <dt>{t('reports.facts.nextRun')}</dt>
                        <dd>
                          {schedule.nextRunAt
                            ? inZone(schedule.nextRunAt, schedule.timezone)
                            : t('reports.facts.noNextRun')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('reports.facts.recipients')}</dt>
                        <dd>{schedule.recipients.map((recipient) => recipient.name).join(', ')}</dd>
                      </div>
                      <div>
                        <dt>{t('reports.facts.lastRun')}</dt>
                        <dd>
                          {schedule.lastRun
                            ? `${runText(schedule.lastRun)} · ${inZone(schedule.lastRun.plannedFor, schedule.timezone)}`
                            : t('reports.facts.neverRun')}
                        </dd>
                      </div>
                    </dl>
                    {withoutAccess.length > 0 ? (
                      <Callout tone="warning" title={t('reports.withoutAccessTitle')}>
                        {t('reports.withoutAccessBody', {
                          names: withoutAccess.map((recipient) => recipient.name).join(', '),
                        })}
                      </Callout>
                    ) : null}
                    <ScheduleActions
                      projectId={projectId}
                      scheduleId={schedule.id}
                      paused={schedule.status === 'paused'}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {selected ? (
          <section className="stack" aria-labelledby="reports-history">
            <h2 id="reports-history" className={styles.heading}>
              {t('reports.historyTitle', { name: selected.name })}
            </h2>
            {runs.length === 0 ? (
              <p className="text-muted">{t('reports.facts.neverRun')}</p>
            ) : (
              <DataTable
                caption={t('reports.historyTitle', { name: selected.name })}
                captionHidden
                columns={[
                  { key: 'planned', label: t('reports.history.planned') },
                  { key: 'trigger', label: t('reports.history.trigger') },
                  { key: 'status', label: t('reports.history.status') },
                  { key: 'period', label: t('reports.history.period') },
                  { key: 'version', label: t('reports.history.version') },
                  { key: 'delivered', label: t('reports.history.delivered'), numeric: true },
                  { key: 'skipped', label: t('reports.history.skipped') },
                ]}
                rows={runs.map((run) => ({
                  key: run.id,
                  cells: {
                    planned: inZone(run.plannedFor, selected.timezone),
                    trigger: t(`reports.trigger.${run.trigger}`),
                    status: runText(run),
                    period: run.periodFrom ? `${run.periodFrom} – ${run.periodTo}` : '—',
                    version: run.publishedVersion === null ? '—' : String(run.publishedVersion),
                    delivered: String(run.delivered),
                    skipped:
                      run.skipped.length === 0
                        ? '—'
                        : run.skipped
                            .map(
                              (entry) =>
                                `${entry.name} (${t(`reports.skipReason.${entry.reason}`)})`,
                            )
                            .join(', '),
                  },
                }))}
              />
            )}
          </section>
        ) : null}

        <section className={styles.card}>
          <ReportScheduleForm
            key={editing?.id ?? 'new'}
            projectId={projectId}
            options={reports.options}
            {...(editing ? { initial: editing } : {})}
          />
        </section>
      </div>
    </AppShell>
  );
}
