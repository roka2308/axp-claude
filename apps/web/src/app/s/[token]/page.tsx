import { Suspense } from 'react';
import type { Metadata, Route } from 'next';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import {
  type ComparisonMode,
  COMPARISON_MODES,
  type Locale,
  type SharedLayout,
  type TimeRangePreset,
  TIME_RANGE_PRESETS,
  type WidgetDetailPresentation,
} from '@axp/contracts';
import { Callout } from '@axp/ui';
import { DashboardGrid } from '@/components/DashboardGrid';
import { ViewerControls } from '@/components/ViewerControls';
import { DetailOverlay } from '@/components/viewer/DetailOverlay';
import { WidgetDetail } from '@/components/viewer/WidgetDetail';
import { WidgetTile, WidgetTileSkeleton } from '@/components/viewer/WidgetTile';
import { ExportMenu } from '@/components/sharing/ExportMenu';
import { ShareUnlockForm } from '@/components/sharing/ShareUnlockForm';
import { sharedExportAction } from '@/app/sharing/actions';
import { ThemeStyle } from '@/components/ThemeStyle';
import {
  getShareAccess,
  getSharedDetail,
  getSharedLayout,
  type SharedViewQuery,
} from '@/lib/sharing';
import styles from './shared.module.css';

// A shared link is nobody's search result, and its URL is its key.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

interface SharedPageProps {
  readonly params: Promise<{ readonly token: string }>;
  readonly searchParams: Promise<{
    readonly timeRange?: string;
    readonly comparison?: string;
    readonly widget?: string;
  }>;
}

/**
 * A shared dashboard, as its recipient sees it (Master Spec §15).
 *
 * No sign-in and no navigation into the product: the published dashboard,
 * its data scope, how long the link is valid, and only the interactions the
 * share allows. A link that does not work - revoked, expired, archived, never
 * existed - shows one neutral page, whatever the reason.
 */
