import type { AppConfig } from '@axp/config';
import { createDatabase, type Database, type DatabaseHandle } from '@axp/db';
import type { Logger } from '@axp/observability';
import { type Clock, systemClock } from './clock';
import { SecretBox } from './secret-box';
import { AuditService } from './audit/audit-service';
import { AuthorizationService } from './access/authorization-service';
import { AccessService } from './access/access-service';
import { GroupService } from './access/group-service';
import { RoleAssignmentService } from './access/role-assignment-service';
import { EffectiveAccessService } from './access/effective-access-service';
import { UserAdminService } from './identity/user-admin-service';
import { TenantAdminService } from './tenancy/tenant-admin-service';
import { AuditQueryService } from './audit/audit-query';
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
import { SolutionService } from './solution/solution-service';
import { PresentationBuilder } from './dashboard/presentation-builder';
import { ArtifactStore } from './export/artifact-store';
import { ExportService } from './export/export-service';
import { ShareService } from './sharing/share-service';
import { MySqlJobQueue, type JobQueue } from './jobs/job-queue';
import { createMailTransport, type MailTransport } from './mail/mail-transport';
import { AttentionService } from './attention/attention-service';
import { AttentionScans } from './attention/attention-scans';
import { ReportService } from './reporting/report-service';
import { ReportRunner } from './reporting/report-runner';
import { EntitlementService } from './entitlements/entitlement-service';
import { ThemeService } from './theming/theme-service';
import { DiagnosticsService } from './diagnostics/diagnostics-service';

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
  readonly access: AccessService;
  readonly groups: GroupService;
  readonly roles: RoleAssignmentService;
  readonly effectiveAccess: EffectiveAccessService;
  readonly userAdmin: UserAdminService;
  readonly tenantAdmin: TenantAdminService;
  readonly auditLog: AuditQueryService;
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
  readonly solutions: SolutionService;
  readonly exports: ExportService;
  readonly shares: ShareService;
  readonly jobs: JobQueue;
  readonly mail: MailTransport;
  readonly attention: AttentionService;
  readonly attentionScans: AttentionScans;
  readonly reports: ReportService;
  readonly reportRunner: ReportRunner;
  readonly entitlements: EntitlementService;
  readonly themes: ThemeService;
  readonly diagnostics: DiagnosticsService;
  close(): Promise<void>;
}

export interface CreateContainerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Reuse an existing handle (tests share one pool across cases). */
  readonly databaseHandle?: DatabaseHandle;
  /** Replace the configured mail transport (tests read an in-memory outbox). */
  readonly mailTransport?: MailTransport;
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
  const entitlements = new EntitlementService({
    db,
    clock,
    audit,
    featureFlags: {
      'reports.pptx': { enabled: config.reports.pptxEnabled, setting: 'REPORTS_PPTX_ENABLED' },
    },
  });
  const authorization = new AuthorizationService({ db });
  const access = new AccessService({ db, audit, authorization });
  const users = new UserService({ db, clock, audit });
  const tenants = new TenantService({ db, clock, audit });

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

  const revokeAllSessions = (userId: string, reason: string) =>
    auth.revokeAllSessionsForUser(userId as never, reason);
  const groupService = new GroupService({ db, audit });
  const roles = new RoleAssignmentService({ db, audit });
  const effectiveAccess = new EffectiveAccessService({ db });
  const userAdmin = new UserAdminService({
    db,
    clock,
    audit,
    users,
    revokeAllSessions,
    invitationTtlHours: 72,
  });
  const tenantAdmin = new TenantAdminService({
    db,
    clock,
    tenants,
    userAdmin,
    roles,
    revokeAllSessions,
  });
  const auditLog = new AuditQueryService({ db });

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
  const projects = new ProjectService({ db, audit, tenants, matomo, semantics });

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

  const dashboards = new DashboardService({
    db,
    clock,
    audit,
    semantics,
    grantCreator: (params) => access.grantCreator(params),
    leasePolicy: {
      ttlSeconds: config.editor.leaseTtlSeconds,
      heartbeatSeconds: config.editor.leaseHeartbeatSeconds,
    },
  });
  const presentation = new PresentationBuilder({ clock, logger, engine: analytics, semantics });
  const solutions = new SolutionService({
    db,
    clock,
    audit,
    semantics,
    matomo,
    dashboards,
    projects,
  });

  const exportsService = new ExportService({
    db,
    clock,
    logger,
    audit,
    presentation,
    store: new ArtifactStore({ dir: config.exports.artifactDir, secretBox }),
    themes: (context) => themesService.effective(context),
    ttlMinutes: config.exports.artifactTtlMinutes,
  });
  const shares = new ShareService({
    db,
    clock,
    audit,
    authorization,
    access,
    entitlements,
    discardExports: (shareId) => exportsService.discardForShare(shareId),
  });

  const themesService = new ThemeService({ db, clock, audit, entitlements });
  const artifactStore = new ArtifactStore({ dir: config.exports.artifactDir, secretBox });
  const diagnostics = new DiagnosticsService({
    db,
    clock,
    audit,
    config,
    entitlements,
    store: artifactStore,
    ttlMinutes: config.diagnostics.bundleTtlMinutes,
  });
  const jobQueue = new MySqlJobQueue({ db, clock, leaseSeconds: config.worker.jobLeaseSeconds });
  const mail = options.mailTransport ?? createMailTransport(config, logger);
  const attention = new AttentionService({
    db,
    clock,
    audit,
    authorization,
    mail,
    webUrl: config.web.publicUrl,
  });
  const attentionScans = new AttentionScans({
    db,
    clock,
    logger,
    attention,
    matomo,
    semantics,
    shareExpiryWarningDays: config.attention.shareExpiryWarningDays,
    inactivityDays: config.attention.inactivityDays,
  });
  const reports = new ReportService({
    db,
    clock,
    audit,
    access,
    jobs: jobQueue,
    pptxEnabled: config.reports.pptxEnabled,
  });
  const reportRunner = new ReportRunner({
    db,
    clock,
    logger,
    audit,
    attention,
    presentation,
    exports: exportsService,
    reports,
    mail,
    entitlements,
    webUrl: config.web.publicUrl,
  });

  return {
    config,
    db,
    logger,
    clock,
    secretBox,
    audit,
    authorization,
    access,
    groups: groupService,
    roles,
    effectiveAccess,
    userAdmin,
    tenantAdmin,
    auditLog,
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
    solutions,
    exports: exportsService,
    shares,
    jobs: jobQueue,
    mail,
    attention,
    attentionScans,
    reports,
    reportRunner,
    entitlements,
    themes: themesService,
    diagnostics,
    close: async () => {
      await analyticsCache.clear();
      if (ownsHandle) await handle.close();
    },
  };
}
