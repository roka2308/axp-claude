import type {
  AnalyticsFreshness,
  BreakdownRow,
  ComparisonSpec,
  MetricValue,
  TimeRange,
  TimeSeries,
} from './analytics.js';
import type { Breakpoint, ResponsivePlacement, WidgetFamily } from './dashboard.js';
import type { ProductCauseState, DataQualityNote, ValueState } from './states.js';

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

export interface WidgetPresentation {
  readonly widgetId: string;
  readonly family: WidgetFamily;
  readonly title: string;
  readonly placement: ResponsivePlacement;
  /** The D10 state the renderer must honour. */
  readonly state: ValueState;
  readonly content?: WidgetContent;
  readonly unavailable?: WidgetUnavailableReason;
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

export interface DashboardPresentation {
  readonly dashboard: PresentationMeta;
  readonly timeRange: TimeRange;
  readonly comparison?: ComparisonSpec;
  readonly dataScope: DataScopePresentation;
  readonly breakpoint: Breakpoint;
  readonly widgets: readonly WidgetPresentation[];
  readonly annotations: readonly AnnotationPresentation[];
}
