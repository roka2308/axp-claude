import type {
  AnalyticsFreshness,
  BreakdownRow,
  ComparisonSpec,
  MetricValue,
  TimeRange,
  TimeSeries,
} from './analytics.js';
import type { Breakpoint, ResponsivePlacement, WidgetFamily } from './dashboard.js';
import type { ProductCauseState, DataQualityNote, ValueEnvelope, ValueState } from './states.js';

/**
 * Presentation model (Shared Contract §10).
 *
 * The single shape every renderer consumes: the web viewer today, PDF, XLSX and
 * PPTX in Phase 7. Exports are therefore not screenshots of React - they read
 * the same model the screen reads, which is what keeps an exported dashboard
 * semantically identical to the one on screen.
 */

export interface PresentationMeta {
  readonly dashboardId: string;
  readonly name: string;
  readonly description?: string;
  /** Null while previewing a draft. */
  readonly publishedVersion: number | null;
  readonly isDraftPreview: boolean;
  readonly projectName: string;
  readonly tenantName: string;
}

/**
 * The read-only Data Scope shown to viewers (D4).
 *
 * Visible so a number can be interpreted, but not editable: only time range
 * and comparison are interactive in MVP.
 */
export interface DataScopePresentation {
  readonly siteName: string;
  readonly siteTimezone: string;
  readonly filters: readonly {
    readonly labelKey?: string;
    readonly label: string;
    readonly value: string;
  }[];
}

/** Why a widget cannot show data, when that is the case. */
export interface WidgetUnavailableReason {
  readonly causeState: ProductCauseState;
  readonly messageKey: string;
  readonly messageParams?: Readonly<Record<string, string | number>>;
  /** What the user can do, when there is something concrete. */
  readonly actionKey?: string;
}

export interface MetricPresentation extends MetricValue {
  readonly label: string;
  readonly unit: string;
  readonly decimals: number;
  /** Pre-formatted for the current locale, so exports match the screen. */
  readonly formatted: string;
  readonly comparisonFormatted?: string;
  /**
   * For a score with an evaluation scheme: the band its value falls into.
   * The label is the scheme's own word and always travels with the band
   * colour - a band is never a colour alone (D9, D10).
   */
  readonly evaluation?: { readonly label: string; readonly band: 1 | 2 | 3 | 4 | 5 };
}

export type WidgetContent =
  | {
      readonly kind: 'card';
      readonly metrics: readonly MetricPresentation[];
      readonly sparkline?: TimeSeries;
    }
  | {
      readonly kind: 'time_series';
      readonly series: readonly TimeSeries[];
      readonly labels: readonly string[];
    }
  | {
      readonly kind: 'table';
      readonly columns: readonly {
        readonly key: string;
        readonly label: string;
        readonly unit?: string;
      }[];
      readonly rows: readonly BreakdownRow[];
      readonly totalRows: number;
      readonly hasMore: boolean;
    }
  | {
      readonly kind: 'annotations';
      readonly entries: readonly AnnotationPresentation[];
    }
  | { readonly kind: 'text'; readonly body: string };

/**
 * The definition behind a number.
 *
 * Definitions and score explanations are core product, not a tooltip
 * afterthought (D4): the detail view builds on exactly this.
 */
export interface WidgetDefinitionPresentation {
  readonly name: string;
  readonly description?: string;
  readonly unit: string;
  readonly scope: string;
  readonly semanticVersion: number;
  /** For formulas and scores: the inputs and how they combined. */
  readonly inputs?: readonly {
    readonly name: string;
    readonly formatted: string;
  }[];
}

/**
 * One step of how a number came about (D4).
 *
 * Score explanations are core product, not a debugging aid: a score nobody can
 * take apart is a number nobody acts on. Each step keeps its own value state,
 * so a step that could not be computed says so rather than showing a gap.
 */
export interface CalculationStep {
  readonly label: string;
  readonly value: ValueEnvelope;
  /** Formatted for the current locale, so an export reads like the screen. */
  readonly formatted: string;
  /** For a score component: its weight as a share of the whole, in percent. */
  readonly sharePercent?: number;
  /** For a score component: points on the 0-100 scale, when it had a value. */
  readonly points?: number;
  /** True for the final result, which is the one people read first. */
  readonly isResult?: boolean;
}

