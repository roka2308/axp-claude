import {
  AppError,
  type AnalyticsResult,
  type Breakpoint,
  type ComparisonMode,
  type DashboardPresentation,
  type DashboardSnapshot,
  type DataScopePresentation,
  hasNumericValue,
  type Locale,
  type MetricPresentation,
  type PresentationMeta,
  type SemanticDefinitionBody,
  type TimeRange,
  type TimeRangePreset,
  type ValueEnvelope,
  type WidgetConfig,
  type WidgetContent,
  type WidgetPresentation,
  type WidgetUnavailableReason,
} from '@axp/contracts';
import type { Logger } from '@axp/observability';
import type { AnalyticsQueryEngine } from '../analytics/query-engine';
import { resolveComparison, resolveTimeRange } from '../analytics/calendar';
import type { SemanticService } from '../semantic/semantic-service';
import type { Clock } from '../clock';

export interface PresentationBuilderDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly engine: AnalyticsQueryEngine;
  readonly semantics: SemanticService;
}

export interface BuildPresentationInput {
  readonly snapshot: DashboardSnapshot;
  readonly meta: PresentationMeta;
  readonly tenantId: string;
  readonly projectId: string;
  readonly site: {
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
  };
  readonly timeRangePreset: TimeRangePreset;
  readonly from?: string;
  readonly to?: string;
  readonly comparisonMode: ComparisonMode;
  readonly breakpoint: Breakpoint;
  readonly locale: Locale;
  readonly permissionContextId: string;
}

/**
 * Builds the presentation model (Shared Contract §10).
 *
 * Two properties of this builder matter beyond assembling data:
 *
 *   - widgets load and fail independently. One unreachable metric produces one
 *     widget in an `unavailable` state, not a broken dashboard (Master Spec §11).
 *   - every value keeps its state. A widget whose data is missing says so;
 *     nothing here turns an absence into a zero.
 */
export class PresentationBuilder {
  constructor(private readonly deps: PresentationBuilderDeps) {}

