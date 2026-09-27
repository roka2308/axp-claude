import { Suspense } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
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
import { CauseSurface } from '@/components/viewer/CauseSurface';
import { DetailOverlay } from '@/components/viewer/DetailOverlay';
import { WidgetDetail } from '@/components/viewer/WidgetDetail';
import { WidgetTile, WidgetTileSkeleton } from '@/components/viewer/WidgetTile';
import { getApiVersion, getCurrentUser } from '@/lib/platform';
import { getDashboardLayout, getWidgetDetail } from '@/lib/analytics';
import { logoutAction } from '@/app/login/actions';
import styles from './dashboard.module.css';

interface DashboardPageProps {
  readonly params: Promise<{ readonly dashboardId: string }>;
  readonly searchParams: Promise<{
    readonly timeRange?: string;
    readonly comparison?: string;
    readonly source?: string;
    /** The widget whose detail view is open, if any. */
    readonly widget?: string;
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
  const search = await searchParams;

  const [user, version] = await Promise.all([getCurrentUser(), getApiVersion()]);
  if (!user) redirect('/login');

  const timeRange = asPreset(search.timeRange);
  const comparison = asComparison(search.comparison);
  const source = search.source === 'draft' ? 'draft' : 'published';

  /*
   * The layout first, and only the layout: it comes from the stored snapshot
   * and asks Matomo nothing, so the grid is on screen while the widgets are
   * still being fetched. Each tile then streams in on its own (Master Spec §11).
   */
  const query = { timeRange, comparison, source } as const;

  let presentation;
  try {
    presentation = await getDashboardLayout(dashboardId, query);
  } catch (error) {
    return (
      <AppShell activeKey="dashboards" version={version}>
        <CauseSurface error={error} />
      </AppShell>
    );
  }

  /*
   * The detail view is a URL, not a client-side state: `?widget=<id>` renders
   * it server-side inside a focus-managed dialog. That makes it shareable, it
   * survives a reload, and the content is in the document before any
   * JavaScript runs (D4).
   *
   * Fetched separately and tolerantly: a detail view that fails must not take
   * the dashboard behind it down with it.
   */
  const openWidgetId = search.widget;
  const detail = openWidgetId
    ? await getWidgetDetail(dashboardId, openWidgetId, { timeRange, comparison, source }).catch(
        () => null,
      )
    : null;

  const viewHref = (params: Record<string, string | undefined>): Route => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({ timeRange, comparison, ...params })) {
      if (value) search.set(key, value);
    }
    if (source === 'draft') search.set('source', 'draft');
    return `/dashboards/${dashboardId}?${search.toString()}` as Route;
  };

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
            renderWidget={(shell) => (
              // One boundary per widget. React streams each tile in as its own
              // query resolves, which is what makes `loading` a state a viewer
              // actually sees rather than a case in a type union (D10).
              <Suspense fallback={<WidgetTileSkeleton shell={shell} />}>
                <WidgetTile
                  dashboardId={dashboardId}
                  shell={shell}
                  query={query}
                  detailHref={viewHref({ widget: shell.widgetId })}
                />
              </Suspense>
            )}
          />
        )}

        <Link href="/projects" className={styles.back}>
          {t('projects.backToList')}
        </Link>
      </div>

      {openWidgetId ? (
        <DetailOverlay
          closeHref={viewHref({ widget: undefined })}
          title={detail?.widget.title ?? t('detail.title')}
        >
          {detail ? (
            <WidgetDetail detail={detail} />
          ) : (
            <Callout tone="critical" title={t('detail.loadFailedTitle')}>
              {t('detail.loadFailedBody')}
            </Callout>
          )}
        </DetailOverlay>
      ) : null}
    </AppShell>
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
