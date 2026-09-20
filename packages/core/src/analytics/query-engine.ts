import { eq } from 'drizzle-orm';
import {
  AppError,
  type AnalyticsResult,
  type AnalyticsResultCache,
  type CalendarDate,
  type ComparisonMode,
  type FilterSpec,
  type AnalyticsQueryKind,
  type SemanticDefinitionBody,
  type TimeGranularity,
  type TimeRangePreset,
} from '@axp/contracts';
import { type Database, matomoSites } from '@axp/db';
import type { Logger } from '@axp/observability';
import type { Clock } from '../clock';
import type { MatomoConnectionService } from '../matomo/connection-service';
import type { MatomoConnector, ResolvedQuery, ResolvedSourceMetric } from '../matomo/connector';
import type { SemanticService } from '../semantic/semantic-service';
import { granularityFor, resolveComparison, resolveTimeRange } from './calendar';
import { cacheKeyFor } from './memory-cache';

export interface AnalyticsQueryRequest {
  readonly kind: AnalyticsQueryKind;
  readonly tenantId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly semanticVersionIds: readonly string[];
  readonly dimensions?: readonly string[];
  readonly limit?: number;
  readonly timeRangePreset: TimeRangePreset;
  readonly from?: CalendarDate;
  readonly to?: CalendarDate;
  readonly comparisonMode: ComparisonMode;
  readonly comparisonFrom?: CalendarDate;
  readonly comparisonTo?: CalendarDate;
  readonly granularity?: TimeGranularity;
  readonly fixedFilters?: readonly FilterSpec[];
  /** Identifies the authorization decision that permitted this query. */
  readonly permissionContextId: string;
}

export interface AnalyticsQueryEngineDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly cache: AnalyticsResultCache;
  readonly connections: MatomoConnectionService;
  readonly semantics: SemanticService;
  readonly connectorFor: (baseUrl: string) => MatomoConnector;
  readonly cacheTtlMs: number;
  readonly queryTimeoutMs: number;
  readonly maxParallelQueries: number;
}

/**
 * Analytics query engine (Master Spec §26).
 *
 * Sits between widgets and the connector and owns the operational rules the
 * specification asks for:
 *
 *   - results live in memory and in a short-lived cache, never in MySQL;
 *   - identical in-flight queries are deduplicated, so ten widgets asking the
 *     same question cost one request;
 *   - parallelism is bounded, so one dashboard cannot saturate a Matomo;
 *   - every query has a timeout, so a slow widget fails on its own instead of
 *     blocking the others.
 */