  async build(input: BuildPresentationInput): Promise<DashboardPresentation> {
    const timeRange = resolveTimeRange({
      preset: input.timeRangePreset,
      timezone: input.site.timezone,
      now: this.deps.clock.now(),
      from: input.from,
      to: input.to,
    });

    const comparison = resolveComparison(timeRange, input.comparisonMode);

    // allSettled, not all: a rejected widget must not reject the dashboard.
    const results = await Promise.allSettled(
      input.snapshot.widgets.map((widget) =>
        this.buildWidget(widget, input, timeRange, input.comparisonMode),
      ),
    );

    const widgets = results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;

      const widget = input.snapshot.widgets[index]!;
      this.deps.logger.warn(
        { err: result.reason, widgetId: widget.id },
        'Widget presentation failed',
      );
      return unavailableWidget(widget, toUnavailableReason(result.reason));
    });

    return {
      dashboard: input.meta,
      timeRange,
      ...(comparison.mode === 'none' ? {} : { comparison }),
      dataScope: this.dataScope(input),
      breakpoint: input.breakpoint,
      widgets,
      annotations: [],
    };
  }

  private dataScope(input: BuildPresentationInput): DataScopePresentation {
    return {
      siteName: input.site.name,
      siteTimezone: input.site.timezone,
      // Fixed filters are visible but read-only in the viewer (D4).
      filters: input.snapshot.fixedFilters.map((filter) => ({
        ...(filter.labelKey ? { labelKey: filter.labelKey } : {}),
        label: filter.field,
        value: Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value),
      })),
    };
  }

  private async buildWidget(
    widget: WidgetConfig,
    input: BuildPresentationInput,
    timeRange: TimeRange,
    comparisonMode: ComparisonMode,
  ): Promise<WidgetPresentation> {
    if (widget.family === 'context_text') {
      return {
        widgetId: widget.id,
        family: widget.family,
        title: widget.title,
        placement: widget.placement,
        state: 'ready',
        content: { kind: 'text', body: widget.context.description ?? '' },
        dataQuality: [],
      };
    }

    /*
     * An annotation list shows product annotations, not measurements, so it
     * asks Matomo nothing. Until annotations exist (Phase 4) the list is
     * genuinely empty - which is a state, not a failure, and says so.
     */
    if (widget.family === 'annotation_event_list') {
      return {
        widgetId: widget.id,
        family: widget.family,
        title: widget.title,
        placement: widget.placement,
        state: 'empty',
        content: { kind: 'annotations', entries: [] },
        dataQuality: [],
        ...(widget.context.description ? { context: widget.context.description } : {}),
      };
    }

    if (widget.data.semanticVersionIds.length === 0) {
      return {
        widgetId: widget.id,
        family: widget.family,
        title: widget.title,
        placement: widget.placement,
        state: 'not_applicable',
        unavailable: {
          causeState: 'setup_required',
          messageKey: 'widget.no_metric_configured',
          actionKey: 'widget.no_metric_configured.action',
        },
        dataQuality: [],
      };
    }

    const kind = queryKindFor(widget);
    const result = await this.deps.engine.execute({
      kind,
      tenantId: input.tenantId,
      projectId: input.projectId,
      siteId: input.site.id,
      semanticVersionIds: widget.data.semanticVersionIds,
      dimensions: widget.data.dimension ? [widget.data.dimension] : [],
      limit: widget.data.topN,
      timeRangePreset: input.timeRangePreset,
      from: input.from,
      to: input.to,
      comparisonMode: widget.presentation.showComparison ? comparisonMode : 'none',
      fixedFilters: [...input.snapshot.fixedFilters, ...widget.data.fixedFilters],
      permissionContextId: input.permissionContextId,
    });

    const descriptions = await this.deps.semantics.describeVersions(widget.data.semanticVersionIds);

    const content = this.toContent(widget, result, descriptions, input.locale);
    const state = deriveWidgetState(result);

    const firstVersionId = widget.data.semanticVersionIds[0];
    const described = firstVersionId ? descriptions.get(firstVersionId) : undefined;

    return {
      widgetId: widget.id,
      family: widget.family,
      title: widget.title,
      placement: widget.placement,
      state,
      content,
      dataQuality: [],
      freshness: result.freshness,
      ...(widget.context.description ? { context: widget.context.description } : {}),
      ...(widget.context.showDefinition && described
        ? {
            definition: {
              name: described.name,
              unit: unitOf(described.body),
              scope: scopeOf(described.body),
              semanticVersion: described.version,
            },
          }
        : {}),
    };
  }

  private toContent(
    widget: WidgetConfig,
    result: AnalyticsResult,
    descriptions: Map<string, { name: string; body: SemanticDefinitionBody; version: number }>,
    locale: Locale,
  ): WidgetContent {
    switch (result.kind) {
      case 'scalar':
        return {
          kind: 'card',
          metrics: result.metrics.map((metric) =>
            this.toMetricPresentation(metric, descriptions, locale),
          ),
        };

      case 'series':
        return {
          kind: 'time_series',
          series: result.series,
          labels: result.series.map(
            (series) => descriptions.get(series.semanticVersionId)?.name ?? 'Kennzahl',
          ),
        };

      case 'breakdown':
        return {
          kind: 'table',
          columns: [
            { key: 'label', label: labelForDimension(widget.data.dimension) },
            ...widget.data.semanticVersionIds.map((versionId) => ({
              key: versionId,
              label: descriptions.get(versionId)?.name ?? 'Kennzahl',
              unit: unitOf(descriptions.get(versionId)?.body),
            })),
          ],
          rows: result.rows,
          totalRows: result.totalRows,
          hasMore: result.hasMore,
        };
    }
  }

  private toMetricPresentation(
    metric: { semanticVersionId: string; value: ValueEnvelope; comparison?: unknown },
    descriptions: Map<string, { name: string; body: SemanticDefinitionBody; version: number }>,
    locale: Locale,
  ): MetricPresentation {
    const described = descriptions.get(metric.semanticVersionId);
    const decimals = described && 'decimals' in described.body ? described.body.decimals : 0;

    return {
      ...(metric as MetricPresentation),
      label: described?.name ?? 'Kennzahl',
      unit: unitOf(described?.body),
      decimals,
      formatted: formatValue(metric.value, decimals, unitOf(described?.body), locale),
    };
  }
}

