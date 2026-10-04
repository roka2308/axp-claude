import {
  AppError,
  type AnalyticsResult,
  type BreakdownRow,
  type CapabilityProbeResult,
  type ConnectionTestInput,
  type ConnectionTestResult,
  CORE_CAPABILITIES,
  deriveCompatibility,
  hasNumericValue,
  type MatomoCapability,
  type MatomoCapabilityFingerprint,
  type MatomoMetadataSnapshot,
  type MatomoSiteSummary,
  type MetricValue,
  OPTIONAL_CAPABILITIES,
  type TimeSeries,
  type TimeSeriesPoint,
  valueEnvelope,
  type ValueEnvelope,
} from '@axp/contracts';
import type { Logger } from '@axp/observability';
import { getCorrelationId } from '@axp/observability';
import type { Clock } from '../clock';
import { buildComparison } from './mock-adapter';
import {
  type MatomoConnector,
  NORMALIZED_DIMENSIONS,
  NORMALIZED_METRICS,
  type ResolvedConnection,
  type ResolvedQuery,
} from './connector';
import { assertSafeOutboundUrl, type UrlGuardOptions } from './url-guard';

/**
 * Matomo Reporting API adapter.
 *
 * Talks to a real installation. Three rules shape it:
 *
 *   - the `token_auth` travels in the POST body, never in the query string,
 *     so it cannot end up in an access log or a proxy trace;
 *   - every outbound URL passes the SSRF guard, because the base URL is
 *     customer input;
 *   - Matomo's own error text never propagates. Failures become product error
 *     categories with i18n keys; the raw message is logged, sanitised.
 *
 * Matomo's field names appear only in this file. Above it the product speaks
 * normalised metric names.
 */

/** Matomo field -> normalised metric, per API module. */
const VISITS_SUMMARY_FIELDS: Readonly<Record<string, string>> = {
  nb_visits: NORMALIZED_METRICS.visits,
  nb_uniq_visitors: NORMALIZED_METRICS.uniqueVisitors,
  bounce_rate: NORMALIZED_METRICS.bounceRate,
  avg_time_on_site: NORMALIZED_METRICS.avgTimeOnSite,
};

const ACTIONS_FIELDS: Readonly<Record<string, string>> = {
  nb_pageviews: NORMALIZED_METRICS.pageviews,
  nb_uniq_pageviews: NORMALIZED_METRICS.uniquePageviews,
};

const METRICS_FROM_ACTIONS = new Set<string>(Object.values(ACTIONS_FIELDS));

export interface HttpMatomoAdapterOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly requestTimeoutMs: number;
  readonly urlGuard: UrlGuardOptions;
  /**
   * Matomo versions the support matrix covers. A version outside it still
   * works but reports `technically_compatible_not_certified` - capability
   * detection and the tested matrix are separate concerns (G3).
   */
  readonly certifiedMajorVersions?: readonly number[];
}

const DEFAULT_CERTIFIED_MAJORS = [4, 5] as const;

export class HttpMatomoAdapter implements MatomoConnector {
  constructor(private readonly options: HttpMatomoAdapterOptions) {}

  async testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
    const probes: CapabilityProbeResult[] = [];
    let matomoVersion: string | null;
    let siteCount: number | null = null;

    try {
      await assertSafeOutboundUrl(input.baseUrl, this.options.urlGuard);
      probes.push({ capability: 'url_reachable', state: 'available' });
      probes.push({
        capability: 'tls_valid',
        state: input.baseUrl.startsWith('https://') ? 'available' : 'unavailable',
        ...(input.baseUrl.startsWith('https://') ? {} : { detailKey: 'matomo.capability.no_tls' }),
      });
    } catch (error) {
      return {
        reachable: false,
        authenticated: false,
        matomoVersion: null,
        compatibility: 'unsupported',
        probes: [{ capability: 'url_reachable', state: 'unavailable' }],
        limitationKeys: [],
        errorKey: AppError.isAppError(error) ? error.messageKey : 'matomo.test.unreachable',
      };
    }

    const connection: ResolvedConnection = {
      connectionId: 'test',
      baseUrl: input.baseUrl,
      token: input.token,
    };