export class AnalyticsQueryEngine {
  private readonly inFlight = new Map<string, Promise<AnalyticsResult>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly deps: AnalyticsQueryEngineDeps) {}

  async execute(request: AnalyticsQueryRequest): Promise<AnalyticsResult> {
    const query = await this.resolve(request);
    const key = cacheKeyFor(query);

    const cached = await this.deps.cache.get(key);
    if (cached) return cached;

    // Request deduplication: a second caller joins the first one's promise
    // rather than issuing its own request.
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.run(query, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async run(query: ResolvedQuery, key: string): Promise<AnalyticsResult> {
    await this.acquire();
    const startedAt = Date.now();

    try {
      const connection = await this.deps.connections.resolveConnection(
        query.tenantId,
        query.connectionId,
      );
      const connector = this.deps.connectorFor(connection.baseUrl);

      const result = await this.withTimeout(connector.execute(connection, query));
      await this.deps.cache.set(key, result, this.deps.cacheTtlMs);

      this.deps.logger.debug(
        {
          queryKind: query.kind,
          durationMs: Date.now() - startedAt,
          metricCount: query.sourceMetrics.length,
        },
        'Analytics query completed',
      );

      return result;
    } catch (error) {
      // Analytics values never reach the log; only shape and timing do.
      this.deps.logger.warn(
        {
          err: error,
          queryKind: query.kind,
          durationMs: Date.now() - startedAt,
        },
        'Analytics query failed',
      );
      throw error;
    } finally {
      this.release();
    }
  }

  /**
   * Turns a request into everything the connector needs.
   *
   * The two resolutions that matter for correctness happen here: the calendar
   * is resolved in the site's time zone, and semantic versions are translated
   * into normalised source metrics. Neither is left to the connector.
   */
  private async resolve(request: AnalyticsQueryRequest): Promise<ResolvedQuery> {
    const [site] = await this.deps.db
      .select()
      .from(matomoSites)
      .where(eq(matomoSites.id, request.siteId))
      .limit(1);

    if (!site) {
      throw new AppError('setup_required', {
        code: 'site_not_configured',
        messageKey: 'analytics.site_not_configured',
        internalMessage: `Site ${request.siteId} does not exist.`,
      });
    }

    // Cross-tenant guard: the site must belong to the tenant the caller was
    // authorized for. Ids in the request are never trusted on their own.
    if (site.tenantId !== request.tenantId) {
      throw new AppError('permission_denied', {
        code: 'cross_tenant_site_access',
        messageKey: 'errors.permission_denied.capability',
        internalMessage: `Site ${request.siteId} belongs to tenant ${site.tenantId}, not ${request.tenantId}.`,
      });
    }

    const timeRange = resolveTimeRange({
      preset: request.timeRangePreset,
      timezone: site.timezone,
      now: this.deps.clock.now(),
      from: request.from,
      to: request.to,
    });

    const comparison = resolveComparison(timeRange, request.comparisonMode, {
      from: request.comparisonFrom,
      to: request.comparisonTo,
    });

    const versions = await this.deps.semantics.resolveVersions(request.semanticVersionIds);
    const sourceMetrics: ResolvedSourceMetric[] = versions.map((version) => ({
      semanticVersionId: version.id,
      sourceMetric: sourceMetricFor(version.body),
      decimals: 'decimals' in version.body ? version.body.decimals : 0,
    }));

    return {
      kind: request.kind,
      tenantId: request.tenantId,
      projectId: request.projectId,
      siteId: request.siteId,
      connectionId: site.connectionId,
      matomoSiteId: site.matomoSiteId,
      siteTimezone: site.timezone,
      semanticVersionIds: request.semanticVersionIds,
      sourceMetrics,
      dimensions: request.dimensions ?? [],
      timeRange,
      granularity: request.granularity ?? granularityFor(timeRange),
      comparison,
      ...(comparison.mode !== 'none' && comparison.from && comparison.to
        ? { comparisonRange: { from: comparison.from, to: comparison.to } }
        : {}),
      fixedFilters: request.fixedFilters ?? [],
      limit: request.limit,
      permissionContextId: request.permissionContextId,
    };
  }

  private async withTimeout(work: Promise<AnalyticsResult>): Promise<AnalyticsResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new AppError('source_unavailable', {
            code: 'analytics_timeout',
            messageKey: 'analytics.timeout',
            internalMessage: `Analytics query exceeded ${this.deps.queryTimeoutMs} ms.`,
          }),
        );
      }, this.deps.queryTimeoutMs);
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Counting semaphore. Keeps concurrent Matomo requests bounded. */
  private async acquire(): Promise<void> {
    if (this.active < this.deps.maxParallelQueries) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

/**
 * The normalised source metric a semantic definition reads from.
 *
 * Formulas and scores are computed above the connector and arrive in Phase 3;
 * reaching one here means a dashboard pinned something this milestone cannot
 * evaluate, which is a configuration error rather than a missing value.
 */
function sourceMetricFor(body: SemanticDefinitionBody): string {
  if (body.kind === 'native') return body.sourceMetric;

  throw new AppError('invalid_configuration', {
    code: 'semantic_type_not_executable',
    messageKey: 'semantic.type_not_executable',
    messageParams: { kind: body.kind },
    internalMessage: `Semantic definitions of kind "${body.kind}" are evaluated from Phase 3 onwards.`,
  });
}
