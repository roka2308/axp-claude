import { CORE_NATIVE_METRICS, type DashboardSnapshot, type WidgetConfig } from '@axp/contracts';
import type { Container } from '@axp/core';

/**
 * The reference dashboard of the first vertical slice (Master Spec §27).
 *
 * `Portal Overview` with a KPI card, a time series and a top-pages table, then
 * published - the exact shape Gate F1 asks to demonstrate.
 */

export const DEMO_CONNECTION_NAME = 'Matomo Demo (Mock)';
export const DEMO_DASHBOARD_NAME = 'Portal Overview';

/**
 * Mock connection URL. The scenario after `mock://` selects the adapter's
 * behaviour, so the demo runs without any Matomo installation.
 */
export const DEMO_CONNECTION_URL = 'mock://default';

export interface SeedDashboardResult {
  readonly connectionId: string;
  readonly siteId: string;
  readonly dashboardId: string;
  readonly publishedVersion: number;
}

export async function seedReferenceDashboard(
  container: Container,
  params: { tenantId: string; projectId: string; actorUserId: string },
): Promise<SeedDashboardResult> {
  const { tenantId, projectId, actorUserId } = params;

  // 1. A Matomo connection at tenant level.
  const existingConnections = await container.matomo.listConnections(tenantId);
  const connection =
    existingConnections.find((candidate) => candidate.name === DEMO_CONNECTION_NAME) ??
    (await container.matomo.createConnection({
      tenantId,
      name: DEMO_CONNECTION_NAME,
      baseUrl: DEMO_CONNECTION_URL,
      // The mock accepts any sufficiently long token; it is still sealed at
      // rest, so the storage path is exercised exactly as in production.
      token: 'demo-token-not-a-real-credential',
      actorUserId,
    }));

  // 2. Capability detection, stored as a snapshot.
  await container.matomo.refreshCapabilities(tenantId, connection.id, actorUserId);

  // 3. Import the site and assign it to the project.
  const { siteId } = await container.matomo.importSite(tenantId, connection.id, 1, actorUserId);
  await container.matomo.assignSiteToProject(tenantId, projectId, siteId, actorUserId);

  // 4. The native metrics the slice needs.
  await container.semantics.ensureCoreNativeMetrics();
  const visits = await container.semantics.getActiveVersionByPortableId(CORE_NATIVE_METRICS.visits);
  const pageviews = await container.semantics.getActiveVersionByPortableId(
    CORE_NATIVE_METRICS.pageviews,
  );

  if (!visits || !pageviews) {
    throw new Error('Core native metrics are missing after seeding.');
  }

  // 5. The dashboard itself.
  const existing = await container.dashboards.listForProject(tenantId, projectId);
  const already = existing.find((dashboard) => dashboard.name === DEMO_DASHBOARD_NAME);

  const draft = already
    ? await container.dashboards.getDraft(tenantId, already.id)
    : await container.dashboards.createDashboard({
        tenantId,
        projectId,
        siteId,
        name: DEMO_DASHBOARD_NAME,
        description: 'Reichweite und Nutzung des Mitarbeiterportals im Überblick.',
        actorUserId,
      });

  const snapshot: DashboardSnapshot = {
    ...draft.snapshot,
    siteId,
    widgets: buildWidgets(visits.version.id, pageviews.version.id),
  };

  const saved = await container.dashboards.saveDraft({
    tenantId,
    dashboardId: draft.dashboardId,
    expectedRevisionId: draft.revisionId,
    snapshot,
    actorUserId,
  });

  const published = await container.dashboards.publish({
    tenantId,
    dashboardId: saved.dashboardId,
    actorUserId,
  });

  return {
    connectionId: connection.id,
    siteId,
    dashboardId: published.dashboardId,
    publishedVersion: published.version,
  };
}

/**
 * Layout on the 12-column desktop raster.
 *
 * Two KPI cards side by side, the trend beside them, the ranking below - the
 * arrangement the reference demo describes. Tablet and mobile placements are
 * deliberately absent: derived layouts are not stored, only overrides are (D2).
 */
function buildWidgets(visitsVersionId: string, pageviewsVersionId: string): WidgetConfig[] {
  return [
    {
      id: 'kpi-visits',
      family: 'card',
      title: 'Besuche',
      placement: { desktop: { x: 0, y: 0, w: 3, h: 2 } },
      data: { semanticVersionIds: [visitsVersionId], fixedFilters: [] },
      presentation: { variant: 'kpi_comparison', showComparison: true, decimals: 0 },
      context: {
        description: 'Anzahl der Besuche im gewählten Zeitraum.',
        showDefinition: true,
      },
    },
    {
      id: 'kpi-pageviews',
      family: 'card',
      title: 'Seitenaufrufe',
      placement: { desktop: { x: 3, y: 0, w: 3, h: 2 } },
      data: { semanticVersionIds: [pageviewsVersionId], fixedFilters: [] },
      presentation: { variant: 'kpi_comparison', showComparison: true, decimals: 0 },
      context: {
        description: 'Anzahl der aufgerufenen Seiten im gewählten Zeitraum.',
        showDefinition: true,
      },
    },
    {
      id: 'series-visits',
      family: 'time_series',
      title: 'Besuche im Zeitverlauf',
      placement: { desktop: { x: 6, y: 0, w: 6, h: 4 } },
      data: { semanticVersionIds: [visitsVersionId], fixedFilters: [] },
      presentation: { showComparison: true },
      context: { showDefinition: true },
    },
    {
      id: 'table-top-pages',
      family: 'flexible_table',
      title: 'Meistbesuchte Seiten',
      placement: { desktop: { x: 0, y: 2, w: 6, h: 4 } },
      data: {
        semanticVersionIds: [pageviewsVersionId],
        dimension: 'page_url',
        topN: 8,
        fixedFilters: [],
      },
      presentation: { showComparison: false },
      context: { showDefinition: false },
    },
  ];
}
