import { z } from 'zod';
import type { ValueEnvelope } from './states.js';

/**
 * Analytics query contract (Shared Contract §9, Master Spec §19).
 *
 * Every query makes its context explicit: which tenant, which project, which
 * site, which semantic versions, which time range. Nothing is implied by
 * ambient state, because authorization and tenant isolation are decided from
 * exactly these fields on the server.
 */

/** Presets from Master Spec §19. `custom` carries explicit dates. */
export const TIME_RANGE_PRESETS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'current_week',
  'previous_week',
  'current_month',
  'previous_month',
  'current_quarter',
  'previous_quarter',
  'current_year',
  'previous_year',
  'custom',
] as const;

export const timeRangePresetSchema = z.enum(TIME_RANGE_PRESETS);
export type TimeRangePreset = z.infer<typeof timeRangePresetSchema>;

/** Calendar date `YYYY-MM-DD`, interpreted in the Matomo site time zone. */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD calendar date.');
export type CalendarDate = string;

/**
 * A resolved, inclusive date range.
 *
 * Resolution happens server-side against the site time zone: the analytics
 * calendar follows Matomo, not the browser and not the server (Master Spec §19).
 */
export const timeRangeSchema = z.object({
  preset: timeRangePresetSchema,
  from: calendarDateSchema,
  to: calendarDateSchema,
});
export type TimeRange = z.infer<typeof timeRangeSchema>;

export const COMPARISON_MODES = ['none', 'previous_period', 'prior_year', 'custom'] as const;
export const comparisonModeSchema = z.enum(COMPARISON_MODES);
export type ComparisonMode = z.infer<typeof comparisonModeSchema>;

export const comparisonSpecSchema = z.object({
  mode: comparisonModeSchema,
  /** Present once resolved; required as input only for `custom`. */
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});
export type ComparisonSpec = z.infer<typeof comparisonSpecSchema>;

/** Granularity of a time series. Derived from the range unless pinned. */
export const TIME_GRANULARITIES = ['day', 'week', 'month'] as const;
export const timeGranularitySchema = z.enum(TIME_GRANULARITIES);
export type TimeGranularity = z.infer<typeof timeGranularitySchema>;

/**
 * A fixed filter configured by the dashboard editor.
 *
 * Viewers see these as read-only Data Scope: only time range and comparison are
 * interactive in MVP (D4).
 */
export interface FilterSpec {
  readonly field: string;
  readonly operator: 'equals' | 'contains' | 'starts_with' | 'in';
  readonly value: string | readonly string[];
  /** Human-readable label for the Data Scope display. */
  readonly labelKey?: string;
}

/** What shape of answer a query asks for. */
export const ANALYTICS_QUERY_KINDS = ['scalar', 'series', 'breakdown'] as const;
export const analyticsQueryKindSchema = z.enum(ANALYTICS_QUERY_KINDS);
export type AnalyticsQueryKind = z.infer<typeof analyticsQueryKindSchema>;

/**
 * The only shape in which the platform asks for analytics.
 *
 * `permissionContextId` ties the query to the authorization decision that
 * allowed it, so a cache entry can never be reused across permission contexts.
 */
export interface NormalizedAnalyticsQuery {
  readonly kind: AnalyticsQueryKind;
  readonly tenantId: string;
  readonly projectId: string;
  readonly siteId: string;
  /** Pinned semantic version ids - never definition ids (Shared Contract §7). */
  readonly semanticVersionIds: readonly string[];
  readonly dimensions: readonly string[];
  readonly timeRange: TimeRange;
  readonly granularity?: TimeGranularity;
  readonly comparison?: ComparisonSpec;
  readonly fixedFilters: readonly FilterSpec[];
  readonly limit?: number;
  readonly permissionContextId: string;
}

/** One measured value, with the comparison value beside it when requested. */
export interface MetricValue {
  readonly semanticVersionId: string;
  readonly value: ValueEnvelope;
  readonly comparison?: ComparisonValue;
}

/**
 * Comparison result.
 *
 * `change` and `changeRatio` are only present when both sides carry a number.
 * A comparison against a missing or zero baseline is not silently rendered as
 * a percentage - the states travel with the values.
 */
export interface ComparisonValue {
  readonly value: ValueEnvelope;
  readonly change?: number;
  readonly changeRatio?: number;
  /** True when the baseline is zero, so a ratio would be meaningless. */
  readonly baselineZero?: boolean;
}

export interface TimeSeriesPoint {
  /** Period start, `YYYY-MM-DD` in site time zone. */
  readonly date: CalendarDate;
  readonly value: ValueEnvelope;
}

export interface TimeSeries {
  readonly semanticVersionId: string;
  readonly granularity: TimeGranularity;
  readonly points: readonly TimeSeriesPoint[];
  /** Aligned comparison series; same length and order as `points`. */
  readonly comparisonPoints?: readonly TimeSeriesPoint[];
}

export interface BreakdownRow {
  readonly label: string;
  /** Stable key for the row, used for selection and export. */
  readonly key: string;
  readonly metrics: readonly MetricValue[];
}

export interface AnalyticsFreshness {
  readonly fetchedAt: string;
  /** True when the value came from the ephemeral in-memory cache. */
  readonly fromCache: boolean;
  /** Site time zone the calendar was resolved in. */
  readonly siteTimezone: string;
}

/**
 * The result of one analytics query.
 *
 * Never persisted (Master Spec §4): it exists in memory, travels to the
 * browser, and may sit in a short-lived RAM cache. A discriminated union so a
 * caller cannot read rows off a scalar result.
 */
export type AnalyticsResult =
  | {
      readonly kind: 'scalar';
      readonly metrics: readonly MetricValue[];
      readonly freshness: AnalyticsFreshness;
    }
  | {
      readonly kind: 'series';
      readonly series: readonly TimeSeries[];
      readonly freshness: AnalyticsFreshness;
    }
  | {
      readonly kind: 'breakdown';
      readonly rows: readonly BreakdownRow[];
      readonly totalRows: number;
      readonly hasMore: boolean;
      readonly freshness: AnalyticsFreshness;
    };

/** Cache key for the ephemeral result cache. */
export type CacheKey = string;

/**
 * Short-lived, non-persistent analytics cache (Shared Contract §5).
 *
 * The interface exists so a persistent implementation could be added later -
 * but a persistent analytics cache is On Hold and must not be enabled without
 * its own security and privacy decision.
 */
export interface AnalyticsResultCache {
  get(key: CacheKey): Promise<AnalyticsResult | null>;
  set(key: CacheKey, value: AnalyticsResult, ttlMs: number): Promise<void>;
  delete(key: CacheKey): Promise<void>;
  clear(): Promise<void>;
}
