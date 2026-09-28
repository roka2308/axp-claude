import {
  AppError,
  type AnalyticsResult,
  type Breakpoint,
  type CalculationStep,
  type ComparisonMode,
  type DashboardLayoutPresentation,
  type DashboardPresentation,
  type DashboardSnapshot,
  type DataQualityNote,
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
  type WidgetDetailAction,
  type WidgetDetailPresentation,
  type WidgetPresentation,
  type WidgetUnavailableReason,
} from '@axp/contracts';
import type { Logger } from '@axp/observability';
import type { AnalyticsQueryEngine } from '../analytics/query-engine';
import { resolveComparison, resolveTimeRange } from '../analytics/calendar';
import type { SemanticService } from '../semantic/semantic-service';
import { evaluateFormula } from '../semantic/formula';
import { bandFor, evaluateScore } from '../semantic/score';
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

export interface BuildDetailInput extends BuildPresentationInput {
  readonly widgetId: string;
  /** Capabilities the caller holds, for deciding which actions are offered. */
  readonly capabilities: readonly string[];
  /** Where a "open the definition" action would lead. */
  readonly projectId: string;
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

  /**
   * The dashboard without its numbers (Master Spec §11).
   *
   * Answered from the snapshot alone: no Matomo call, so it is fast and cannot
   * fail for a data-source reason. The widgets are then fetched one request
   * each, which is what "widgets load and fail independently" means in
   * practice - the layout does not wait for the slowest metric, and a widget
   * that fails leaves the rest of the dashboard standing.
   */
  buildLayout(input: BuildPresentationInput): DashboardLayoutPresentation {
    const timeRange = resolveTimeRange({
      preset: input.timeRangePreset,
      timezone: input.site.timezone,
      now: this.deps.clock.now(),
      from: input.from,
      to: input.to,
    });
    const comparison = resolveComparison(timeRange, input.comparisonMode);

    return {
      dashboard: input.meta,
      timeRange,
      ...(comparison.mode === 'none' ? {} : { comparison }),
      dataScope: this.dataScope(input),
      breakpoint: input.breakpoint,
      widgets: input.snapshot.widgets.map((widget) => ({
        widgetId: widget.id,
        family: widget.family,
        title: widget.title,
        placement: widget.placement,
      })),
      annotations: [],
    };
  }

  /**
   * One widget's values.
   *
   * Never throws for a data reason: a failure becomes the widget's state, with
   * the cause preserved, because the caller is rendering one tile in a grid
   * that is already on screen (D10).
   */
  async buildTile(
    input: BuildPresentationInput & { widgetId: string },
  ): Promise<WidgetPresentation> {
    const widget = input.snapshot.widgets.find((candidate) => candidate.id === input.widgetId);
    if (!widget) {
      throw new AppError('not_found', {
        code: 'widget_not_found',
        messageKey: 'widget.not_found',
        internalMessage: `Widget ${input.widgetId} is not part of this dashboard.`,
      });
    }

    const timeRange = resolveTimeRange({
      preset: input.timeRangePreset,
      timezone: input.site.timezone,
      now: this.deps.clock.now(),
      from: input.from,
      to: input.to,
    });

    try {
      return await this.buildWidget(widget, input, timeRange, input.comparisonMode);
    } catch (error) {
      this.deps.logger.warn({ err: error, widgetId: widget.id }, 'Widget presentation failed');
      return unavailableWidget(widget, toUnavailableReason(error));
    }
  }