/** Which query shape a widget family needs. */
function queryKindFor(widget: WidgetConfig): 'scalar' | 'series' | 'breakdown' {
  // Bar and donut are the same question drawn differently: a breakdown.

  switch (widget.family) {
    case 'time_series':
      return 'series';
    case 'flexible_table':
    case 'bar':
    case 'donut':
      return 'breakdown';
    default:
      return 'scalar';
  }
}

/**
 * The widget's state, derived from the values it actually received.
 *
 * `empty` and `zero` are distinct outcomes and stay distinct here: a valid
 * query that returned nothing is not the same as one that measured nothing.
 */
function deriveWidgetState(result: AnalyticsResult): WidgetPresentation['state'] {
  const envelopes: ValueEnvelope[] =
    result.kind === 'scalar'
      ? result.metrics.map((metric) => metric.value)
      : result.kind === 'series'
        ? result.series.flatMap((series) => series.points.map((point) => point.value))
        : result.rows.flatMap((row) => row.metrics.map((metric) => metric.value));

  if (result.kind === 'breakdown' && result.rows.length === 0) return 'empty';
  if (envelopes.length === 0) return 'empty';
  if (envelopes.every((value) => value.state === 'empty')) return 'empty';
  if (envelopes.some((value) => value.state === 'warning')) return 'warning';
  if (envelopes.every((value) => value.state === 'unavailable')) return 'unavailable';
  if (envelopes.every((value) => value.state === 'missing')) return 'missing';
  if (envelopes.every((value) => value.state === 'zero')) return 'zero';
  return 'ready';
}

function unavailableWidget(
  widget: WidgetConfig,
  reason: WidgetUnavailableReason,
): WidgetPresentation {
  return {
    widgetId: widget.id,
    family: widget.family,
    title: widget.title,
    placement: widget.placement,
    // `unavailable` is a temporary-source state, distinct from missing data and
    // from a permission problem (D10).
    state: reason.causeState === 'temporarily_unavailable' ? 'unavailable' : 'missing',
    unavailable: reason,
    dataQuality: [],
  };
}

/**
 * Maps a thrown error onto a cause the UI can render distinctly.
 *
 * The distinction D10 insists on: permission, entitlement, capability, setup
 * and temporary failure must not collapse into one generic error surface.
 */
function toUnavailableReason(error: unknown): WidgetUnavailableReason {
  if (AppError.isAppError(error)) {
    switch (error.category) {
      case 'permission_denied':
        return { causeState: 'permission_denied', messageKey: 'widget.permission_denied' };
      case 'entitlement_required':
        return { causeState: 'entitlement_required', messageKey: 'widget.entitlement_required' };
      case 'capability_unsupported':
        return {
          causeState: 'capability_unsupported',
          messageKey: error.messageKey,
          actionKey: 'widget.capability_unsupported.action',
        };
      case 'setup_required':
        return {
          causeState: 'setup_required',
          messageKey: error.messageKey,
          actionKey: 'widget.setup_required.action',
        };
      case 'source_unavailable':
        return {
          causeState: 'temporarily_unavailable',
          messageKey: 'widget.source_unavailable',
          actionKey: 'widget.source_unavailable.action',
        };
      default:
        break;
    }
  }
  return { causeState: 'temporarily_unavailable', messageKey: 'widget.unexpected_error' };
}

function unitOf(body: SemanticDefinitionBody | undefined): string {
  return body && 'unit' in body ? body.unit : 'count';
}

function scopeOf(body: SemanticDefinitionBody | undefined): string {
  return body && 'scope' in body ? body.scope : 'visit';
}

function labelForDimension(dimension: string | undefined): string {
  switch (dimension) {
    case 'page_title':
      return 'Seitentitel';
    case 'page_url':
      return 'Seite';
    default:
      return 'Dimension';
  }
}

/**
 * Formats a value for display.
 *
 * Only states that carry a number are formatted. Everything else returns an
 * empty string, and the renderer shows the state instead - which is what stops
 * "missing" from ever being painted as "0".
 */
export function formatValue(
  value: ValueEnvelope,
  decimals: number,
  unit: string,
  locale: Locale,
): string {
  if (!hasNumericValue(value)) return '';

  const formatter = new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const formatted = formatter.format(value.value);
  if (unit === 'percent') return `${formatted} %`;
  if (unit === 'seconds') return `${formatted} s`;
  return formatted;
}
