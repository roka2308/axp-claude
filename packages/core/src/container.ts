import type { AppConfig } from '@axp/config';
import { createDatabase, type Database, type DatabaseHandle } from '@axp/db';
import type { Logger } from '@axp/observability';
import { type Clock, systemClock } from './clock';
import { SecretBox } from './secret-box';
import { AuditService } from './audit/audit-service';
import { AuthorizationService } from './access/authorization-service';
import { AuthService } from './identity/auth-service';
import { UserService } from './identity/user-service';
import { BootstrapService } from './platform/bootstrap-service';
import { TenantService } from './tenancy/tenant-service';
import { ProjectService } from './tenancy/project-service';
import { MatomoConnectionService } from './matomo/connection-service';
import type { MatomoConnector } from './matomo/connector';
import { isMockConnection, MockMatomoAdapter } from './matomo/mock-adapter';
import { HttpMatomoAdapter } from './matomo/http-adapter';
import { MemoryAnalyticsCache } from './analytics/memory-cache';
import { AnalyticsQueryEngine } from './analytics/query-engine';
import { SemanticService } from './semantic/semantic-service';
import { DashboardService } from './dashboard/dashboard-service';
import { PresentationBuilder } from './dashboard/presentation-builder';

/**
 * Composition root for the domain layer.
 *
 * The API process, the worker and the CLIs all build the same container, which
 * is what makes "one modular monolith, several processes" true rather than
 * aspirational: there is exactly one implementation of each domain rule.
 */
export interface Container {
  readonly config: AppConfig;
  readonly db: Database;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly secretBox: SecretBox;
  readonly audit: AuditService;
  readonly authorization: AuthorizationService;
  readonly auth: AuthService;
  readonly users: UserService;
  readonly tenants: TenantService;
  readonly projects: ProjectService;
  readonly bootstrap: BootstrapService;
  readonly matomo: MatomoConnectionService;
  readonly semantics: SemanticService;
  readonly analytics: AnalyticsQueryEngine;
  readonly analyticsCache: MemoryAnalyticsCache;
  readonly dashboards: DashboardService;
  readonly presentation: PresentationBuilder;
  close(): Promise<void>;
}

export interface CreateContainerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Reuse an existing handle (tests share one pool across cases). */
  readonly databaseHandle?: DatabaseHandle;
}

export function createContainer(options: CreateContainerOptions): Container {
  const clock = options.clock ?? systemClock;
  const handle = options.databaseHandle ?? createDatabase(options.config);
  const ownsHandle = options.databaseHandle === undefined;
  const { db } = handle;
  const logger = options.logger;
  const config = options.config;

  const secretBox = new SecretBox({ key: config.secrets.credentialEncryptionKey });
  const audit = new AuditService({ db, clock, logger });
  const authorization = new AuthorizationService({ db });
  const users = new UserService({ db, clock, audit });
  const tenants = new TenantService({ db, clock, audit });
  const projects = new ProjectService({ db });

  const auth = new AuthService({
    db,
    clock,
    logger,
    audit,
    sessionPolicy: {
      idleTimeoutMinutes: config.session.idleTimeoutMinutes,
      absoluteLifetimeHours: config.session.absoluteLifetimeHours,
      reauthWindowMinutes: config.session.reauthWindowMinutes,
    },
  });

  const bootstrap = new BootstrapService({
    db,
    clock,
    logger,
    audit,
    tokenTtlMinutes: config.bootstrap.tokenTtlMinutes,
  });

  const mockAdapter = new MockMatomoAdapter(clock);
  const httpAdapter = new HttpMatomoAdapter({
    clock,
    logger,
    requestTimeoutMs: config.analytics.queryTimeoutMs,
    urlGuard: {
      // A local Matomo is a normal development target; in every other
      // environment a private address is an SSRF attempt.
      allowPrivateNetwork: config.appEnv === 'development' || config.appEnv === 'test',
    },
  });

  /**
   * Picks the adapter from the connection URL rather than from configuration.
   *
   * `mock://…` connections always use the mock, so a demo tenant and a real
   * one can coexist in the same instance. `MATOMO_ADAPTER` decides which kind
   * the setup flow offers by default, not how a stored connection behaves.
   */
  const connectorFor = (baseUrl: string): MatomoConnector =>
    isMockConnection(baseUrl) ? mockAdapter : httpAdapter;

  const matomo = new MatomoConnectionService({
    db,
    clock,
    logger,
    audit,
    secretBox,
    connectorFor,
  });

  const semantics = new SemanticService({ db, clock, audit });

  const analyticsCache = new MemoryAnalyticsCache(clock, config.analytics.cacheMaxEntries);
  const analytics = new AnalyticsQueryEngine({
    db,
    clock,
    logger,
    cache: analyticsCache,
    connections: matomo,
    semantics,
    connectorFor,
    cacheTtlMs: config.analytics.cacheTtlSeconds * 1000,
    queryTimeoutMs: config.analytics.queryTimeoutMs,
    maxParallelQueries: config.analytics.maxParallelQueries,
  });

  const dashboards = new DashboardService({ db, clock, audit, semantics });
  const presentation = new PresentationBuilder({ clock, logger, engine: analytics, semantics });

  return {
    config,
    db,
    logger,
    clock,
    secretBox,
    audit,
    authorization,
    auth,
    users,
    tenants,
    projects,
    bootstrap,
    matomo,
    semantics,
    analytics,
    analyticsCache,
    dashboards,
    presentation,
    close: async () => {
      await analyticsCache.clear();
      if (ownsHandle) await handle.close();
    },
  };
}