  /**
   * Builds the Widget Detail View (D4, Master Spec §11).
   *
   * Inherits everything the dashboard had - time range, comparison, data
   * scope, fixed filters, permissions - by taking the same input the grid was
   * built from. A detail view computed from a different context would answer a
   * different question than the tile it was opened from, which is worse than
   * having no detail view at all.
   */
  async buildDetail(input: BuildDetailInput): Promise<WidgetDetailPresentation> {
    const widget = input.snapshot.widgets.find((candidate) => candidate.id === input.widgetId);
    if (!widget) {
      throw new AppError('not_found', {
        code: 'widget_not_found',
        messageKey: 'widget.not_found',
        internalMessage: `Widget ${input.widgetId} is not part of this dashboard.`,
      });
    }

    const timeRange = resolveTimeRange({
      preset: input.timeRangePreset,
      timezone: input.site.timezone,
      now: this.deps.clock.now(),
      from: input.from,
      to: input.to,
    });
    const comparison = resolveComparison(timeRange, input.comparisonMode);

    // The tile itself, built exactly as the grid builds it. One code path, so
    // the header and the core value cannot drift apart.
    const tile = await this.buildWidget(widget, input, timeRange, input.comparisonMode).catch(
      (error: unknown) => {
        this.deps.logger.warn(
          { err: error, widgetId: widget.id },
          'Widget detail presentation failed',
        );
        return unavailableWidget(widget, toUnavailableReason(error));
      },
    );

    /*
     * The two extra modules are best-effort. A detail view whose breakdown
     * could not be fetched still answers the questions its other modules
     * answer; failing the whole overlay would throw those away too.
     */
    const [visualisation, explanation] = await Promise.all([
      this.detailVisualisation(widget, tile, input).catch(() => undefined),
      this.explain(widget, input).catch(() => undefined),
    ]);

    const breakdown =
      tile.content?.kind === 'table' && widget.data.dimension
        ? { dimension: widget.data.dimension, content: tile.content }
        : undefined;

    return {
      dashboard: input.meta,
      timeRange,
      ...(comparison.mode === 'none' ? {} : { comparison }),
      dataScope: this.dataScope(input),
      widget: tile,
      ...(visualisation ? { visualisation } : {}),
      ...(breakdown ? { breakdown } : {}),
      ...(explanation && explanation.length > 0 ? { explanation } : {}),
      actions: this.detailActions(widget, tile, input),
    };
  }

  /**
   * The larger visualisation: the same question over time.
   *
   * A card answers "how many"; the detail view answers "how it moved". For a
   * widget that is already a time series or a breakdown, the tile is the larger
   * visualisation, and drawing a second one would be decoration.
   */
  private async detailVisualisation(
    widget: WidgetConfig,
    tile: WidgetPresentation,
    input: BuildDetailInput,
  ): Promise<WidgetContent | undefined> {
    if (queryKindFor(widget) !== 'scalar') return undefined;
    if (widget.data.semanticVersionIds.length === 0) return undefined;
    if (tile.state === 'missing' || tile.state === 'unavailable') return undefined;

    const result = await this.deps.engine.execute({
      kind: 'series',
      tenantId: input.tenantId,
      projectId: input.projectId,
      siteId: input.site.id,
      semanticVersionIds: widget.data.semanticVersionIds,
      timeRangePreset: input.timeRangePreset,
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      comparisonMode: widget.presentation.showComparison ? input.comparisonMode : 'none',
      fixedFilters: [...input.snapshot.fixedFilters, ...widget.data.fixedFilters],
      permissionContextId: input.permissionContextId,
    });

    if (result.kind !== 'series') return undefined;

    const descriptions = await this.deps.semantics.describeVersions(widget.data.semanticVersionIds);
    return {
      kind: 'time_series',
      series: result.series,
      labels: result.series.map(
        (series) => descriptions.get(series.semanticVersionId)?.name ?? 'Kennzahl',
      ),
    };
  }

