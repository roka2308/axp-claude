import { eq } from 'drizzle-orm';
import {
  AppError,
  type AnalyticsResult,
  type AnalyticsResultCache,
  type CalendarDate,
  type ComparisonMode,
  type FilterSpec,
  type AnalyticsQueryKind,
  type SemanticVersionRef,
  type SourceBindingDescriptor,
  type TimeGranularity,
  type TimeRangePreset,
  type ValueEnvelope,
  valueEnvelope,
} from '@axp/contracts';
import { type Database, matomoSites } from '@axp/db';
import type { Logger } from '@axp/observability';
import type { Clock } from '../clock';
import type { MatomoConnectionService } from '../matomo/connection-service';
import type { MatomoConnector, ResolvedQuery, ResolvedSourceMetric } from '../matomo/connector';
import type { SemanticService } from '../semantic/semantic-service';
import { granularityFor, resolveComparison, resolveTimeRange } from './calendar';
import { cacheKeyFor } from './memory-cache';
import { applyDerivations, type Derivation, type DerivationContext } from './derive';

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
    const { query, derivation } = await this.resolve(request);
    const key = cacheKeyFor(query);

    const cached = await this.deps.cache.get(key);
    if (cached) return cached;

    // Request deduplication: a second caller joins the first one's promise
    // rather than issuing its own request.
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.run(query, derivation, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async run(
    query: ResolvedQuery,
    derivation: DerivationContext,
    key: string,
  ): Promise<AnalyticsResult> {
    await this.acquire();
    const startedAt = Date.now();

    try {
      const connection = await this.deps.connections.resolveConnection(
        query.tenantId,
        query.connectionId,
      );
      const connector = this.deps.connectorFor(connection.baseUrl);

      const raw = await this.withTimeout(connector.execute(connection, query));
      const result = applyDerivations(raw, derivation);

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
  private async resolve(
    request: AnalyticsQueryRequest,
  ): Promise<{ query: ResolvedQuery; derivation: DerivationContext }> {
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

    /*
     * Expand what was asked for into what Matomo can answer.
     *
     * A formula or a score is not a question Matomo understands, so the leaves
     * underneath it are fetched instead and the derivation happens here once
     * the answers are back.
     */
    const { leaves, derivations, names } = await this.expand(request.semanticVersionIds);

    /*
     * A custom metric is a business name for something this installation has
     * to point at itself. Resolving it means reading the project's source
     * mapping - and when there is none, saying so rather than failing the
     * whole query: one unmapped input should not take a dashboard down with
     * it (Master Spec §13).
     */
    const bindings = new Map(
      (await this.deps.semantics.listSourceBindings(request.projectId)).map((binding) => [
        binding.requirementKey,
        binding.binding,
      ]),
    );

    const sourceMetrics: ResolvedSourceMetric[] = [];
    const placeholders = new Map<string, ValueEnvelope>();

    for (const version of leaves) {
      const decimals = 'decimals' in version.body ? version.body.decimals : 0;

      if (version.body.kind === 'native') {
        sourceMetrics.push({
          semanticVersionId: version.id,
          sourceMetric: version.body.sourceMetric,
          decimals,
        });
        continue;
      }

      if (version.body.kind !== 'custom') {
        throw notExecutable(version.body.kind);
      }

      const requirement = version.body.requirementKey;
      const resolved = resolveRequirement(bindings.get(requirement), requirement);

      if (typeof resolved === 'string') {
        sourceMetrics.push({
          semanticVersionId: version.id,
          sourceMetric: resolved,
          decimals,
        });
      } else {
        placeholders.set(version.id, resolved);
      }
    }

    const query: ResolvedQuery = {
      kind: request.kind,
      tenantId: request.tenantId,
      projectId: request.projectId,
      siteId: request.siteId,
      connectionId: site.connectionId,
      matomoSiteId: site.matomoSiteId,
      siteTimezone: site.timezone,
      semanticVersionIds: request.semanticVersionIds,
      sourceMetrics,
      derivedVersionIds: derivations.map((derivation) => derivation.semanticVersionId),
      ...(placeholders.size > 0 ? { unresolvedDigest: digestOf(placeholders) } : {}),
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

    return {
      query,
      derivation: {
        derivations,
        names,
        requested: request.semanticVersionIds,
        placeholders,
      },
    };
  }

  /**
   * Resolves requested versions into the leaves to fetch and what to derive.
   *
   * Walks the dependency graph: a score depends on formulas, a formula on
   * native metrics, and only the natives reach Matomo. The walk is breadth
   * first over already-resolved dependency ids, so a diamond is fetched once.
   */
  private async expand(requestedIds: readonly string[]): Promise<{
    leaves: SemanticVersionRef[];
    derivations: Derivation[];
    names: Map<string, string>;
  }> {
    const seen = new Map<string, SemanticVersionRef>();
    const queue = [...requestedIds];

    while (queue.length > 0) {
      const batch = queue.splice(0, queue.length).filter((id) => !seen.has(id));
      if (batch.length === 0) break;

      for (const version of await this.deps.semantics.resolveVersions(batch)) {
        seen.set(version.id, version);
        queue.push(...version.dependencyVersionIds.filter((id) => !seen.has(id)));
      }
    }

    const described = await this.deps.semantics.describeVersions([...seen.keys()]);
    const names = new Map([...described].map(([id, entry]) => [id, entry.name]));

    const leaves: SemanticVersionRef[] = [];
    const derivations: Derivation[] = [];

    for (const version of seen.values()) {
      if (version.body.kind === 'formula' || version.body.kind === 'score') {
        derivations.push({
          semanticVersionId: version.id,
          body: version.body,
          decimals: version.body.decimals,
        });
      } else {
        leaves.push(version);
      }
    }

    // Derive in dependency order, so a score built on a formula sees the
    // formula's value rather than an absence.
    derivations.sort((a, b) => depth(a, seen) - depth(b, seen));

    return { leaves, derivations, names };
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

/** A stable summary of which leaves were absent, and why. */
function digestOf(placeholders: ReadonlyMap<string, ValueEnvelope>): string {
  return [...placeholders]
    .map(([id, value]) => `${id}:${value.state}:${'cause' in value ? value.cause.kind : ''}`)
    .sort()
    .join('|');
}

/**
 * What a custom metric's requirement resolves to on this site.
 *
 * Returns a source metric when the mapping points at something the connector
 * can ask for, and an absence otherwise. Deliberately three different
 * absences, because they call for three different actions: map it, accept
 * that this site does not have it, or wait for the connector to learn the
 * shape (Master Spec §13, D10).
 */
function resolveRequirement(
  binding: SourceBindingDescriptor | undefined,
  requirement: string,
): string | ValueEnvelope {
  if (!binding) {
    // Nobody has said where this comes from. That is a setup question with a
    // named subject, not a blank space.
    return valueEnvelope.missing({ kind: 'no_mapping', requirement });
  }

  switch (binding.kind) {
    case 'native_metric':
      return binding.sourceMetric;

    case 'not_available':
      // Somebody looked and decided this site does not have it. A decision,
      // not a gap.
      return valueEnvelope.missing({ kind: 'source_field_absent', requirement });

    default:
      /*
       * The mapping is recorded and legitimate; fetching it needs a Matomo
       * call shape the connector does not have yet (DEVIATIONS.md, DEV-004).
       * Reported as what it is rather than as a broken configuration.
       */
      return valueEnvelope.missing({
        kind: 'other',
        messageKey: 'analytics.binding_kind_not_executable',
      });
  }
}

/**
 * A definition kind that cannot be executed as a leaf.
 *
 * Formulas and scores are derived above the connector, so reaching this means
 * something pinned a body the engine does not know - a configuration error
 * rather than a missing value.
 */
function notExecutable(kind: string): AppError {
  return new AppError('invalid_configuration', {
    code: 'semantic_type_not_executable',
    messageKey: 'semantic.type_not_executable',
    messageParams: { kind },
    internalMessage: `A semantic version of kind "${kind}" reached the engine as a leaf.`,
  });
}

/**
 * How deep a derivation sits in the dependency graph.
 *
 * Used only for ordering, so an approximate walk is enough: what matters is
 * that a score built on a formula is evaluated after it.
 */
function depth(
  derivation: Derivation,
  versions: ReadonlyMap<string, { dependencyVersionIds: readonly string[] }>,
  guard = 0,
): number {
  if (guard > 16) return guard;

  const dependencies = versions.get(derivation.semanticVersionId)?.dependencyVersionIds ?? [];
  if (dependencies.length === 0) return 0;

  return (
    1 +
    Math.max(
      ...dependencies.map((id) =>
        depth({ ...derivation, semanticVersionId: id }, versions, guard + 1),
      ),
    )
  );
}