    try {
      const version = await this.call<string | { value?: string }>(connection, {
        method: 'API.getMatomoVersion',
      });
      matomoVersion = typeof version === 'string' ? version : (version?.value ?? null);
      probes.push({ capability: 'api_parseable', state: 'available' });
      probes.push({ capability: 'auth_valid', state: 'available' });
      probes.push({
        capability: 'version_parseable',
        state: matomoVersion ? 'available' : 'unknown',
      });
    } catch (error) {
      const authFailure = AppError.isAppError(error) && error.code === 'matomo_auth_failed';
      return {
        reachable: true,
        authenticated: false,
        matomoVersion: null,
        compatibility: 'unsupported',
        probes: [
          ...probes,
          { capability: 'auth_valid', state: authFailure ? 'unavailable' : 'unknown' },
          { capability: 'api_parseable', state: authFailure ? 'available' : 'unavailable' },
        ],
        limitationKeys: [],
        errorKey: authFailure ? 'matomo.test.auth_failed' : 'matomo.test.api_failed',
      };
    }

    try {
      const sites = await this.call<unknown[]>(connection, {
        method: 'SitesManager.getSitesWithAtLeastViewAccess',
      });
      siteCount = Array.isArray(sites) ? sites.length : 0;
      probes.push({ capability: 'sites_listing', state: 'available' });
    } catch {
      probes.push({
        capability: 'sites_listing',
        state: 'unavailable',
        detailKey: 'matomo.capability.no_sites_access',
      });
    }

    // Remaining core and optional capabilities are probed against the report
    // metadata, which lists what this installation actually exposes.
    const reportModules = await this.reportModules(connection, siteCount ? 1 : undefined);
    for (const capability of CORE_CAPABILITIES) {
      if (capability === 'sites_listing') continue;
      probes.push(this.probeFromModules(capability, reportModules));
    }
    for (const capability of OPTIONAL_CAPABILITIES) {
      probes.push(this.probeFromModules(capability, reportModules));
    }

    const certified = this.isCertified(matomoVersion);

