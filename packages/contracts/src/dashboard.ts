import { z } from 'zod';
import type { ComparisonSpec, FilterSpec, TimeRange } from './analytics.js';
import type { DashboardLifecycle } from './lifecycle.js';

/**
 * Dashboard contract (Master Spec §9 and §21, Shared Contract §8).
 *
 * A dashboard has a stable identity, one mutable draft and immutable published
 * versions. Publishing copies the draft into a new version; editing the draft
 * afterwards never touches what viewers see.
 */

/** The seven MVP widget families (Master Spec §20). No others exist. */
export const WIDGET_FAMILIES = [
  'card',
  'time_series',
  'bar',
  'donut',
  'flexible_table',
  'context_text',
  'annotation_event_list',
] as const;

export const widgetFamilySchema = z.enum(WIDGET_FAMILIES);
export type WidgetFamily = z.infer<typeof widgetFamilySchema>;

/** Card variants (D2). Hero KPI is a card variant, not a family of its own. */
export const CARD_VARIANTS = [
  'kpi',
  'kpi_comparison',
  'kpi_sparkline',
  'hero_kpi',
  'score',
  'score_evaluation',
] as const;
export const cardVariantSchema = z.enum(CARD_VARIANTS);
export type CardVariant = z.infer<typeof cardVariantSchema>;

export const BREAKPOINTS = ['desktop', 'tablet', 'mobile'] as const;
export const breakpointSchema = z.enum(BREAKPOINTS);
export type Breakpoint = z.infer<typeof breakpointSchema>;

/** The binding raster: 12 / 8 / 4 columns (D2). */
export const GRID_COLUMNS: Readonly<Record<Breakpoint, number>> = {
  desktop: 12,
  tablet: 8,
  mobile: 4,
};

export const gridPlacementSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type GridPlacement = z.infer<typeof gridPlacementSchema>;

/**
 * Placement per breakpoint.
 *
 * Desktop is authored; tablet and mobile are derived automatically. A derived
 * layout is NOT stored - only a deliberate user override is, so resetting an
 * override means deleting a field rather than recomputing a guess (D2).
 */
export const responsivePlacementSchema = z.object({
  desktop: gridPlacementSchema,
  tablet: gridPlacementSchema.optional(),
  mobile: gridPlacementSchema.optional(),
});
export type ResponsivePlacement = z.infer<typeof responsivePlacementSchema>;

/** Minimum and recommended sizes per family (D2). */
export interface WidgetSizeRules {
  readonly minW: number;
  readonly minH: number;
  readonly recommendedW: number;
  readonly recommendedH: number;
}

export const WIDGET_SIZE_RULES: Readonly<Record<WidgetFamily, WidgetSizeRules>> = {
  card: { minW: 2, minH: 2, recommendedW: 3, recommendedH: 3 },
  time_series: { minW: 4, minH: 3, recommendedW: 6, recommendedH: 5 },
  bar: { minW: 3, minH: 3, recommendedW: 6, recommendedH: 4 },
  donut: { minW: 3, minH: 3, recommendedW: 4, recommendedH: 4 },
  flexible_table: { minW: 4, minH: 3, recommendedW: 6, recommendedH: 5 },
  context_text: { minW: 2, minH: 1, recommendedW: 4, recommendedH: 2 },
  annotation_event_list: { minW: 3, minH: 2, recommendedW: 4, recommendedH: 4 },
};

/** Which semantic definitions a widget shows, and how it slices them. */
export interface WidgetDataConfig {
  /**
   * Pinned semantic VERSION ids in a published snapshot; definition ids may
   * appear in a draft before the first publish resolves them.
   */
  readonly semanticVersionIds: readonly string[];
  readonly dimension?: string;
  readonly topN?: number;
  readonly fixedFilters: readonly FilterSpec[];
}

export interface WidgetPresentationConfig {
  readonly variant?: string;
  readonly showComparison: boolean;
  /** Straight line segments only - no decorative curve smoothing (D2). */
  readonly showSparkline?: boolean;
  readonly decimals?: number;
}

export interface WidgetContextConfig {
  /** Short explanation shown in the widget and the detail view. */
  readonly descriptionKey?: string;
  readonly description?: string;
  readonly showDefinition: boolean;
}

export interface WidgetConfig {
  readonly id: string;
  readonly family: WidgetFamily;
  readonly title: string;
  readonly placement: ResponsivePlacement;
  readonly data: WidgetDataConfig;
  readonly presentation: WidgetPresentationConfig;
  readonly context: WidgetContextConfig;
}

/**
 * The complete content of a dashboard at one point in time.
 *
 * Stored as one document: a published version is an immutable snapshot, and
 * making publish atomic is then a single row insert rather than a
 * multi-table dance.
 */
export interface DashboardSnapshot {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly description?: string;
  readonly siteId: string;
  readonly defaultTimeRange: TimeRange;
  readonly defaultComparison: ComparisonSpec;
  readonly fixedFilters: readonly FilterSpec[];
  readonly widgets: readonly WidgetConfig[];
}

export interface DashboardRef {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly name: string;
  readonly lifecycle: DashboardLifecycle;
  readonly publishedVersion: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly updatedAt: string;
}

/**
 * Publish validation (D3).
 *
 * Blocking errors and warnings are deliberately separate: a warning informs,
 * an error stops. Collapsing them would make publishing either unsafe or
 * needlessly obstructive.
 */
export interface PublishIssue {
  readonly widgetId?: string;
  readonly messageKey: string;
  readonly messageParams?: Readonly<Record<string, string | number>>;
}

export interface PublishImpact {
  readonly changedWidgetIds: readonly string[];
  readonly addedWidgetIds: readonly string[];
  readonly removedWidgetIds: readonly string[];
  readonly semanticVersionChanges: readonly {
    readonly semanticName: string;
    readonly fromVersion: number | null;
    readonly toVersion: number;
  }[];
  readonly blockingErrors: readonly PublishIssue[];
  readonly warnings: readonly PublishIssue[];
  readonly canPublish: boolean;
}
