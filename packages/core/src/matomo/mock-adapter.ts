import { createHash } from 'node:crypto';
import {
  AppError,
  type AnalyticsResult,
  type BreakdownRow,
  type CalendarDate,
  type CapabilityProbeResult,
  type ConnectionTestInput,
  type ConnectionTestResult,
  deriveCompatibility,
  type MatomoCapabilityFingerprint,
  type MatomoCapability,
  type MatomoMetadataSnapshot,
  type MatomoSiteSummary,
  type MetricValue,
  type TimeSeries,
  type TimeSeriesPoint,
  type ValueEnvelope,
  hasNumericValue,
  valueEnvelope,
  CORE_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  TECHNICAL_CAPABILITIES,
} from '@axp/contracts';
import type { Clock } from '../clock';
import { addDays, compareDates, enumeratePeriods, isoWeekday } from '../analytics/calendar';
import {
  type MatomoConnector,
  NORMALIZED_DIMENSIONS,
  NORMALIZED_METRICS,
  type ResolvedConnection,
  type ResolvedQuery,
} from './connector';

/**
 * Mock Matomo adapter.
 *
 * Deterministic by construction: every value is derived from a hash of
 * (site, date, metric), so the same query always produces the same numbers.
 * That is what makes it usable in tests and in the canonical demo - a mock that
 * returns random data proves nothing and makes acceptance runs flaky.
 *
 * Scenarios are selected through the connection URL (`mock://<scenario>`), so a
 * fixture can exercise the D10 states without any special-casing in the
 * product code above the connector:
 *
 *   mock://default       healthy installation with full core capabilities
 *   mock://degraded      optional capabilities missing, core intact
 *   mock://limited       a core capability missing (page ranking)
 *   mock://empty         valid queries that legitimately return nothing
 *   mock://zero          real measured zeros, which are values and not gaps
 *   mock://unavailable   the source cannot be reached right now
 */
export type MockScenario = 'default' | 'degraded' | 'limited' | 'empty' | 'zero' | 'unavailable';

const MOCK_SCENARIOS: readonly MockScenario[] = [
  'default',
  'degraded',
  'limited',
  'empty',
  'zero',
  'unavailable',
];

/**
 * Source metrics that always produce one particular value state.
 *
 * The state model has ten states, and a fixture has to be able to show all of
 * them side by side (Gate F4). A scenario cannot do that on its own, because a
 * dashboard reads one site and therefore one connection: the states have to
 * vary per widget, which means per metric.
 *
 * Each one stands for a situation a real Matomo produces - a report the site
 * does not compute, a value that came back uninterpretable, a period that is
 * only partly processed, a report that answered 503. Named for the mock so
 * nobody mistakes them for product vocabulary; a fixture reaches them through
 * an ordinary `native_metric` source binding.
 */
export const MOCK_STATE_METRICS = {
  zero: 'mock_state_zero',
  empty: 'mock_state_empty',
  unknown: 'mock_state_unknown',
  notTracked: 'mock_state_not_tracked',
  notApplicable: 'mock_state_not_applicable',
  warning: 'mock_state_warning',
  unavailable: 'mock_state_unavailable',
} as const;

export const MOCK_CONNECTION_PREFIX = 'mock://';
export const MOCK_MATOMO_VERSION = '5.3.2';

/** Pages of the canonical Employee Portal demo, with stable relative weights. */
const DEMO_PAGES: readonly { path: string; title: string; weight: number }[] = [
  { path: '/', title: 'Startseite', weight: 0.28 },
  { path: '/news', title: 'Aktuelles', weight: 0.19 },
  { path: '/mitarbeiterangebote', title: 'Mitarbeiterangebote', weight: 0.14 },
  { path: '/it-service', title: 'IT-Service', weight: 0.11 },
  { path: '/personal/urlaub', title: 'Urlaub beantragen', weight: 0.09 },
  { path: '/kantine', title: 'Kantine', weight: 0.07 },
  { path: '/organisation', title: 'Organisation', weight: 0.06 },
  { path: '/suche', title: 'Suche', weight: 0.06 },
];

