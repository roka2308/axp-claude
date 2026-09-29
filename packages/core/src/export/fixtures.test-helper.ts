import type { DashboardPresentation, WidgetPresentation } from '@axp/contracts';

/**
 * A presentation model with one widget of every kind and every awkward case
 * an export must survive: a missing value, an evaluation band, a comparison,
 * a gap in a series, a text that looks like a spreadsheet formula.
 */
export function samplePresentation(): DashboardPresentation {
  const place = (x: number, y: number) => ({ desktop: { x, y, w: 3, h: 2 } });
  const widgets: WidgetPresentation[] = [
    {
      widgetId: 'w-pulse',
      family: 'card',
      title: 'PULSE',
      placement: place(0, 0),
      state: 'ready',
      content: {
        kind: 'card',
        metrics: [
          {
            semanticVersionId: 'v-pulse',
            value: { state: 'ready', value: 40.32 },
            comparison: {
              value: { state: 'ready', value: 38.1 },
              change: 2.22,
              changeRatio: 0.0583,
            },
            label: 'PULSE Score',
            unit: 'score',
            decimals: 2,
            formatted: '40,32',
            evaluation: { label: 'solide', band: 3 },
          },
        ],
      },
      dataQuality: [],
      freshness: {
        fetchedAt: '2026-09-29T08:00:00.000Z',
        fromCache: false,
        siteTimezone: 'Europe/Berlin',
      },
    },
    {
      widgetId: 'w-missing',
      family: 'card',
      title: 'Creation Rate',
      placement: place(3, 0),
      state: 'missing',
      content: {
        kind: 'card',
        metrics: [
          {
            semanticVersionId: 'v-creation',
            value: { state: 'missing', cause: { kind: 'no_mapping', requirement: 'Creators' } },
            label: 'Creation Rate',
            unit: 'percent',
            decimals: 0,
            formatted: '',
          },
        ],
      },
      stateMessage: {
        messageKey: 'widget.missing.no_mapping',
        messageParams: { requirement: 'Creators' },
      },
      dataQuality: [],
    },
    {
      widgetId: 'w-trend',
      family: 'time_series',
      title: 'Aktive Nutzer:innen',
      placement: place(0, 2),
      state: 'ready',
      content: {
        kind: 'time_series',
        labels: ['Aktive Nutzer:innen'],
        units: ['count'],
        decimals: [0],
        series: [
          {
            semanticVersionId: 'v-active',
            granularity: 'day',
            points: [
              { date: '2026-09-22', value: { state: 'ready', value: 700 } },
              { date: '2026-09-23', value: { state: 'ready', value: 720 } },
              {
                date: '2026-09-24',
                value: { state: 'unavailable', cause: { kind: 'timeout' } } as never,
              },
              { date: '2026-09-25', value: { state: 'ready', value: 690 } },
              { date: '2026-09-26', value: { state: 'zero', value: 0 } },
            ],
            comparisonPoints: [
              { date: '2026-09-15', value: { state: 'ready', value: 650 } },
              { date: '2026-09-16', value: { state: 'ready', value: 660 } },
              { date: '2026-09-17', value: { state: 'ready', value: 640 } },
              { date: '2026-09-18', value: { state: 'ready', value: 655 } },
              { date: '2026-09-19', value: { state: 'ready', value: 600 } },
            ],
          },
        ],
      },
      dataQuality: [{ severity: 'information', messageKey: 'quality.period_partially_processed' }],
    },
    {
      widgetId: 'w-pages',
      family: 'flexible_table',
      title: 'Beliebte Seiten',
      placement: place(6, 2),
      state: 'ready',
      content: {
        kind: 'table',
        columns: [
          { key: 'label', label: 'Seite' },
          { key: 'v-views', label: 'Seitenaufrufe', unit: 'count', decimals: 0 },
        ],
        rows: [
          {
            key: '/start',
            label: '=HYPERLINK("http://evil.example")',
            metrics: [{ semanticVersionId: 'v-views', value: { state: 'ready', value: 1234 } }],
          },
          {
            key: '/news',
            label: 'News',
            metrics: [{ semanticVersionId: 'v-views', value: { state: 'not_tracked' } }],
          },
        ],
        totalRows: 2,
        hasMore: false,
      },
      dataQuality: [],
    },
    {
      widgetId: 'w-text',
      family: 'context_text',
      title: 'Hinweis',
      placement: place(0, 4),
      state: 'ready',
      content: {
        kind: 'text',
        body: 'Werte werden täglich aktualisiert – „Pulse“ ist ein Demo-Score.',
      },
      dataQuality: [],
    },
  ];

  return {
    dashboard: {
      dashboardId: 'd-1',
      name: 'Executive Health Overview',
      description: 'Gesundheit des Mitarbeiterportals',
      publishedVersion: 3,
      isDraftPreview: false,
      projectName: 'Employee Portal',
      tenantName: 'Demo Kunde',
    },
    timeRange: { preset: 'last_7_days', from: '2026-09-22', to: '2026-09-28' },
    comparison: { mode: 'previous_period', from: '2026-09-15', to: '2026-09-21' },
    dataScope: {
      siteName: 'Employee Portal Demo Site',
      siteTimezone: 'Europe/Berlin',
      filters: [{ label: 'Bereich', value: 'Intranet' }],
    },
    breakpoint: 'desktop',
    widgets,
    annotations: [],
  };
}