  /**
   * How a formula or score arrived at its value (D4).
   *
   * Re-evaluated here rather than carried through the query engine, because the
   * engine deliberately drops the leaves it only fetched to feed a derivation -
   * the dashboard asked for "Engagement Rate", not for the two counts behind
   * it. The explanation is the one place that wants them back.
   */
  private async explain(
    widget: WidgetConfig,
    input: BuildDetailInput,
  ): Promise<readonly CalculationStep[] | undefined> {
    const versionId = widget.data.semanticVersionIds[0];
    if (!versionId) return undefined;

    const [version] = await this.deps.semantics.resolveVersions([versionId]);
    if (!version) return undefined;
    if (version.body.kind !== 'formula' && version.body.kind !== 'score') return undefined;

    const leafIds = version.dependencyVersionIds;
    if (leafIds.length === 0) return undefined;

    const result = await this.deps.engine.execute({
      kind: 'scalar',
      tenantId: input.tenantId,
      projectId: input.projectId,
      siteId: input.site.id,
      semanticVersionIds: leafIds,
      timeRangePreset: input.timeRangePreset,
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      comparisonMode: 'none',
      fixedFilters: [...input.snapshot.fixedFilters, ...widget.data.fixedFilters],
      permissionContextId: input.permissionContextId,
    });

    const values = new Map(
      result.kind === 'scalar'
        ? result.metrics.map((metric) => [metric.semanticVersionId, metric.value])
        : [],
    );
    const described = await this.deps.semantics.describeVersions(leafIds);
    const names = new Map([...described].map(([id, entry]) => [id, entry.name]));

    const decimals = version.body.decimals;
    const unit = unitOf(version.body);
    const step = (
      label: string,
      value: ValueEnvelope,
      extra: Partial<CalculationStep> = {},
    ): CalculationStep => ({
      label,
      value,
      formatted: formatValue(value, decimals, unit, input.locale),
      ...extra,
    });

    if (version.body.kind === 'formula') {
      const { trace } = evaluateFormula(version.body.ast, { values, names });
      return trace.map((entry, index) =>
        step(entry.label, entry.value, index === trace.length - 1 ? { isResult: true } : {}),
      );
    }

    const evaluation = evaluateScore(version.body, { values, names });
    const componentSteps = evaluation.components.map((component) =>
      step(component.label, component.input, {
        sharePercent: Math.round(component.normalisedWeight * 100),
        ...(component.points === null ? {} : { points: component.points }),
      }),
    );

    return [...componentSteps, step('Score', evaluation.value, { isResult: true })];
  }