export default async function SharedDashboardPage({ params, searchParams }: SharedPageProps) {
  const { token } = await params;
  const search = await searchParams;
  const t = await getTranslations();
  const locale = (await getLocale()) as Locale;

  const access = await getShareAccess(token).catch(() => ({ state: 'unavailable' }) as const);

  if (access.state === 'unavailable') return <Unavailable />;
  if (access.state === 'password_required') {
    return (
      <PublicFrame>
        <div className={styles.narrow}>
          <h1>{t('shared.passwordTitle')}</h1>
          <p className="text-secondary">{t('shared.passwordBody')}</p>
          <ShareUnlockForm token={token} />
        </div>
      </PublicFrame>
    );
  }

  const rights = access.meta.rights;
  const query: SharedViewQuery = {
    locale,
    ...(rights.timeRange && asPreset(search.timeRange)
      ? { timeRange: asPreset(search.timeRange) }
      : {}),
    ...(rights.comparison && asComparison(search.comparison)
      ? { comparison: asComparison(search.comparison) }
      : {}),
  };

  let layout: SharedLayout;
  try {
    layout = await getSharedLayout(token, query);
  } catch {
    // Revoked or expired between the two requests: the same neutral answer.
    return <Unavailable />;
  }

  const format = await getFormatter();
  const timeRange: TimeRangePreset =
    layout.timeRange.preset === 'custom' ? 'last_30_days' : layout.timeRange.preset;
  const comparison: ComparisonMode = layout.comparison?.mode ?? 'none';
  const effective: SharedViewQuery = { locale, timeRange, comparison };
  const stateLabel = `${t(`viewer.presets.${timeRange}`)} · ${t(`viewer.comparisons.${comparison}`)}`;

  const viewHref = (next: Record<string, string | undefined>): Route => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({
      ...(rights.timeRange ? { timeRange } : {}),
      ...(rights.comparison ? { comparison } : {}),
      ...next,
    })) {
      if (value) params.set(key, value);
    }
    const suffix = params.toString();
    return `/s/${token}${suffix ? `?${suffix}` : ''}` as Route;
  };

  const openWidgetId = rights.detail ? search.widget : undefined;
  let detail: WidgetDetailPresentation | null = null;
  if (openWidgetId) {
    detail = await getSharedDetail(token, openWidgetId, effective).catch(() => null);
  }

  const exportAction = sharedExportAction.bind(null, token, locale);

  return (
    <PublicFrame token={token}>
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <p className={styles.eyebrow}>
            {t('shared.eyebrow', { tenant: layout.share.tenantName })}
          </p>
          <h1>{layout.dashboard.name}</h1>
          {layout.dashboard.description ? (
            <p className="text-secondary">{layout.dashboard.description}</p>
          ) : null}
          <p className={styles.validity}>
            {t('shared.validUntil', {
              date: format.dateTime(new Date(layout.share.expiresAt), {
                dateStyle: 'long',
                timeStyle: 'short',
              }),
            })}
          </p>
        </header>

        {rights.timeRange || rights.comparison ? (
          <ViewerControls
            timeRange={timeRange}
            comparison={comparison}
            allowTimeRange={rights.timeRange}
            allowComparison={rights.comparison}
          />
        ) : null}

        {/* Data scope: what the numbers are about, visible and read-only (D4). */}
        <div className={styles.scope}>
          <span>
            {t('viewer.scopeSite')}: <strong>{layout.dataScope.siteName}</strong>
          </span>
          <span>
            {t('viewer.scopeTimezone')}: {layout.dataScope.siteTimezone}
          </span>
          <span>
            {t('viewer.scopeRange')}: {t(`viewer.presets.${timeRange}`)} ({layout.timeRange.from} –{' '}
            {layout.timeRange.to})
          </span>
          {layout.comparison?.from ? (
            <span>
              {t('viewer.scopeComparison')}: {layout.comparison.from} – {layout.comparison.to}
            </span>
          ) : null}
          {layout.dataScope.filters.map((filter) => (
            <span key={filter.label}>
              {filter.label}: {filter.value}
            </span>
          ))}
        </div>

        {rights.export ? (
          <section className={styles.distribution} aria-label={t('export.sectionLabel')}>
            <ExportMenu
              action={exportAction}
              formats={['pdf', 'xlsx', 'pptx']}
              timeRange={timeRange}
              comparison={comparison}
              stateLabel={stateLabel}
              idPrefix="shared"
            />
          </section>
        ) : null}

        {layout.widgets.length === 0 ? (
          <Callout tone="info" title={t('viewer.emptyDashboardTitle')}>
            {t('viewer.emptyDashboardBody')}
          </Callout>
        ) : (
          <DashboardGrid
            widgets={layout.widgets}
            renderWidget={(shell) => (
              <Suspense fallback={<WidgetTileSkeleton shell={shell} />}>
                <WidgetTile
                  dashboardId={layout.dashboard.dashboardId}
                  shell={shell}
                  query={{}}
                  share={{ token, query: effective }}
                  {...(rights.detail ? { detailHref: viewHref({ widget: shell.widgetId }) } : {})}
                />
              </Suspense>
            )}
          />
        )}
      </div>

      {openWidgetId ? (
        <DetailOverlay
          closeHref={viewHref({ widget: undefined })}
          title={detail?.widget.title ?? t('detail.title')}
        >
          {detail ? (
            <WidgetDetail
              detail={detail}
              exportControl={
                rights.export ? (
                  <ExportMenu
                    action={exportAction}
                    formats={['csv']}
                    widgetId={detail.widget.widgetId}
                    timeRange={timeRange}
                    comparison={comparison}
                    stateLabel={stateLabel}
                    idPrefix="shared-detail"
                  />
                ) : undefined
              }
            />
          ) : (
            <Callout tone="critical" title={t('detail.loadFailedTitle')}>
              {t('detail.loadFailedBody')}
            </Callout>
          )}
        </DetailOverlay>
      ) : null}
    </PublicFrame>
  );
}

/** The frame around a shared view: the product's name, nothing to navigate. */
async function PublicFrame({
  children,
  token,
}: {
  readonly children: React.ReactNode;
  readonly token?: string;
}) {
  const t = await getTranslations();
  return (
    <div className={styles.frame}>
      {token ? <ThemeStyle shareToken={token} /> : null}
      <header className={styles.bar}>
        <span className={styles.brand}>{t('product.name')}</span>
        <span className={styles.badge}>{t('shared.badge')}</span>
      </header>
      <main id="main-content" className={styles.main}>
        {children}
      </main>
      <footer className={styles.footer}>{t('shared.footer')}</footer>
    </div>
  );
}

/**
 * One page for every link that does not work. It does not say whether the
 * link was revoked, expired or never existed: that is the owner's business.
 */
async function Unavailable() {
  const t = await getTranslations();
  return (
    <PublicFrame>
      <div className={styles.narrow}>
        <h1>{t('shared.unavailableTitle')}</h1>
        <p>{t('shared.unavailableBody')}</p>
        <p className="text-secondary">{t('shared.unavailableAction')}</p>
      </div>
    </PublicFrame>
  );
}

function asPreset(value: string | undefined): TimeRangePreset | undefined {
  return TIME_RANGE_PRESETS.includes(value as TimeRangePreset) && value !== 'custom'
    ? (value as TimeRangePreset)
    : undefined;
}

function asComparison(value: string | undefined): ComparisonMode | undefined {
  return COMPARISON_MODES.includes(value as ComparisonMode) && value !== 'custom'
    ? (value as ComparisonMode)
    : undefined;
}
