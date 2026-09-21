import type {
  AnalyticsResult,
  ConnectionTestInput,
  ConnectionTestResult,
  MatomoCapabilityFingerprint,
  MatomoMetadataSnapshot,
  MatomoSiteSummary,
  NormalizedAnalyticsQuery,
} from '@axp/contracts';

/**
 * The Matomo boundary (Shared Contract §6).
 *
 * Everything vendor-specific stops here. Above this interface the product
 * speaks in normalised metric names, semantic versions and value states; below
 * it lives whatever a particular Matomo version happens to call things.
 *
 * Two consequences the implementations must honour:
 *   - no Matomo credential ever travels upward or outward;
 *   - no raw Matomo error text reaches the UI. Failures are translated into
 *     product error categories and i18n keys.
 */
export interface MatomoConnector {
  /** Probes a connection before it is stored. Never persists anything. */
  testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult>;

  /** What the connection can do right now. Stored as a capability snapshot. */
  getCapabilityFingerprint(connection: ResolvedConnection): Promise<MatomoCapabilityFingerprint>;

  listSites(connection: ResolvedConnection): Promise<MatomoSiteSummary[]>;

  refreshMetadata(
    connection: ResolvedConnection,
    matomoSiteId: number,
  ): Promise<MatomoMetadataSnapshot>;

  /**
   * Runs one normalised query.
   *
   * The result lives in memory and may be cached briefly; it is never written
   * to the product store (Master Spec §4).
   */
  execute(connection: ResolvedConnection, query: ResolvedQuery): Promise<AnalyticsResult>;
}

/**
 * A connection with its credential decrypted, assembled per call.
 *
 * Deliberately not a stored shape: the token exists only for the duration of a
 * request, inside the API process.
 */
export interface ResolvedConnection {
  readonly connectionId: string;
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * A query with everything the connector needs already resolved: which Matomo
 * site, which normalised source metrics, which calendar dates.
 *
 * Resolving semantic versions into source metrics happens above the connector,
 * so the connector never reads the semantic catalog.
 */
export interface ResolvedQuery extends NormalizedAnalyticsQuery {
  /** Which stored connection to open the credential from. */
  readonly connectionId: string;
  readonly matomoSiteId: number;
  readonly siteTimezone: string;
  /**
   * Normalised source metrics to fetch.
   *
   * The leaves of the request: native metrics, plus whatever a formula or a
   * score needs underneath. A connector never sees a formula.
   */
  readonly sourceMetrics: readonly ResolvedSourceMetric[];
  /**
   * Version ids the caller asked for, which may include derived ones.
   *
   * Part of the cache key: two widgets over the same leaves but different
   * formulas are different questions.
   */
  readonly derivedVersionIds?: readonly string[];
  /** Resolved comparison dates, when a comparison was requested. */
  readonly comparisonRange?: { readonly from: string; readonly to: string };
}

export interface ResolvedSourceMetric {
  readonly semanticVersionId: string;
  /** Normalised name owned by the connector, e.g. `visits`, `pageviews`. */
  readonly sourceMetric: string;
  readonly decimals: number;
}

/**
 * Normalised metric names.
 *
 * The product speaks these; each adapter maps them onto its own vendor fields.
 * Adding one means teaching every adapter about it, which is the point: a
 * dashboard must not depend on a field only one Matomo version exposes.
 */
export const NORMALIZED_METRICS = {
  visits: 'visits',
  uniqueVisitors: 'unique_visitors',
  pageviews: 'pageviews',
  uniquePageviews: 'unique_pageviews',
  bounceRate: 'bounce_rate',
  avgTimeOnSite: 'avg_time_on_site',
} as const;

export type NormalizedMetric = (typeof NORMALIZED_METRICS)[keyof typeof NORMALIZED_METRICS];

/** Normalised dimension names available in the first vertical slice. */
export const NORMALIZED_DIMENSIONS = {
  pageUrl: 'page_url',
  pageTitle: 'page_title',
} as const;

export type NormalizedDimension =
  (typeof NORMALIZED_DIMENSIONS)[keyof typeof NORMALIZED_DIMENSIONS];
