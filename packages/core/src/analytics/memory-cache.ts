import { createHash } from 'node:crypto';
import type { AnalyticsResult, AnalyticsResultCache, CacheKey } from '@axp/contracts';
import type { ResolvedQuery } from '../matomo/connector';
import type { Clock } from '../clock';

/**
 * Ephemeral in-memory analytics cache (Master Spec §4, Shared Contract §5).
 *
 * The only implementation the MVP has, deliberately: a persistent analytics
 * cache is On Hold and would need its own security and privacy decision,
 * because it would turn "Matomo is the only analytics store" into a false
 * statement. This one dies with the process.
 *
 * Bounded by entry count and by TTL, with least-recently-used eviction, so a
 * busy dashboard cannot grow it without limit.
 */
export class MemoryAnalyticsCache implements AnalyticsResultCache {
  private readonly entries = new Map<CacheKey, { value: AnalyticsResult; expiresAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly maxEntries: number,
  ) {}

  async get(key: CacheKey): Promise<AnalyticsResult | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return null;
    }

    // Re-insert to mark it most recently used: Map preserves insertion order,
    // which is what makes the eviction below least-recently-used.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return {
      ...entry.value,
      freshness: { ...entry.value.freshness, fromCache: true },
    } as AnalyticsResult;
  }

  async set(key: CacheKey, value: AnalyticsResult, ttlMs: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.clock.now().getTime() + ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  async delete(key: CacheKey): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Cache key for a resolved query.
 *
 * `permissionContextId` is part of the key on purpose: two users may issue an
 * identical-looking query while being allowed to see different things, and a
 * shared entry would leak across that boundary. Everything that can change the
 * answer is hashed in; nothing that cannot is.
 */
export function cacheKeyFor(query: ResolvedQuery): CacheKey {
  const material = JSON.stringify({
    kind: query.kind,
    tenant: query.tenantId,
    project: query.projectId,
    site: query.siteId,
    matomoSite: query.matomoSiteId,
    metrics: query.sourceMetrics.map((metric) => metric.sourceMetric).sort(),
    // Same leaves, different formula, different answer.
    derived: [...(query.derivedVersionIds ?? [])].sort(),
    dimensions: [...query.dimensions].sort(),
    range: [query.timeRange.from, query.timeRange.to],
    granularity: query.granularity ?? null,
    comparison: query.comparisonRange
      ? [query.comparisonRange.from, query.comparisonRange.to]
      : null,
    filters: query.fixedFilters,
    limit: query.limit ?? null,
    permission: query.permissionContextId,
  });

  return createHash('sha256').update(material).digest('hex');
}
