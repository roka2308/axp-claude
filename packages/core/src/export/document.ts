import {
  type DashboardPresentation,
  hasNumericValue,
  type Locale,
  type MetricPresentation,
  type ValueEnvelope,
  type ValueState,
  type WidgetFamily,
  type WidgetPresentation,
} from '@axp/contracts';
import { exportLabels, type ExportLabels, fill } from './labels';

/**
 * The export document: one normalised reading of a presentation model.
 *
 * Every format - PDF, XLSX, PPTX, CSV - renders from this, and this is built
 * only from the presentation model the screen reads (Shared Contract §10).
 * That is what keeps a file and the dashboard it came from saying the same
 * thing: the formats differ in layout, never in content.
 *
 * Two rules live here rather than in each renderer:
 *   - a value without a number is written as its state in words, never as
 *     a zero or an empty cell (D10);
 *   - the file says what it describes: scope, period, comparison, version and
 *     when it was made travel with the numbers.
 */

/** One table cell. `number` is present only when the value really is one. */
export interface ExportCell {
  readonly text: string;
  readonly number?: number;
  readonly decimals?: number;
  readonly state?: ValueState;
}

export interface ExportTable {
  readonly columns: readonly { readonly label: string; readonly numeric: boolean }[];
  readonly rows: readonly (readonly ExportCell[])[];
}

export interface ExportMetric {
  readonly label: string;
  readonly value: ExportCell;
  readonly unit: string;
  readonly unitLabel: string;
  readonly evaluation?: { readonly label: string; readonly band: number };
  readonly comparison?: ExportCell;
  /** Relative change in percent, when both sides carry a number. */
  readonly change?: ExportCell;
}

export interface ExportChart {
  readonly dates: readonly string[];
  readonly series: readonly {
    readonly label: string;
    readonly role: 'primary' | 'comparison';
    readonly values: readonly (number | null)[];
  }[];
  readonly decimals: number;
  readonly unit: string;
}

export type ExportWidgetKind = 'metrics' | 'series' | 'table' | 'text' | 'annotations' | 'none';

export interface ExportWidget {
  readonly id: string;
  readonly title: string;
  readonly family: WidgetFamily;
  readonly kind: ExportWidgetKind;
  readonly state: ValueState;
  readonly stateLabel: string;
  /** Why the widget shows no values, in words. */
  readonly message?: string;
  readonly context?: string;
  readonly definition?: string;
  readonly dataQuality: readonly string[];
  readonly metrics?: readonly ExportMetric[];
  readonly chart?: ExportChart;
  /** Every widget with values has one: charts ship their data (D10). */
  readonly table?: ExportTable;
  readonly text?: string;
}

export interface ExportMetaRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface ExportDocument {
  readonly locale: Locale;
  readonly labels: ExportLabels;
  readonly title: string;
  readonly description?: string;
  readonly tenantName: string;
  readonly meta: readonly ExportMetaRow[];
  /** Short form for footers: "Letzte 7 Tage (22.09.2026 – 28.09.2026)". */
  readonly periodText: string;
  readonly generatedAt: Date;
  readonly generatedAtText: string;
  readonly widgets: readonly ExportWidget[];
  /** File name without extension, safe on every file system. */
  readonly fileBase: string;
}

export interface ExportDocumentContext {
  readonly locale: Locale;
  readonly generatedAt: Date;
  /** `share`: the file was requested through an external link. */
  readonly audience: 'internal' | 'share';
  readonly shareExpiresAt?: Date;
}