  /**
   * What the viewer can do from here (D4).
   *
   * Every action carries its own availability. An export that does not exist
   * yet is stated as such rather than rendered as a button that does nothing,
   * which is the same rule the navigation follows for unbuilt milestones.
   */
  private detailActions(
    widget: WidgetConfig,
    tile: WidgetPresentation,
    input: BuildDetailInput,
  ): readonly WidgetDetailAction[] {
    const canReadCatalog = input.capabilities.includes('semantic.read');

    return [
      { kind: 'copy_link', labelKey: 'detail.action.copyLink', available: true },
      {
        kind: 'open_definition',
        labelKey: 'detail.action.openDefinition',
        available: canReadCatalog && Boolean(tile.definition),
        ...(canReadCatalog && tile.definition
          ? { href: `/projects/${input.projectId}/semantics` }
          : {}),
        ...(canReadCatalog
          ? tile.definition
            ? {}
            : { unavailableKey: 'detail.action.openDefinitionNoDefinition' }
          : { unavailableKey: 'detail.action.openDefinitionNoAccess' }),
      },
      {
        kind: 'export',
        labelKey: 'detail.action.export',
        available: false,
        unavailableKey: 'detail.action.exportLaterMilestone',
      },
    ];
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
          actionKey: 'widget.no_metric_configured_action',
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
      // Quality notes ride along with the values that carry them, so a widget
      // cannot show a `warning` state without saying what the warning is
      // (Master Spec §18).
      dataQuality: qualityNotesOf(result),
      ...stateMessageOf(result, state),
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

    const band =
      described?.body.kind === 'score' && hasNumericValue(metric.value)
        ? bandFor(metric.value.value, described.body.evaluation)
        : undefined;

    return {
      ...(metric as MetricPresentation),
      label: described?.name ?? 'Kennzahl',
      unit: unitOf(described?.body),
      decimals,
      formatted: formatValue(metric.value, decimals, unitOf(described?.body), locale),
      ...(band ? { evaluation: { label: band.key, band: band.band } } : {}),
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

  /*
   * A widget takes a value's absence state only when every value shares it.
   * Previously `unknown`, `not_tracked` and `not_applicable` fell through to
   * `ready`, and a card whose only value was unreadable rendered as a blank
   * number - exactly the silent gap the state model forbids (D10).
   */
  for (const absence of [
    'empty',
    'unavailable',
    'missing',
    'unknown',
    'not_tracked',
    'not_applicable',
  ] as const) {
    if (envelopes.every((value) => value.state === absence)) return absence;
  }

  if (envelopes.some((value) => value.state === 'warning')) return 'warning';
  if (envelopes.every((value) => value.state === 'zero')) return 'zero';
  return 'ready';
}

/**
 * The reason behind a widget's absence state, taken from its first value.
 *
 * Only for the states that carry no number: a ready widget needs no excuse,
 * and a warning explains itself through its data-quality notes.
 */
function stateMessageOf(
  result: AnalyticsResult,
  state: WidgetPresentation['state'],
): Pick<WidgetPresentation, 'stateMessage'> {
  if (state === 'ready' || state === 'zero' || state === 'warning') return {};

  const envelopes: ValueEnvelope[] =
    result.kind === 'scalar'
      ? result.metrics.map((metric) => metric.value)
      : result.kind === 'series'
        ? result.series.flatMap((series) => series.points.map((point) => point.value))
        : result.rows.flatMap((row) => row.metrics.map((metric) => metric.value));

  const first = envelopes.find((value) => value.state === state);
  if (!first) return {};

  switch (first.state) {
    case 'unknown':
    case 'not_tracked':
    case 'not_applicable':
      return first.messageKey ? { stateMessage: { messageKey: first.messageKey } } : {};

    case 'unavailable':
      return { stateMessage: { messageKey: 'widget.source_unavailable' } };

    case 'missing':
      switch (first.cause.kind) {
        case 'no_mapping':
          return {
            stateMessage: {
              messageKey: 'widget.missing.no_mapping',
              messageParams: { requirement: first.cause.requirement },
            },
          };
        case 'source_field_absent':
          return {
            stateMessage: {
              messageKey: 'widget.missing.source_field_absent',
              messageParams: { requirement: first.cause.requirement },
            },
          };
        case 'not_calculable':
          return {
            stateMessage: {
              messageKey: 'widget.missing.not_calculable',
              messageParams: { inputs: first.cause.missingInputs.join(', ') },
            },
          };
        case 'other':
          return { stateMessage: { messageKey: first.cause.messageKey } };
      }
      return {};

    default:
      return {};
  }
}

/**
 * Every data-quality note attached to any value in a result, de-duplicated.
 *
 * A note repeated across thirty daily points is one note about the period, not
 * thirty notes; showing it thirty times would bury it.
 */
function qualityNotesOf(result: AnalyticsResult): DataQualityNote[] {
  const envelopes: ValueEnvelope[] =
    result.kind === 'scalar'
      ? result.metrics.flatMap((metric) => [
          metric.value,
          ...(metric.comparison ? [metric.comparison.value] : []),
        ])
      : result.kind === 'series'
        ? result.series.flatMap((series) => series.points.map((point) => point.value))
        : result.rows.flatMap((row) => row.metrics.map((metric) => metric.value));

  const seen = new Map<string, DataQualityNote>();
  for (const envelope of envelopes) {
    if (envelope.state !== 'warning') continue;
    for (const note of envelope.notes) {
      seen.set(`${note.severity}|${note.messageKey}|${JSON.stringify(note.details ?? {})}`, note);
    }
  }
  return [...seen.values()];
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
          actionKey: 'widget.capability_unsupported_action',
        };
      case 'setup_required':
        return {
          causeState: 'setup_required',
          messageKey: error.messageKey,
          actionKey: 'widget.setup_required_action',
        };
      case 'source_unavailable':
        return {
          causeState: 'temporarily_unavailable',
          messageKey: 'widget.source_unavailable',
          actionKey: 'widget.source_unavailable_action',
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
