import { desc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  AppError,
  type DiagnosticArtifactSummary,
  SOLUTION_PACKAGE_SCHEMA_VERSION,
  type SystemOverview,
} from '@axp/contracts';
import { type AppConfig, getBuildInfo } from '@axp/config';
import {
  attentionItems,
  auditEvents,
  checkDatabaseHealth,
  type Database,
  diagnosticArtifacts,
  jobs,
  matomoCapabilitySnapshots,
  matomoConnections,
  newId,
  reportRuns,
  tenants,
  users,
} from '@axp/db';
import { sanitizeForLog } from '@axp/observability';
import type { AuditService } from '../audit/audit-service';
import type { Clock } from '../clock';
import type { EntitlementService } from '../entitlements/entitlement-service';
import type { ArtifactStore } from '../export/artifact-store';

export interface DiagnosticsServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly config: AppConfig;
  readonly entitlements: EntitlementService;
  readonly store: ArtifactStore;
  readonly ttlMinutes: number;
}

/**
 * Release metadata and the diagnostic bundle (Master Spec §24).
 *
 * The bundle is built from an allowlist - versions, states, counts, codes,
 * correlation ids - never by dumping and redacting: what is not named here is
 * not in it. Before anything is stored, the serialised bundle is searched for
 * every secret this process knows, for URLs and for e-mail addresses; a hit
 * refuses the bundle rather than shipping it. The file is encrypted, readable
 * by its creator only, audited, and deleted when it expires.
 */
export class DiagnosticsService {
  constructor(private readonly deps: DiagnosticsServiceDeps) {}

  async overview(): Promise<SystemOverview> {
    const [release, compatibility, health, jobCounts, bundles] = await Promise.all([
      this.release(),
      this.compatibility(),
      this.health(),
      this.jobCounts(),
      this.bundles(),
    ]);
    return {
      release,
      compatibility,
      health,
      jobs: jobCounts,
      providers: this.providers(),
      featureFlags: this.deps.entitlements
        .featureFlags()
        .map((flag) => ({ flag: flag.flag, enabled: flag.enabled })),
      bundles,
    };
  }