export class MockMatomoAdapter implements MatomoConnector {
  constructor(private readonly clock: Clock) {}

  async testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
    const scenario = scenarioFromUrl(input.baseUrl);

    if (!input.token || input.token.length < 8) {
      return {
        reachable: true,
        authenticated: false,
        matomoVersion: null,
        compatibility: 'unsupported',
        probes: [{ capability: 'auth_valid', state: 'unavailable' }],
        limitationKeys: [],
        errorKey: 'matomo.test.auth_failed',
      };
    }

    const probes = this.probesFor(scenario);
    return {
      reachable: scenario !== 'unavailable',
      authenticated: scenario !== 'unavailable',
      matomoVersion: MOCK_MATOMO_VERSION,
      compatibility: deriveCompatibility(probes, { versionCertified: true }),
      probes,
      limitationKeys: limitationsFor(scenario),
      ...(scenario === 'unavailable' ? { errorKey: 'matomo.test.unreachable' } : {}),
    };
  }

  async getCapabilityFingerprint(
    connection: ResolvedConnection,
  ): Promise<MatomoCapabilityFingerprint> {
    const scenario = scenarioFromUrl(connection.baseUrl);
    const probes = this.probesFor(scenario);

    return {
      connectionId: connection.connectionId,
      detectedAt: this.clock.now().toISOString(),
      matomoVersion: scenario === 'unavailable' ? null : MOCK_MATOMO_VERSION,
      compatibility: deriveCompatibility(probes, { versionCertified: true }),
      probes,
      limitationKeys: limitationsFor(scenario),
      siteCount: scenario === 'unavailable' ? null : 1,
    };
  }

  async listSites(connection: ResolvedConnection): Promise<MatomoSiteSummary[]> {
    this.assertReachable(connection);
    return [
      {
        matomoSiteId: 1,
        name: 'Employee Portal Demo Site',
        mainUrl: 'https://portal.example.invalid',
        timezone: 'Europe/Berlin',
        currency: 'EUR',
        ecommerceEnabled: false,
      },
    ];
  }

  async refreshMetadata(
    connection: ResolvedConnection,
    matomoSiteId: number,
  ): Promise<MatomoMetadataSnapshot> {
    this.assertReachable(connection);
    const [site] = await this.listSites(connection);
    const scenario = scenarioFromUrl(connection.baseUrl);

    return {
      siteId: String(matomoSiteId),
      refreshedAt: this.clock.now().toISOString(),
      site: site!,
      availableMetrics: Object.values(NORMALIZED_METRICS),
      availableDimensions: scenario === 'limited' ? [] : Object.values(NORMALIZED_DIMENSIONS),
    };
  }

  async execute(connection: ResolvedConnection, query: ResolvedQuery): Promise<AnalyticsResult> {
    this.assertReachable(connection);
    const scenario = scenarioFromUrl(connection.baseUrl);

    /*
     * One report answering 503 while the rest of the installation is fine. The
     * whole query fails, which is correct: the widget that asked for it is the
     * one that reports `unavailable`, and its neighbours are unaffected because
     * each widget queries on its own (Master Spec §11).
     */
    if (
      query.sourceMetrics.some((metric) => metric.sourceMetric === MOCK_STATE_METRICS.unavailable)
    ) {
      throw new AppError('source_unavailable', {
        code: 'mock_report_unavailable',
        messageKey: 'matomo.source_unavailable',
        internalMessage: `Mock report "${MOCK_STATE_METRICS.unavailable}" is deliberately unreachable.`,
      });
    }

    const freshness = {
      fetchedAt: this.clock.now().toISOString(),
      fromCache: false,
      siteTimezone: query.siteTimezone,
    };

    switch (query.kind) {
      case 'scalar':
        return { kind: 'scalar', metrics: this.scalarMetrics(query, scenario), freshness };
      case 'series':
        return { kind: 'series', series: this.timeSeries(query, scenario), freshness };
      case 'breakdown': {
        if (scenario === 'limited') {
          // A missing core capability blocks the affected use case only - it
          // does not make the whole connection unusable (Master Spec §22).
          throw new AppError('capability_unsupported', {
            code: 'page_ranking_unavailable',
            messageKey: 'matomo.capability.page_ranking_unavailable',
            internalMessage: 'Mock scenario "limited" has no page ranking capability.',
          });
        }
        const rows = scenario === 'empty' ? [] : this.breakdownRows(query, scenario);
        return {
          kind: 'breakdown',
          rows,
          totalRows: rows.length,
          hasMore: false,
          freshness,
        };
      }
    }
  }

  // --- value generation ----------------------------------------------------

  private scalarMetrics(query: ResolvedQuery, scenario: MockScenario): MetricValue[] {
    return query.sourceMetrics.map((metric) => {
      const value = this.totalFor(
        query,
        metric.sourceMetric,
        query.timeRange.from,
        query.timeRange.to,
        scenario,
      );

      if (!query.comparisonRange) {
        return { semanticVersionId: metric.semanticVersionId, value };
      }

      const baseline = this.totalFor(
        query,
        metric.sourceMetric,
        query.comparisonRange.from,
        query.comparisonRange.to,
        scenario,
      );

      return {
        semanticVersionId: metric.semanticVersionId,
        value,
        comparison: buildComparison(value, baseline),
      };
    });
  }

  private timeSeries(query: ResolvedQuery, scenario: MockScenario): TimeSeries[] {
    const granularity = query.granularity ?? 'day';
    const periods = enumeratePeriods(query.timeRange, granularity);

    return query.sourceMetrics.map((metric) => {
      const points = periods.map<TimeSeriesPoint>((date) => ({
        date,
        value: this.periodValue(query, metric.sourceMetric, date, granularity, scenario),
      }));

      if (!query.comparisonRange) {
        return { semanticVersionId: metric.semanticVersionId, granularity, points };
      }

      // The comparison series is aligned by position, not by date: the two
      // ranges have the same length, so point n compares with point n.
      const comparisonPeriods = enumeratePeriods(
        { preset: 'custom', from: query.comparisonRange.from, to: query.comparisonRange.to },
        granularity,
      );

      const comparisonPoints = periods.map<TimeSeriesPoint>((_, index) => {
        const date = comparisonPeriods[index];
        return date
          ? {
              date,
              value: this.periodValue(query, metric.sourceMetric, date, granularity, scenario),
            }
          : {
              date: '',
              value: valueEnvelope.missing({
                kind: 'other',
                messageKey: 'analytics.no_comparison_period',
              }),
            };
      });

      return { semanticVersionId: metric.semanticVersionId, granularity, points, comparisonPoints };
    });
  }

  private breakdownRows(query: ResolvedQuery, scenario: MockScenario): BreakdownRow[] {
    const limit = query.limit ?? 10;
    const byTitle = query.dimensions.includes(NORMALIZED_DIMENSIONS.pageTitle);

    const rows = DEMO_PAGES.slice(0, limit).map<BreakdownRow>((page) => ({
      key: page.path,
      label: byTitle ? page.title : page.path,
      metrics: query.sourceMetrics.map((metric) => {
        const total = this.totalFor(
          query,
          metric.sourceMetric,
          query.timeRange.from,
          query.timeRange.to,
          scenario,
        );
        const share = hasNumericValue(total) ? Math.round(total.value * page.weight) : 0;
        const value =
          scenario === 'zero' ? valueEnvelope.measured(0) : valueEnvelope.measured(share);

        if (!query.comparisonRange) {
          return { semanticVersionId: metric.semanticVersionId, value };
        }

        const baselineTotal = this.totalFor(
          query,
          metric.sourceMetric,
          query.comparisonRange.from,
          query.comparisonRange.to,
          scenario,
        );
        const baselineShare = hasNumericValue(baselineTotal)
          ? Math.round(baselineTotal.value * page.weight)
          : 0;

        return {
          semanticVersionId: metric.semanticVersionId,
          value,
          comparison: buildComparison(value, valueEnvelope.measured(baselineShare)),
        };
      }),
    }));

    return rows;
  }

  private totalFor(
    query: ResolvedQuery,
    sourceMetric: string,
    from: CalendarDate,
    to: CalendarDate,
    scenario: MockScenario,
  ) {
    const reserved = stateMetricValue(sourceMetric, () => {
      let total = 0;
      for (let date = from; compareDates(date, to) <= 0; date = addDays(date, 1)) {
        total += this.dailyValue(query.siteId, sourceMetric, date);
      }
      return total;
    });
    if (reserved) return reserved;

    if (scenario === 'empty') return valueEnvelope.empty();
    if (scenario === 'zero') return valueEnvelope.measured(0);

    let total = 0;
    for (let date = from; compareDates(date, to) <= 0; date = addDays(date, 1)) {
      total += this.dailyValue(query.siteId, sourceMetric, date);
    }
    return valueEnvelope.measured(total);
  }

  private periodValue(
    query: ResolvedQuery,
    sourceMetric: string,
    periodStart: CalendarDate,
    granularity: 'day' | 'week' | 'month',
    scenario: MockScenario,
  ) {
    const days = granularity === 'day' ? 1 : granularity === 'week' ? 7 : 30;

    const reserved = stateMetricValue(sourceMetric, () => {
      let total = 0;
      for (let offset = 0; offset < days; offset += 1) {
        total += this.dailyValue(query.siteId, sourceMetric, addDays(periodStart, offset));
      }
      return total;
    });
    if (reserved) return reserved;

    if (scenario === 'empty') return valueEnvelope.empty();
    if (scenario === 'zero') return valueEnvelope.measured(0);

    let total = 0;
    for (let offset = 0; offset < days; offset += 1) {
      total += this.dailyValue(query.siteId, sourceMetric, addDays(periodStart, offset));
    }
    return valueEnvelope.measured(total);
  }

  /**
   * One day's value for one metric on one site.
   *
   * Deterministic: a hash supplies the noise, a weekday factor supplies the
   * shape. An employee portal is quiet at the weekend, which makes a
   * week-over-week comparison behave the way a reviewer expects.
   */
  private dailyValue(siteId: string, sourceMetric: string, date: CalendarDate): number {
    const base = BASE_DAILY_VALUES[sourceMetric] ?? 100;
    const noise = hashUnitInterval(`${siteId}|${sourceMetric}|${date}`);
    const weekday = isoWeekday(date);
    const weekdayFactor = weekday >= 6 ? 0.22 : 1;
    // ±20 % around the base, then the weekday shape.
    return Math.round(base * (0.8 + noise * 0.4) * weekdayFactor);
  }

  private probesFor(scenario: MockScenario): CapabilityProbeResult[] {
    const available = (capability: MatomoCapability): CapabilityProbeResult => ({
      capability,
      state: 'available',
    });

    if (scenario === 'unavailable') {
      return TECHNICAL_CAPABILITIES.map((capability) => ({
        capability,
        state: capability === 'url_reachable' ? 'unavailable' : 'unknown',
        detailKey: 'matomo.capability.unreachable',
      }));
    }

    const probes: CapabilityProbeResult[] = [
      ...TECHNICAL_CAPABILITIES.map(available),
      ...CORE_CAPABILITIES.map((capability) =>
        scenario === 'limited' && capability === 'page_ranking'
          ? {
              capability,
              state: 'unavailable' as const,
              detailKey: 'matomo.capability.page_ranking_unavailable',
            }
          : available(capability),
      ),
    ];

    for (const capability of OPTIONAL_CAPABILITIES) {
      probes.push(
        scenario === 'degraded'
          ? { capability, state: 'unavailable', detailKey: 'matomo.capability.optional_missing' }
          : available(capability),
      );
    }

    return probes;
  }

  private assertReachable(connection: ResolvedConnection): void {
    if (scenarioFromUrl(connection.baseUrl) === 'unavailable') {
      throw new AppError('source_unavailable', {
        code: 'matomo_unreachable',
        messageKey: 'matomo.unreachable',
        internalMessage: 'Mock scenario "unavailable" refuses every call.',
      });
    }
  }
}