export function buildExportDocument(
  presentation: DashboardPresentation,
  context: ExportDocumentContext,
): ExportDocument {
  const labels = exportLabels(context.locale);
  const timezone = presentation.dataScope.siteTimezone;
  const range = presentation.timeRange;
  const periodText = `${labels.presets[range.preset]} (${formatDate(range.from, context.locale)} – ${formatDate(range.to, context.locale)})`;

  const comparison = presentation.comparison;
  const comparisonText =
    comparison && comparison.mode !== 'none' && comparison.from && comparison.to
      ? `${labels.comparisons[comparison.mode]} (${formatDate(comparison.from, context.locale)} – ${formatDate(comparison.to, context.locale)})`
      : labels.meta.noComparison;

  const filters = presentation.dataScope.filters;
  const generatedAtText = formatInstant(context.generatedAt, timezone, context.locale);

  const fetched = presentation.widgets
    .map((widget) => widget.freshness?.fetchedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const oldestFetch = fetched[0];

  const meta: ExportMetaRow[] = [
    { key: 'dashboard', label: labels.meta.dashboard, value: presentation.dashboard.name },
    { key: 'tenant', label: labels.meta.tenant, value: presentation.dashboard.tenantName },
    // The project is how a customer organises its own work; a recipient of a
    // shared link sees the customer and the site, which is what the numbers
    // are about.
    ...(context.audience === 'internal'
      ? [{ key: 'project', label: labels.meta.project, value: presentation.dashboard.projectName }]
      : []),
    { key: 'site', label: labels.meta.site, value: presentation.dataScope.siteName },
    { key: 'timezone', label: labels.meta.timezone, value: timezone },
    { key: 'period', label: labels.meta.period, value: periodText },
    { key: 'comparison', label: labels.meta.comparison, value: comparisonText },
    {
      key: 'filters',
      label: labels.meta.filters,
      value:
        filters.length === 0
          ? labels.meta.noFilters
          : filters.map((filter) => `${filter.label}: ${filter.value}`).join('; '),
    },
    ...(presentation.dashboard.publishedVersion !== null
      ? [
          {
            key: 'version',
            label: labels.meta.versionLabel,
            value: fill(labels.meta.version, { version: presentation.dashboard.publishedVersion }),
          },
        ]
      : []),
    { key: 'generatedAt', label: labels.meta.generatedAt, value: generatedAtText },
    ...(oldestFetch
      ? [
          {
            key: 'dataFetchedAt',
            label: labels.meta.dataFetchedAt,
            value: formatInstant(new Date(oldestFetch), timezone, context.locale),
          },
        ]
      : []),
    ...(context.audience === 'share' && context.shareExpiresAt
      ? [
          {
            key: 'share',
            label: labels.meta.shareLabel,
            value: fill(labels.meta.sharedView, {
              date: formatInstant(context.shareExpiresAt, timezone, context.locale),
            }),
          },
        ]
      : []),
  ];

  const ordered = [...presentation.widgets].sort(
    (a, b) =>
      a.placement.desktop.y - b.placement.desktop.y ||
      a.placement.desktop.x - b.placement.desktop.x,
  );

  return {
    locale: context.locale,
    labels,
    title: presentation.dashboard.name,
    ...(presentation.dashboard.description
      ? { description: presentation.dashboard.description }
      : {}),
    tenantName: presentation.dashboard.tenantName,
    meta,
    periodText,
    generatedAt: context.generatedAt,
    generatedAtText,
    widgets: ordered.map((widget) => exportWidget(widget, context.locale, labels)),
    fileBase: `${slug(presentation.dashboard.name)}_${range.from}_${range.to}`,
  };
}

/** One widget, read into the normalised shape. */
export function exportWidget(
  widget: WidgetPresentation,
  locale: Locale,
  labels: ExportLabels = exportLabels(locale),
): ExportWidget {
  const base = {
    id: widget.widgetId,
    title: widget.title,
    family: widget.family,
    state: widget.state,
    stateLabel: labels.states[widget.state],
    ...messageOf(widget, labels),
    ...(widget.context ? { context: widget.context } : {}),
    ...(widget.definition
      ? {
          definition: `${widget.definition.name} · ${labels.units[widget.definition.unit] ?? widget.definition.unit} · v${widget.definition.semanticVersion}`,
        }
      : {}),
    dataQuality: widget.dataQuality.map((note) =>
      fill(labels.messages[note.messageKey] ?? labels.messages['quality.unspecified']!, {
        ...(note.details ?? {}),
      }),
    ),
  };

  const content = widget.content;
  if (!content || widget.state === 'unavailable' || widget.state === 'not_applicable') {
    return { ...base, kind: 'none' };
  }

  switch (content.kind) {
    case 'card': {
      const metrics = content.metrics.map((metric) => exportMetric(metric, locale, labels));
      return {
        ...base,
        kind: 'metrics',
        metrics,
        table: {
          columns: [
            { label: labels.columns.metric, numeric: false },
            { label: labels.columns.value, numeric: true },
            { label: labels.columns.unit, numeric: false },
            { label: labels.columns.evaluation, numeric: false },
            { label: labels.columns.comparisonValue, numeric: true },
            { label: `${labels.columns.change} (%)`, numeric: true },
          ],
          rows: metrics.map((metric) => [
            { text: metric.label },
            metric.value,
            { text: metric.unitLabel },
            { text: metric.evaluation?.label ?? '' },
            metric.comparison ?? { text: '' },
            metric.change ?? { text: '' },
          ]),
        },
      };
    }

    case 'time_series': {
      const [primary] = content.series;
      if (!primary) return { ...base, kind: 'none' };
      const decimals = content.decimals?.[0] ?? 0;
      const unit = content.units?.[0] ?? 'count';
      const label = content.labels[0] ?? widget.title;
      const dates = primary.points.map((point) => formatDate(point.date, locale));

      const series: ExportChart['series'][number][] = [
        {
          label,
          role: 'primary',
          values: primary.points.map((point) =>
            hasNumericValue(point.value) ? point.value.value : null,
          ),
        },
      ];
      if (primary.comparisonPoints) {
        series.push({
          label: labels.comparisonSeries,
          role: 'comparison',
          values: primary.comparisonPoints.map((point) =>
            hasNumericValue(point.value) ? point.value.value : null,
          ),
        });
      }

      return {
        ...base,
        kind: 'series',
        chart: { dates, series, decimals, unit },
        table: {
          columns: [
            { label: labels.columns.date, numeric: false },
            { label: withUnit(label, unit, labels), numeric: true },
            ...(primary.comparisonPoints
              ? [{ label: withUnit(labels.comparisonSeries, unit, labels), numeric: true }]
              : []),
          ],
          rows: primary.points.map((point, index) => [
            { text: dates[index]! },
            cellOf(point.value, decimals, locale, labels),
            ...(primary.comparisonPoints
              ? [
                  primary.comparisonPoints[index]
                    ? cellOf(primary.comparisonPoints[index].value, decimals, locale, labels)
                    : { text: '' },
                ]
              : []),
          ]),
        },
      };
    }

    case 'table': {
      const [dimension, ...measures] = content.columns;
      const hasComparison = content.rows.some((row) =>
        row.metrics.some((metric) => metric.comparison),
      );
      return {
        ...base,
        kind: 'table',
        table: {
          columns: [
            { label: dimension?.label ?? labels.columns.key, numeric: false },
            ...measures.map((column) => ({
              label: withUnit(column.label, column.unit ?? 'count', labels),
              numeric: true,
            })),
            ...(hasComparison
              ? measures.map((column) => ({
                  label: `${column.label} – ${labels.comparisonSeries}`,
                  numeric: true,
                }))
              : []),
          ],
          rows: content.rows.map((row) => {
            const measured = measures.map((column) => {
              const metric = row.metrics.find((entry) => entry.semanticVersionId === column.key);
              return metric
                ? cellOf(metric.value, column.decimals ?? 0, locale, labels)
                : { text: labels.states.missing, state: 'missing' as const };
            });
            const compared = hasComparison
              ? measures.map((column) => {
                  const metric = row.metrics.find(
                    (entry) => entry.semanticVersionId === column.key,
                  );
                  return metric?.comparison
                    ? cellOf(metric.comparison.value, column.decimals ?? 0, locale, labels)
                    : { text: '' };
                })
              : [];
            return [{ text: row.label }, ...measured, ...compared];
          }),
        },
      };
    }

    case 'annotations':
      return {
        ...base,
        kind: 'annotations',
        table: {
          columns: [
            { label: labels.columns.date, numeric: false },
            { label: labels.columns.title, numeric: false },
            { label: labels.columns.description, numeric: false },
          ],
          rows: content.entries.map((entry) => [
            { text: formatDate(entry.date, locale) },
            { text: entry.title },
            { text: entry.description ?? '' },
          ]),
        },
      };

    case 'text':
      return { ...base, kind: 'text', text: content.body };
  }
}

function exportMetric(
  metric: MetricPresentation,
  locale: Locale,
  labels: ExportLabels,
): ExportMetric {
  const comparison = metric.comparison;
  const ratio = comparison?.changeRatio;
  return {
    label: metric.label,
    value: cellOf(metric.value, metric.decimals, locale, labels, metric.formatted),
    unit: metric.unit,
    unitLabel: labels.units[metric.unit] ?? metric.unit,
    ...(metric.evaluation ? { evaluation: metric.evaluation } : {}),
    ...(comparison
      ? { comparison: cellOf(comparison.value, metric.decimals, locale, labels) }
      : {}),
    ...(comparison
      ? {
          change:
            ratio === undefined
              ? { text: labels.noComparableValue }
              : {
                  text: `${ratio > 0 ? '+' : ''}${formatNumber(ratio * 100, 1, locale)} %`,
                  number: Math.round(ratio * 1000) / 10,
                  decimals: 1,
                },
        }
      : {}),
  };
}

/**
 * A value as a cell: its number when it has one, its state in words when not.
 *
 * The single place where "missing is never zero" is decided for every file
 * format at once.
 */
export function cellOf(
  value: ValueEnvelope,
  decimals: number,
  locale: Locale,
  labels: ExportLabels,
  formatted?: string,
): ExportCell {
  if (hasNumericValue(value)) {
    return {
      text:
        formatted && formatted.length > 0 ? formatted : formatNumber(value.value, decimals, locale),
      number: value.value,
      decimals,
      state: value.state,
    };
  }
  return { text: labels.states[value.state], state: value.state };
}

function messageOf(widget: WidgetPresentation, labels: ExportLabels): { message?: string } {
  const source = widget.unavailable ?? widget.stateMessage;
  if (!source) return {};
  const template = labels.messages[source.messageKey];
  return {
    message: template ? fill(template, source.messageParams ?? {}) : labels.states[widget.state],
  };
}

function withUnit(label: string, unit: string, labels: ExportLabels): string {
  if (unit === 'percent' || unit === 'seconds') return `${label} (${labels.units[unit]})`;
  return label;
}

export function formatNumber(value: number, decimals: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'de-DE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** A calendar date (`YYYY-MM-DD`, already in site time) for reading. */
export function formatDate(date: string, locale: Locale): string {
  const [year, month, day] = date.split('-');
  if (!year || !month || !day) return date;
  return locale === 'en' ? `${year}-${month}-${day}` : `${day}.${month}.${year}`;
}

/** An instant, shown in the site's time zone with the zone named. */
export function formatInstant(instant: Date, timezone: string, locale: Locale): string {
  const text = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'de-DE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
  return `${text} (${timezone})`;
}

/** ASCII, lower case, no separators the file system could trip over. */
export function slug(value: string): string {
  const ascii = value
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  const cleaned = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'dashboard';
}
