import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  type ComparisonMode,
  COMPARISON_MODES,
  type TimeRangePreset,
  TIME_RANGE_PRESETS,
} from '@axp/contracts';
import { Button, Callout } from '@axp/ui';
import { AppShell } from '@/components/AppShell';
import { DashboardGrid } from '@/components/DashboardGrid';
import { ViewerControls } from '@/components/ViewerControls';
import { WidgetFrame } from '@/components/widgets/WidgetFrame';
import { WidgetContent } from '@/components/widgets/WidgetContent';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getPresentation } from '@/lib/analytics';
import { ApiError, ApiUnreachableError } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import { logoutAction } from '@/app/login/actions';
import styles from './dashboard.module.css';

interface DashboardPageProps {
  readonly params: Promise<{ readonly dashboardId: string }>;
  readonly searchParams: Promise<{
    readonly timeRange?: string;
    readonly comparison?: string;
    readonly source?: string;
  }>;
}

/**
 * Dashboard viewer (D4).
 *
 * Deliberately quiet and dashboard-centred. Time range and comparison are the
 * only analytics interactions; the data scope is visible but read-only, and
 * there is no global cross-filtering.
 */
export default async function DashboardPage({ params, searchParams }: DashboardPageProps) {
  const t = await getTranslations();
  const { dashboardId } = await params;
  const query = await searchParams;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const timeRange = asPreset(query.timeRange);
  const comparison = asComparison(query.comparison);
  const source = query.source === 'draft' ? 'draft' : 'published';

  let presentation;
  try {
    presentation = await getPresentation(dashboardId, { timeRange, comparison, source });
  } catch (error) {
    return (
      <AppShell activeKey="dashboards" version={version}>
        <DashboardError error={error} />
      </AppShell>
    );
  }

  return (
    <AppShell
      activeKey="dashboards"
      version={version}
      headerEnd={
        <form action={logoutAction}>
          <Button type="submit" variant="ghost">
            {t('login.signOut')}
          </Button>
        </form>
      }
    >
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <h1>{presentation.dashboard.name}</h1>
          <p className="text-secondary">
            {presentation.dashboard.projectName}
            {presentation.dashboard.publishedVersion !== null
              ? ` · ${t('viewer.version', { version: presentation.dashboard.publishedVersion })}`
              : ''}
            {presentation.dashboard.isDraftPreview ? ` · ${t('viewer.draftPreview')}` : ''}
          </p>
          {presentation.dashboard.description ? (
            <p className="text-muted">{presentation.dashboard.description}</p>
          ) : null}
        </header>

        <ViewerControls timeRange={timeRange} comparison={comparison} />

        {/*
          Data Scope: what the numbers are about. Visible so a value can be
          interpreted, read-only because only time and comparison are
          interactive in MVP (D4).
        */}
        <div className={styles.scope}>
          <span>
            {t('viewer.scopeSite')}: <strong>{presentation.dataScope.siteName}</strong>
          </span>
          <span>
            {t('viewer.scopeTimezone')}: {presentation.dataScope.siteTimezone}
          </span>
          <span>
            {t('viewer.scopeRange')}: {presentation.timeRange.from} – {presentation.timeRange.to}
          </span>
          {presentation.comparison?.from ? (
            <span>
              {t('viewer.scopeComparison')}: {presentation.comparison.from} –{' '}
              {presentation.comparison.to}
            </span>
          ) : null}
          {presentation.dataScope.filters.map((filter) => (
            <span key={filter.label}>
              {filter.label}: {filter.value}
            </span>
          ))}
        </div>

        {presentation.widgets.length === 0 ? (
          <Callout tone="info" title={t('viewer.emptyDashboardTitle')}>
            {t('viewer.emptyDashboardBody')}
          </Callout>
        ) : (
          <DashboardGrid
            widgets={presentation.widgets}
            renderWidget={(widget) => (
              <WidgetFrame widget={widget}>
                <WidgetContent widget={widget} />
              </WidgetFrame>
            )}
          />
        )}

        <Link href="/projects" className={styles.back}>
          {t('projects.backToList')}
        </Link>
      </div>
    </AppShell>
  );
}

/**
 * Renders a dashboard-level failure with its actual cause.
 *
 * A dashboard that was never published, one the caller may not see and an
 * unreachable API are three different situations, and D10 requires them to
 * look different.
 */
async function DashboardError({ error }: { readonly error: unknown }) {
  const t = await getTranslations();
  const resolved = await resolveError(error);

  const tone =
    error instanceof ApiError && error.body.category === 'setup_required' ? 'warning' : 'critical';

  const title =
    error instanceof ApiUnreachableError
      ? t('errors.unreachable')
      : error instanceof ApiError && error.body.category === 'permission_denied'
        ? t('viewer.permissionDeniedTitle')
        : t('viewer.loadFailedTitle');

  return (
    <div className="stack">
      <Callout tone={tone} title={title}>
        <div className="stack stack--tight">
          <span>{resolved.message}</span>
          {resolved.action ? <span className="text-muted">{resolved.action}</span> : null}
        </div>
      </Callout>
      <Link href="/projects">{t('projects.backToList')}</Link>
    </div>
  );
}

function asPreset(value: string | undefined): TimeRangePreset {
  return TIME_RANGE_PRESETS.includes(value as TimeRangePreset)
    ? (value as TimeRangePreset)
    : 'last_30_days';
}

function asComparison(value: string | undefined): ComparisonMode {
  return COMPARISON_MODES.includes(value as ComparisonMode)
    ? (value as ComparisonMode)
    : 'previous_period';
}