const BASE_DAILY_VALUES: Readonly<Record<string, number>> = {
  [NORMALIZED_METRICS.visits]: 1120,
  [NORMALIZED_METRICS.uniqueVisitors]: 840,
  [NORMALIZED_METRICS.pageviews]: 3480,
  [NORMALIZED_METRICS.uniquePageviews]: 2610,
  [NORMALIZED_METRICS.bounceRate]: 38,
  [NORMALIZED_METRICS.avgTimeOnSite]: 214,
};

export function isMockConnection(baseUrl: string): boolean {
  return baseUrl.startsWith(MOCK_CONNECTION_PREFIX);
}

/**
 * The value a reserved state metric produces, or nothing for a normal one.
 *
 * `measure` is only called for the states that carry a number, so a state that
 * carries none costs nothing to produce.
 */
function stateMetricValue(sourceMetric: string, measure: () => number): ValueEnvelope | null {
  switch (sourceMetric) {
    case MOCK_STATE_METRICS.zero:
      // A measured zero. A value, and never a stand-in for an absence (D10).
      return valueEnvelope.measured(0);
    case MOCK_STATE_METRICS.empty:
      return valueEnvelope.empty();
    case MOCK_STATE_METRICS.unknown:
      return valueEnvelope.unknown('matomo.value_unreadable');
    case MOCK_STATE_METRICS.notTracked:
      return valueEnvelope.notTracked('matomo.not_tracked_here');
    case MOCK_STATE_METRICS.notApplicable:
      return valueEnvelope.notApplicable('matomo.not_applicable_here');
    case MOCK_STATE_METRICS.warning:
      // A number worth showing, with a caveat worth reading alongside it: the
      // last day of the period has not finished processing (Master Spec §18).
      return valueEnvelope.warning(measure(), [
        {
          severity: 'warning',
          messageKey: 'quality.period_partially_processed',
        },
      ]);
    default:
      return null;
  }
}