    return {
      reachable: true,
      authenticated: true,
      matomoVersion,
      compatibility: deriveCompatibility(probes, { versionCertified: certified }),
      probes,
      limitationKeys: probes
        .filter((probe) => probe.state !== 'available' && probe.detailKey)
        .map((probe) => probe.detailKey!),
    };
  }

  async getCapabilityFingerprint(
    connection: ResolvedConnection,
  ): Promise<MatomoCapabilityFingerprint> {
    const result = await this.testConnection({
      baseUrl: connection.baseUrl,
      token: connection.token,
    });

    return {
      connectionId: connection.connectionId,
      detectedAt: this.options.clock.now().toISOString(),
      matomoVersion: result.matomoVersion,
      compatibility: result.compatibility,
      probes: result.probes,
      limitationKeys: result.limitationKeys,
      siteCount: null,
    };
  }

  async listSites(connection: ResolvedConnection): Promise<MatomoSiteSummary[]> {
    const sites = await this.call<MatomoRawSite[]>(connection, {
      method: 'SitesManager.getSitesWithAtLeastViewAccess',
    });

    if (!Array.isArray(sites)) return [];

    return sites.map((site) => ({
      matomoSiteId: Number(site.idsite),
      name: String(site.name ?? `Site ${site.idsite}`),
      mainUrl: site.main_url ? String(site.main_url) : null,
      // Matomo always reports a site time zone; falling back to UTC would
      // silently shift every period boundary, so it is better to be explicit.
      timezone: String(site.timezone ?? 'UTC'),
      currency: site.currency ? String(site.currency) : null,
      ecommerceEnabled: String(site.ecommerce ?? '0') === '1',
    }));
  }

  async refreshMetadata(
    connection: ResolvedConnection,
    matomoSiteId: number,
  ): Promise<MatomoMetadataSnapshot> {
    const sites = await this.listSites(connection);
    const site = sites.find((candidate) => candidate.matomoSiteId === matomoSiteId);
    if (!site) {
      throw new AppError('not_found', {
        code: 'matomo_site_not_found',
        messageKey: 'matomo.site_not_found',
        internalMessage: `Site ${matomoSiteId} is not visible to this token.`,
      });
    }

    const modules = await this.reportModules(connection, matomoSiteId);

    return {
      siteId: String(matomoSiteId),
      refreshedAt: this.options.clock.now().toISOString(),
      site,
      availableMetrics: Object.values(NORMALIZED_METRICS),
      availableDimensions: modules.has('Actions') ? Object.values(NORMALIZED_DIMENSIONS) : [],
    };
  }

  async execute(connection: ResolvedConnection, query: ResolvedQuery): Promise<AnalyticsResult> {
    const freshness = {
      fetchedAt: this.options.clock.now().toISOString(),
      fromCache: false,
      siteTimezone: query.siteTimezone,
    };

    switch (query.kind) {
      case 'scalar':
        return { kind: 'scalar', metrics: await this.scalar(connection, query), freshness };
      case 'series':
        return { kind: 'series', series: await this.series(connection, query), freshness };
      case 'breakdown': {
        const rows = await this.breakdown(connection, query);
        return { kind: 'breakdown', rows, totalRows: rows.length, hasMore: false, freshness };
      }
    }
  }

  // --- query implementations ----------------------------------------------

  private async scalar(
    connection: ResolvedConnection,
    query: ResolvedQuery,
  ): Promise<MetricValue[]> {
    const current = await this.totals(connection, query, query.timeRange.from, query.timeRange.to);
    const baseline = query.comparisonRange
      ? await this.totals(connection, query, query.comparisonRange.from, query.comparisonRange.to)
      : null;

    return query.sourceMetrics.map((metric) => {
      const value = current[metric.sourceMetric] ?? missingMetric(metric.sourceMetric);
      if (!baseline) return { semanticVersionId: metric.semanticVersionId, value };
      return {
        semanticVersionId: metric.semanticVersionId,
        value,
        comparison: buildComparison(
          value,
          baseline[metric.sourceMetric] ?? missingMetric(metric.sourceMetric),
        ),
      };
    });
  }

  private async totals(
    connection: ResolvedConnection,
    query: ResolvedQuery,
    from: string,
    to: string,
  ): Promise<Record<string, ValueEnvelope>> {
    const needsActions = query.sourceMetrics.some((metric) =>
      METRICS_FROM_ACTIONS.has(metric.sourceMetric),
    );

    const [visitsSummary, actions] = await Promise.all([
      this.call<Record<string, unknown>>(connection, {
        method: 'VisitsSummary.get',
        idSite: query.matomoSiteId,
        period: 'range',
        date: `${from},${to}`,
      }),
      needsActions
        ? this.call<Record<string, unknown>>(connection, {
            method: 'Actions.get',
            idSite: query.matomoSiteId,
            period: 'range',
            date: `${from},${to}`,
          })
        : Promise.resolve({}),
    ]);

    return {
      ...mapFields(visitsSummary, VISITS_SUMMARY_FIELDS),
      ...mapFields(actions, ACTIONS_FIELDS),
    };
  }

  private async series(
    connection: ResolvedConnection,
    query: ResolvedQuery,
  ): Promise<TimeSeries[]> {
    const granularity = query.granularity ?? 'day';
    const current = await this.seriesValues(
      connection,
      query,
      granularity,
      query.timeRange.from,
      query.timeRange.to,
    );
    const baseline = query.comparisonRange
      ? await this.seriesValues(
          connection,
          query,
          granularity,
          query.comparisonRange.from,
          query.comparisonRange.to,
        )
      : null;

    return query.sourceMetrics.map((metric) => {
      const points = current.map<TimeSeriesPoint>((entry) => ({
        date: entry.date,
        value: entry.metrics[metric.sourceMetric] ?? missingMetric(metric.sourceMetric),
      }));

      if (!baseline) return { semanticVersionId: metric.semanticVersionId, granularity, points };

      // Aligned by position: both ranges have the same length by construction.
      const comparisonPoints = points.map<TimeSeriesPoint>((_, index) => {
        const entry = baseline[index];
        return entry
          ? {
              date: entry.date,
              value: entry.metrics[metric.sourceMetric] ?? missingMetric(metric.sourceMetric),
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

  private async seriesValues(
    connection: ResolvedConnection,
    query: ResolvedQuery,
    granularity: string,
    from: string,
    to: string,
  ): Promise<{ date: string; metrics: Record<string, ValueEnvelope> }[]> {
    const needsActions = query.sourceMetrics.some((metric) =>
      METRICS_FROM_ACTIONS.has(metric.sourceMetric),
    );

    const [visitsSummary, actions] = await Promise.all([
      this.call<Record<string, Record<string, unknown>>>(connection, {
        method: 'VisitsSummary.get',
        idSite: query.matomoSiteId,
        period: granularity,
        date: `${from},${to}`,
      }),
      needsActions
        ? this.call<Record<string, Record<string, unknown>>>(connection, {
            method: 'Actions.get',
            idSite: query.matomoSiteId,
            period: granularity,
            date: `${from},${to}`,
          })
        : Promise.resolve<Record<string, Record<string, unknown>>>({}),
    ]);

    // Matomo keys a multi-period response by period label; for day periods the
    // label is the date itself, which is what the presentation model expects.
    return Object.keys(visitsSummary ?? {}).map((label) => ({
      date: label,
      metrics: {
        ...mapFields(visitsSummary[label] ?? {}, VISITS_SUMMARY_FIELDS),
        ...mapFields(actions?.[label] ?? {}, ACTIONS_FIELDS),
      },
    }));
  }

  private async breakdown(
    connection: ResolvedConnection,
    query: ResolvedQuery,
  ): Promise<BreakdownRow[]> {
    const byTitle = query.dimensions.includes(NORMALIZED_DIMENSIONS.pageTitle);
    const rows = await this.call<MatomoRawRow[]>(connection, {
      method: byTitle ? 'Actions.getPageTitles' : 'Actions.getPageUrls',
      idSite: query.matomoSiteId,
      period: 'range',
      date: `${query.timeRange.from},${query.timeRange.to}`,
      filter_limit: query.limit ?? 10,
      flat: 1,
    });

    if (!Array.isArray(rows)) return [];

    return rows.map((row) => ({
      key: String(row.url ?? row.label ?? ''),
      label: String(row.label ?? row.url ?? ''),
      metrics: query.sourceMetrics.map((metric) => ({
        semanticVersionId: metric.semanticVersionId,
        value: readRowMetric(row, metric.sourceMetric),
      })),
    }));
  }

  // --- transport -----------------------------------------------------------

  /**
   * One Reporting API call.
   *
   * The token goes into the POST body. Correlation ids are propagated as a
   * request header so a Matomo-side access log can be lined up with ours
   * (Master Spec §27).
   */
  private async call<T>(
    connection: ResolvedConnection,
    params: Record<string, string | number>,
  ): Promise<T> {
    const url = await assertSafeOutboundUrl(
      `${connection.baseUrl.replace(/\/+$/, '')}/index.php`,
      this.options.urlGuard,
    );

    const body = new URLSearchParams({
      module: 'API',
      format: 'json',
      ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
      token_auth: connection.token,
    });

    const correlationId = getCorrelationId();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      this.options.logger.warn(
        { err: error, matomoMethod: params.method },
        'Matomo request failed',
      );
      throw new AppError('source_unavailable', {
        code: 'matomo_unreachable',
        messageKey: 'matomo.unreachable',
        internalMessage: `Matomo call ${String(params.method)} failed.`,
        cause: error,
      });
    }

    // The deadline covers the body too: a server that sends its headers and
    // then stalls is cut off like one that never answers.
    try {
      return await this.readPayload<T>(response, controller.signal, params);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readPayload<T>(
    response: Response,
    signal: AbortSignal,
    params: Record<string, string | number>,
  ): Promise<T> {
    if (response.status === 401 || response.status === 403) {
      throw new AppError('source_unavailable', {
        code: 'matomo_auth_failed',
        messageKey: 'matomo.auth_failed',
        internalMessage: `Matomo rejected the token (HTTP ${response.status}).`,
      });
    }
    if (!response.ok) {
      throw new AppError('source_unavailable', {
        code: 'matomo_http_error',
        messageKey: 'matomo.unreachable',
        internalMessage: `Matomo returned HTTP ${response.status}.`,
      });
    }

    const payload: unknown = await response.json().catch((error: unknown) => {
      if (signal.aborted) {
        throw new AppError('source_unavailable', {
          code: 'matomo_unreachable',
          messageKey: 'matomo.unreachable',
          internalMessage: `Matomo call ${String(params.method)} timed out while reading the answer.`,
          cause: error,
        });
      }
      return null;
    });

    // Matomo answers errors with HTTP 200 and a result envelope.
    if (payload && typeof payload === 'object' && 'result' in payload) {
      const envelope = payload as { result?: string; message?: string };
      if (envelope.result === 'error') {
        const message = envelope.message ?? '';
        const authFailed = /token_auth|authenticat|permission/i.test(message);
        this.options.logger.warn({ matomoMethod: params.method }, 'Matomo reported an API error');
        throw new AppError('source_unavailable', {
          code: authFailed ? 'matomo_auth_failed' : 'matomo_api_error',
          messageKey: authFailed ? 'matomo.auth_failed' : 'matomo.api_error',
          // The vendor message is internal only: it can contain paths and
          // configuration detail that must not reach a browser.
          internalMessage: `Matomo API error for ${String(params.method)}: ${message}`,
        });
      }
    }

    return payload as T;
  }

  private async reportModules(
    connection: ResolvedConnection,
    matomoSiteId?: number,
  ): Promise<Set<string>> {
    if (!matomoSiteId) return new Set();
    try {
      const metadata = await this.call<{ module?: string }[]>(connection, {
        method: 'API.getReportMetadata',
        idSite: matomoSiteId,
        period: 'day',
        date: 'today',
      });
      return new Set(
        (Array.isArray(metadata) ? metadata : [])
          .map((entry) => entry.module)
          .filter((module): module is string => typeof module === 'string'),
      );
    } catch {
      return new Set();
    }
  }

  private probeFromModules(
    capability: MatomoCapability,
    modules: Set<string>,
  ): CapabilityProbeResult {
    const required = REQUIRED_MODULE_BY_CAPABILITY[capability];
    if (!required) return { capability, state: 'available' };
    if (modules.size === 0) return { capability, state: 'unknown' };
    return modules.has(required)
      ? { capability, state: 'available' }
      : { capability, state: 'unavailable', detailKey: `matomo.capability.${capability}_missing` };
  }

  private isCertified(version: string | null): boolean {
    if (!version) return false;
    const major = Number(version.split('.')[0]);
    const certified = this.options.certifiedMajorVersions ?? DEFAULT_CERTIFIED_MAJORS;
    return certified.includes(major);
  }
}

/** Which Matomo report module backs each capability. */
const REQUIRED_MODULE_BY_CAPABILITY: Readonly<Partial<Record<MatomoCapability, string>>> = {
  visits: 'VisitsSummary',
  pageviews: 'Actions',
  time_series: 'VisitsSummary',
  page_ranking: 'Actions',
  events: 'Events',
  custom_dimensions: 'CustomDimensions',
  goals: 'Goals',
  ecommerce: 'Ecommerce',
  site_search: 'Actions',
};

interface MatomoRawSite {
  readonly idsite: string | number;
  readonly name?: string;
  readonly main_url?: string;
  readonly timezone?: string;
  readonly currency?: string;
  readonly ecommerce?: string | number;
}

type MatomoRawRow = Record<string, unknown>;

/**
 * Maps Matomo fields onto normalised metrics.
 *
 * A field that is absent becomes `missing`, never 0: "Matomo did not report
 * this" and "Matomo reported none" are different facts (Shared Contract §1).
 */
function mapFields(
  source: Record<string, unknown>,
  mapping: Readonly<Record<string, string>>,
): Record<string, ValueEnvelope> {
  const result: Record<string, ValueEnvelope> = {};
  for (const [matomoField, normalized] of Object.entries(mapping)) {
    const raw = source?.[matomoField];
    result[normalized] = toEnvelope(raw);
  }
  return result;
}

function toEnvelope(raw: unknown): ValueEnvelope {
  if (raw === null || raw === undefined) {
    return valueEnvelope.missing({ kind: 'source_field_absent', requirement: 'matomo_field' });
  }
  // Matomo returns percentages as strings such as "38%".
  const numeric = typeof raw === 'string' ? Number(raw.replace('%', '').trim()) : Number(raw);
  if (!Number.isFinite(numeric)) {
    return valueEnvelope.unknown('analytics.unparsable_value');
  }
  return valueEnvelope.measured(numeric);
}

function readRowMetric(row: MatomoRawRow, normalizedMetric: string): ValueEnvelope {
  const field = Object.entries({ ...VISITS_SUMMARY_FIELDS, ...ACTIONS_FIELDS }).find(
    ([, normalized]) => normalized === normalizedMetric,
  )?.[0];

  // Ranking rows expose pageviews as nb_hits and visits as nb_visits.
  const candidates = [
    field,
    normalizedMetric === NORMALIZED_METRICS.pageviews ? 'nb_hits' : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (row[candidate] !== undefined) return toEnvelope(row[candidate]);
  }
  return valueEnvelope.missing({ kind: 'source_field_absent', requirement: normalizedMetric });
}

function missingMetric(sourceMetric: string): ValueEnvelope {
  return valueEnvelope.missing({ kind: 'source_field_absent', requirement: sourceMetric });
}

/** Re-exported so callers can narrow without importing contracts directly. */
export { hasNumericValue };