  /** Generates a sanitised bundle and returns where to fetch it. */
  async generateBundle(actorUserId: string): Promise<DiagnosticArtifactSummary> {
    const now = this.deps.clock.now();
    const overview = await this.overview();
    const bundle = {
      kind: 'axp-diagnostic-bundle',
      formatVersion: 1,
      generatedAt: now.toISOString(),
      release: overview.release,
      configuration: this.configurationSummary(),
      health: overview.health,
      providers: overview.providers,
      featureFlags: overview.featureFlags,
      compatibility: overview.compatibility,
      tenants: await this.tenantSummary(),
      jobs: { byStatus: overview.jobs, recentProblems: await this.recentJobProblems() },
      reports: await this.reportSummary(),
      attention: await this.attentionSummary(),
      errorCodes: await this.errorCodes(),
    };

    const text = JSON.stringify(sanitizeForLog(bundle), null, 2);
    this.assertClean(text);

    const id = newId();
    const content = Buffer.from(text, 'utf8');
    const storageKey = await this.deps.store.write(id, content);
    const expiresAt = new Date(now.getTime() + this.deps.ttlMinutes * 60_000);
    const fileName = `axp-diagnostics_${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    await this.deps.db.insert(diagnosticArtifacts).values({
      id,
      createdByUserId: actorUserId,
      fileName,
      byteSize: content.length,
      storageKey,
      expiresAt,
      createdAt: now,
    });
    await this.deps.audit.record({
      action: 'diagnostics.bundle_generated',
      outcome: 'success',
      actorUserId,
      targetType: 'diagnostic_bundle',
      targetId: id,
      metadata: { byteSize: content.length, expiresAt: expiresAt.toISOString() },
    });
    return {
      id,
      fileName,
      byteSize: content.length,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      createdBy: null,
    };
  }

  /** The bundle file, for its creator, until it expires. */
  async open(id: string, userId: string): Promise<{ content: Buffer; fileName: string }> {
    const [row] = await this.deps.db
      .select()
      .from(diagnosticArtifacts)
      .where(eq(diagnosticArtifacts.id, id))
      .limit(1);
    if (!row || row.createdByUserId !== userId || row.expiresAt <= this.deps.clock.now()) {
      throw new AppError('not_found', {
        code: 'diagnostic_bundle_not_found',
        messageKey: 'diagnostics.not_found',
        internalMessage: `Diagnostic bundle ${id} is unknown, expired or not the caller's.`,
      });
    }
    const content = await this.deps.store.read(row.id, row.storageKey);
    if (!content) {
      throw new AppError('not_found', {
        code: 'diagnostic_bundle_gone',
        messageKey: 'diagnostics.not_found',
        internalMessage: `Diagnostic bundle ${id} has no file.`,
      });
    }
    return { content, fileName: row.fileName };
  }

  async purgeExpired(): Promise<number> {
    const expired = await this.deps.db
      .select({ id: diagnosticArtifacts.id, storageKey: diagnosticArtifacts.storageKey })
      .from(diagnosticArtifacts)
      .where(lte(diagnosticArtifacts.expiresAt, this.deps.clock.now()));
    for (const row of expired) await this.deps.store.remove(row.storageKey);
    if (expired.length > 0) {
      await this.deps.db.delete(diagnosticArtifacts).where(
        inArray(
          diagnosticArtifacts.id,
          expired.map((row) => row.id),
        ),
      );
    }
    return expired.length;
  }

  // --- what the bundle and the overview are made of -------------------------------

  private async release(): Promise<SystemOverview['release']> {
    const build = getBuildInfo('api');
    const [migrations] = (await this.deps.db.execute(
      sql`SELECT COUNT(*) AS applied, MAX(created_at) AS latest FROM __drizzle_migrations`,
    )) as unknown as [{ applied: number; latest: number | string | null }[]];
    const row = migrations[0];
    return {
      productVersion: build.version,
      schemaVersion: build.schemaVersion,
      commit: build.commit,
      builtAt: build.builtAt,
      supportStatus: 'current',
      deploymentProfile: this.deps.config.deploymentProfile,
      appEnv: this.deps.config.appEnv,
      nodeVersion: process.version,
      appliedMigrations: Number(row?.applied ?? 0),
      lastMigrationAt: row?.latest ? new Date(Number(row.latest)).toISOString() : null,
    };
  }

  private async compatibility(): Promise<SystemOverview['compatibility']> {
    const connections = await this.deps.db
      .select({ id: matomoConnections.id, tenant: tenants.name })
      .from(matomoConnections)
      .innerJoin(tenants, eq(tenants.id, matomoConnections.tenantId));
    const result: SystemOverview['compatibility']['matomoConnections'][number][] = [];
    for (const connection of connections) {
      const [snapshot] = await this.deps.db
        .select()
        .from(matomoCapabilitySnapshots)
        .where(eq(matomoCapabilitySnapshots.connectionId, connection.id))
        .orderBy(desc(matomoCapabilitySnapshots.detectedAt))
        .limit(1);
      result.push({
        tenant: connection.tenant,
        compatibility: snapshot?.compatibility ?? 'unknown',
        version: snapshot?.matomoVersion ?? null,
        checkedAt: snapshot?.detectedAt.toISOString() ?? null,
        limitations: snapshot?.limitationKeys ?? [],
      });
    }
    return {
      solutionPackageSchemas: [SOLUTION_PACKAGE_SCHEMA_VERSION],
      matomoSupportModel: 'capability_based',
      matomoConnections: result,
    };
  }

  private async health(): Promise<SystemOverview['health']> {
    const database = await checkDatabaseHealth(this.deps.db);
    return [
      {
        name: 'mysql',
        status: database.reachable ? 'up' : 'down',
        ...(database.latencyMs !== undefined ? { latencyMs: database.latencyMs } : {}),
      },
    ];
  }

  private async jobCounts(): Promise<Record<string, number>> {
    const rows = await this.deps.db
      .select({ status: jobs.status, count: sql<number>`COUNT(*)` })
      .from(jobs)
      .groupBy(jobs.status);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  private providers(): Record<string, string> {
    return {
      analyticsCache: 'memory',
      jobQueue: 'mysql',
      mailTransport: this.deps.config.mail.transport,
      matomoAdapterDefault: this.deps.config.matomo.adapter,
      exportStorage: 'encrypted-filesystem',
    };
  }

  /** Whether things are set and sane - never their values. */
  private configurationSummary() {
    const config = this.deps.config;
    return {
      valid: true,
      logFormat: config.log.format,
      logLevel: config.log.level,
      demoFixtures: config.features.demoFixtures,
      sessionIdleMinutes: config.session.idleTimeoutMinutes,
      analyticsCacheTtlSeconds: config.analytics.cacheTtlSeconds,
      analyticsQueryTimeoutMs: config.analytics.queryTimeoutMs,
      // How many, not which: host names describe the internal network.
      matomoAllowedPrivateHosts: config.matomo.allowedPrivateHosts.length,
      exportTtlMinutes: config.exports.artifactTtlMinutes,
      secretsConfigured: {
        sessionSecret: config.secrets.sessionSecret.length > 0,
        credentialEncryptionKey: config.secrets.credentialEncryptionKey.length > 0,
        smtpAuthentication: Boolean(config.mail.smtpUser),
      },
    };
  }

  private async tenantSummary() {
    const rows = await this.deps.db
      .select({ lifecycle: tenants.lifecycle, count: sql<number>`COUNT(*)` })
      .from(tenants)
      .groupBy(tenants.lifecycle);
    return Object.fromEntries(rows.map((row) => [row.lifecycle, Number(row.count)]));
  }

  private async recentJobProblems() {
    const rows = await this.deps.db
      .select({
        kind: jobs.kind,
        status: jobs.status,
        attempts: jobs.attempts,
        code: jobs.lastErrorCode,
        correlationId: jobs.correlationId,
        id: jobs.id,
        updatedAt: jobs.updatedAt,
      })
      .from(jobs)
      .where(inArray(jobs.status, ['failed', 'dead', 'queued']))
      .orderBy(desc(jobs.updatedAt))
      .limit(50);
    return rows
      .filter((row) => row.code || row.status !== 'queued')
      .map((row) => ({
        jobId: row.id,
        kind: row.kind,
        status: row.status,
        attempts: row.attempts,
        errorCode: row.code,
        correlationId: row.correlationId,
        updatedAt: row.updatedAt.toISOString(),
      }));
  }

  private async reportSummary() {
    const rows = await this.deps.db
      .select({
        status: reportRuns.status,
        errorKey: reportRuns.errorKey,
        count: sql<number>`COUNT(*)`,
      })
      .from(reportRuns)
      .groupBy(reportRuns.status, reportRuns.errorKey);
    return rows.map((row) => ({
      status: row.status,
      errorKey: row.errorKey,
      runs: Number(row.count),
    }));
  }

  private async attentionSummary() {
    const rows = await this.deps.db
      .select({
        kind: attentionItems.kind,
        status: attentionItems.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(attentionItems)
      .groupBy(attentionItems.kind, attentionItems.status);
    return rows.map((row) => ({ kind: row.kind, status: row.status, items: Number(row.count) }));
  }

  /** Failed actions by name and count - which, not what. */
  private async errorCodes() {
    const rows = await this.deps.db
      .select({ action: auditEvents.action, count: sql<number>`COUNT(*)` })
      .from(auditEvents)
      .where(eq(auditEvents.outcome, 'failure'))
      .groupBy(auditEvents.action);
    return rows.map((row) => ({ action: row.action, failures: Number(row.count) }));
  }

  private async bundles(): Promise<DiagnosticArtifactSummary[]> {
    const rows = await this.deps.db
      .select({
        artifact: diagnosticArtifacts,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(diagnosticArtifacts)
      .leftJoin(users, eq(users.id, diagnosticArtifacts.createdByUserId))
      .orderBy(desc(diagnosticArtifacts.createdAt))
      .limit(20);
    return rows.map(({ artifact, firstName, lastName }) => ({
      id: artifact.id,
      fileName: artifact.fileName,
      byteSize: artifact.byteSize,
      createdAt: artifact.createdAt.toISOString(),
      expiresAt: artifact.expiresAt.toISOString(),
      createdBy: firstName ? `${firstName} ${lastName}`.trim() : null,
    }));
  }

  /**
   * The last line of defence: no secret this process holds, no URL and no
   * e-mail address may be in the file. A hit is a defect in the allowlist
   * above - so the bundle is refused, not quietly cleaned.
   */
  private assertClean(text: string): void {
    const config = this.deps.config;
    const secrets = [
      config.secrets.sessionSecret,
      config.secrets.credentialEncryptionKey,
      config.mail.smtpPassword,
      passwordOf(config.database.url),
    ].filter((value): value is string => Boolean(value) && value!.length >= 6);
    const leaks = [
      ...secrets.filter((secret) => text.includes(secret)).map(() => 'secret'),
      ...(/(?:https?|mysql|mock):\/\//i.test(text) ? ['url'] : []),
      ...(/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text) ? ['email'] : []),
    ];
    if (leaks.length > 0) {
      throw new AppError('internal_error', {
        code: 'diagnostic_bundle_unsafe',
        messageKey: 'diagnostics.unsafe',
        internalMessage: `Diagnostic bundle refused: contains ${[...new Set(leaks)].join(', ')}.`,
      });
    }
  }
}

function passwordOf(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}