export function scenarioFromUrl(baseUrl: string): MockScenario {
  if (!isMockConnection(baseUrl)) return 'default';
  const name = baseUrl.slice(MOCK_CONNECTION_PREFIX.length).replace(/\/+$/, '');
  return MOCK_SCENARIOS.includes(name as MockScenario) ? (name as MockScenario) : 'default';
}

function limitationsFor(scenario: MockScenario): string[] {
  switch (scenario) {
    case 'degraded':
      return ['matomo.limitation.no_events', 'matomo.limitation.no_custom_dimensions'];
    case 'limited':
      return ['matomo.limitation.no_page_ranking'];
    case 'unavailable':
      return ['matomo.limitation.unreachable'];
    default:
      return [];
  }
}

/** Stable pseudo-random number in [0, 1) derived from a string. */
function hashUnitInterval(seed: string): number {
  const digest = createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Builds a comparison.
 *
 * A ratio against a zero baseline is not a large percentage - it is undefined.
 * The flag travels with the value so the UI can say "no comparable value"
 * instead of printing an infinity.
 */
export function buildComparison(current: ValueEnvelope, baseline: ValueEnvelope) {
  if (!hasNumericValue(current) || !hasNumericValue(baseline)) {
    return { value: baseline };
  }
  const change = current.value - baseline.value;
  if (baseline.value === 0) {
    return { value: baseline, change, baselineZero: true };
  }
  return { value: baseline, change, changeRatio: change / baseline.value };
}