/**
 * Something the viewer can do from the detail view (D4).
 *
 * Carries its own availability. An action that is not possible here is stated
 * and explained rather than rendered as a button that does nothing (D10).
 */
export interface WidgetDetailAction {
  readonly kind: 'copy_link' | 'open_definition' | 'export';
  readonly labelKey: string;
  readonly available: boolean;
  /** Where the action leads, for the ones that are navigations. */
  readonly href?: string;
  /** Why it is not available, when it is not. */
  readonly unavailableKey?: string;
}

/**
 * Widget Detail View (D4, Master Spec §11).
 *
 * Inherits the whole context of the dashboard it was opened from - time range,
 * comparison, data scope, fixed filters and permissions - because a detail
 * view that answered a different question than the tile would be worse than no
 * detail view.
 *
 * The modules are in the order the specification gives, which is relevance
 * order: header, core value, a larger visualisation, the definition, context,
 * data quality, the breakdown, and finally actions.
 */
export interface WidgetDetailPresentation {
  readonly dashboard: PresentationMeta;
  readonly timeRange: TimeRange;
  readonly comparison?: ComparisonSpec;
  readonly dataScope: DataScopePresentation;
  /** The widget exactly as the grid shows it, so the two cannot disagree. */
  readonly widget: WidgetPresentation;
  /**
   * The same question at a finer granularity.
   *
   * A card on the dashboard becomes a time series here: the tile answers "how
   * many", the detail view answers "how it moved".
   */
  readonly visualisation?: WidgetContent;
  /** The dimension behind the number, when there is one worth splitting by. */
  readonly breakdown?: {
    readonly dimension: string;
    readonly content: Extract<WidgetContent, { kind: 'table' }>;
  };
  /** How a formula or score arrived at its value. Absent for a plain metric. */
  readonly explanation?: readonly CalculationStep[];
  readonly actions: readonly WidgetDetailAction[];
}

export interface WidgetPresentation {
  readonly widgetId: string;
  readonly family: WidgetFamily;
  readonly title: string;
  readonly placement: ResponsivePlacement;
  /** The D10 state the renderer must honour. */
  readonly state: ValueState;
  readonly content?: WidgetContent;
  readonly unavailable?: WidgetUnavailableReason;
  /**
   * Why the values are in the state they are in, when the source said.
   *
   * "Nicht erfasst" is a state; "diese Website erfasst diesen Bericht nicht" is
   * the reason, and it is what tells a reader whether to do something about
   * it (D10). Absent for states that need no explanation.
   */
  readonly stateMessage?: {
    readonly messageKey: string;
    readonly messageParams?: Readonly<Record<string, string | number>>;
  };
  readonly dataQuality: readonly DataQualityNote[];
  readonly definition?: WidgetDefinitionPresentation;
  readonly freshness?: AnalyticsFreshness;
  readonly context?: string;
}

export interface AnnotationPresentation {
  readonly id: string;
  readonly title: string;
  readonly date: string;
  readonly category?: string;
  readonly description?: string;
}

/**
 * A widget before its data has been asked for.
 *
 * The grid can be drawn from this alone, which is what lets each widget fetch
 * its own values independently: the layout does not wait for the slowest
 * metric, and one widget failing leaves the others in place (Master Spec §11).
 */
export interface WidgetShell {
  readonly widgetId: string;
  readonly family: WidgetFamily;
  readonly title: string;
  readonly placement: ResponsivePlacement;
}

/**
 * Everything about a dashboard except its numbers.
 *
 * Answered without touching Matomo, so it is fast and cannot fail for a
 * data-source reason. The widgets arrive afterwards, one request each.
 */
export interface DashboardLayoutPresentation {
  readonly dashboard: PresentationMeta;
  readonly timeRange: TimeRange;
  readonly comparison?: ComparisonSpec;
  readonly dataScope: DataScopePresentation;
  readonly breakpoint: Breakpoint;
  readonly widgets: readonly WidgetShell[];
  readonly annotations: readonly AnnotationPresentation[];
}

export interface DashboardPresentation {
  readonly dashboard: PresentationMeta;
  readonly timeRange: TimeRange;
  readonly comparison?: ComparisonSpec;
  readonly dataScope: DataScopePresentation;
  readonly breakpoint: Breakpoint;
  readonly widgets: readonly WidgetPresentation[];
  readonly annotations: readonly AnnotationPresentation[];
}
