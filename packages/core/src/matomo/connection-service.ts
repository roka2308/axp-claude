import { and, desc, eq } from 'drizzle-orm';
import {
  AppError,
  type ConnectionTestResult,
  type MatomoCapabilityFingerprint,
  type MatomoSiteSummary,
} from '@axp/contracts';
import {
  type Database,
  matomoCapabilitySnapshots,
  matomoConnections,
  matomoSites,
  newId,
  projects,
  projectSites,
} from '@axp/db';
import type { Logger } from '@axp/observability';
import type { Clock } from '../clock';
import type { SecretBox } from '../secret-box';
import type { AuditService } from '../audit/audit-service';
import type { MatomoConnector, ResolvedConnection } from './connector';

export interface MatomoConnectionServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly secretBox: SecretBox;
  readonly connectorFor: (baseUrl: string) => MatomoConnector;
}

export interface CreateConnectionInput {
  readonly tenantId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly actorUserId: string;
}

/** A connection as an API may describe it. Deliberately without the credential. */
export interface ConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly status: string;
  readonly lastTestedAt: string | null;
  readonly hasCredential: boolean;
}

/**
 * Matomo connections and site assignment (Master Spec §13).
 *
 * Connections are tenant-level and reusable; sites are assigned to projects.
 * The credential is sealed on write and opened only inside this process, for
 * the duration of one call - there is no API that returns it, and no code path
 * that puts it into a response, a log or an audit record.
 */
export class MatomoConnectionService {
  constructor(private readonly deps: MatomoConnectionServiceDeps) {}

  /** Probes a connection without storing anything. */
  async testConnection(baseUrl: string, token: string): Promise<ConnectionTestResult> {
    const connector = this.deps.connectorFor(baseUrl);
    return connector.testConnection({ baseUrl, token });
  }

  async createConnection(input: CreateConnectionInput): Promise<ConnectionSummary> {
    const sealed = this.deps.secretBox.seal(input.token);
    const now = this.deps.clock.now();
    const connectionId = newId();

    await this.deps.db.insert(matomoConnections).values({
      id: connectionId,
      tenantId: input.tenantId,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/+$/, ''),
      credentialCiphertext: sealed.ciphertext,
      credentialNonce: sealed.nonce,
      credentialKeyVersion: sealed.keyVersion,
      credentialUpdatedAt: now,
      status: 'untested',
      createdByUserId: input.actorUserId,
    });

    await this.deps.audit.success('matomo_connection.created', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetType: 'matomo_connection',
      targetId: connectionId,
      // The URL is configuration, not a secret; the token is neither recorded
      // nor referenced here.
      metadata: { name: input.name, baseUrl: input.baseUrl },
    });

    const summary = await this.getConnection(input.tenantId, connectionId);
    return summary;
  }

  /** Replaces the credential. There is no read path, only replacement. */
  async replaceCredential(
    tenantId: string,
    connectionId: string,
    token: string,
    actorUserId: string,
  ): Promise<void> {
    const sealed = this.deps.secretBox.seal(token);
    await this.deps.db
      .update(matomoConnections)
      .set({
        credentialCiphertext: sealed.ciphertext,
        credentialNonce: sealed.nonce,
        credentialKeyVersion: sealed.keyVersion,
        credentialUpdatedAt: this.deps.clock.now(),
        status: 'untested',
      })
      .where(and(eq(matomoConnections.id, connectionId), eq(matomoConnections.tenantId, tenantId)));

    await this.deps.audit.success('matomo_connection.credential_replaced', {
      actorUserId,
      tenantId,
      targetType: 'matomo_connection',
      targetId: connectionId,
    });
  }

  async listConnections(tenantId: string): Promise<ConnectionSummary[]> {
    const rows = await this.deps.db
      .select()
      .from(matomoConnections)
      .where(eq(matomoConnections.tenantId, tenantId));

    return rows.map((row) => this.toSummary(row));
  }

  async getConnection(tenantId: string, connectionId: string): Promise<ConnectionSummary> {
    const row = await this.requireConnectionRow(tenantId, connectionId);
    return this.toSummary(row);
  }

  /**
   * Detects capabilities and stores the snapshot.
   *
   * The snapshot holds capability flags, version and limitations - never a
   * measured value (Master Spec §22).
   */
  async refreshCapabilities(
    tenantId: string,
    connectionId: string,
    actorUserId?: string,
  ): Promise<MatomoCapabilityFingerprint> {
    const connection = await this.resolveConnection(tenantId, connectionId);
    const connector = this.deps.connectorFor(connection.baseUrl);
    const fingerprint = await connector.getCapabilityFingerprint(connection);

    await this.deps.db.insert(matomoCapabilitySnapshots).values({
      id: newId(),
      connectionId,
      detectedAt: this.deps.clock.now(),
      matomoVersion: fingerprint.matomoVersion,
      compatibility: fingerprint.compatibility,
      probes: fingerprint.probes as unknown as Record<string, unknown>[],
      limitationKeys: [...fingerprint.limitationKeys],
      siteCount: fingerprint.siteCount,
    });

    await this.deps.db
      .update(matomoConnections)
      .set({
        status: fingerprint.compatibility === 'unsupported' ? 'failing' : 'ok',
        lastTestedAt: this.deps.clock.now(),
      })
      .where(eq(matomoConnections.id, connectionId));

    await this.deps.audit.success('matomo_connection.capabilities_refreshed', {
      actorUserId: actorUserId ?? null,
      tenantId,
      targetType: 'matomo_connection',
      targetId: connectionId,
      metadata: { compatibility: fingerprint.compatibility },
    });

    return fingerprint;
  }

  async getLatestCapabilities(connectionId: string): Promise<MatomoCapabilityFingerprint | null> {
    const [row] = await this.deps.db
      .select()
      .from(matomoCapabilitySnapshots)
      .where(eq(matomoCapabilitySnapshots.connectionId, connectionId))
      .orderBy(desc(matomoCapabilitySnapshots.detectedAt))
      .limit(1);

    if (!row) return null;

    return {
      connectionId,
      detectedAt: row.detectedAt.toISOString(),
      matomoVersion: row.matomoVersion,
      compatibility: row.compatibility,
      probes: row.probes as unknown as MatomoCapabilityFingerprint['probes'],
      limitationKeys: row.limitationKeys,
      siteCount: row.siteCount,
    };
  }

  /** Sites the connection can see, straight from Matomo. Nothing is stored. */
  async listRemoteSites(tenantId: string, connectionId: string): Promise<MatomoSiteSummary[]> {
    const connection = await this.resolveConnection(tenantId, connectionId);
    return this.deps.connectorFor(connection.baseUrl).listSites(connection);
  }

  /** Imports site metadata into the product store. Idempotent per Matomo site. */
  async importSite(
    tenantId: string,
    connectionId: string,
    matomoSiteId: number,
    actorUserId?: string,
  ): Promise<{ siteId: string }> {
    const connection = await this.resolveConnection(tenantId, connectionId);
    const remoteSites = await this.deps.connectorFor(connection.baseUrl).listSites(connection);
    const remote = remoteSites.find((site) => site.matomoSiteId === matomoSiteId);

    if (!remote) {
      throw new AppError('not_found', {
        code: 'matomo_site_not_found',
        messageKey: 'matomo.site_not_found',
        internalMessage: `Site ${matomoSiteId} is not visible to connection ${connectionId}.`,
      });
    }

    const [existing] = await this.deps.db
      .select({ id: matomoSites.id })
      .from(matomoSites)
      .where(
        and(eq(matomoSites.connectionId, connectionId), eq(matomoSites.matomoSiteId, matomoSiteId)),
      )
      .limit(1);

    const siteId = existing?.id ?? newId();
    const values = {
      tenantId,
      connectionId,
      matomoSiteId,
      name: remote.name,
      mainUrl: remote.mainUrl,
      timezone: remote.timezone,
      currency: remote.currency,
      ecommerceEnabled: remote.ecommerceEnabled,
      metadataRefreshedAt: this.deps.clock.now(),
    };

    if (existing) {
      await this.deps.db.update(matomoSites).set(values).where(eq(matomoSites.id, siteId));
    } else {
      await this.deps.db.insert(matomoSites).values({ id: siteId, ...values });
      await this.deps.audit.success('matomo_site.imported', {
        actorUserId: actorUserId ?? null,
        tenantId,
        targetType: 'matomo_site',
        targetId: siteId,
        metadata: { matomoSiteId, name: remote.name },
      });
    }

    return { siteId };
  }

  /**
   * Assigns a site to a project.
   *
   * Both must belong to the same tenant. The check reads both rows rather than
   * trusting the ids the caller supplied - that is the cross-tenant boundary.
   */
  async assignSiteToProject(
    tenantId: string,
    projectId: string,
    siteId: string,
    actorUserId?: string,
  ): Promise<void> {
    const [project] = await this.deps.db
      .select({ id: projects.id, tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const [site] = await this.deps.db
      .select({ id: matomoSites.id, tenantId: matomoSites.tenantId })
      .from(matomoSites)
      .where(eq(matomoSites.id, siteId))
      .limit(1);

    if (!project || !site || project.tenantId !== tenantId || site.tenantId !== tenantId) {
      throw new AppError('permission_denied', {
        code: 'cross_tenant_site_assignment',
        messageKey: 'errors.permission_denied.capability',
        internalMessage:
          `Refused to assign site ${siteId} (tenant ${site?.tenantId ?? 'unknown'}) ` +
          `to project ${projectId} (tenant ${project?.tenantId ?? 'unknown'}).`,
      });
    }

    const [existing] = await this.deps.db
      .select({ id: projectSites.id })
      .from(projectSites)
      .where(and(eq(projectSites.projectId, projectId), eq(projectSites.siteId, siteId)))
      .limit(1);

    if (existing) return;

    const [primary] = await this.deps.db
      .select({ id: projectSites.id })
      .from(projectSites)
      .where(eq(projectSites.projectId, projectId))
      .limit(1);

    await this.deps.db.insert(projectSites).values({
      id: newId(),
      projectId,
      siteId,
      isPrimary: !primary,
    });

    await this.deps.audit.success('project.site_assigned', {
      actorUserId: actorUserId ?? null,
      tenantId,
      projectId,
      targetType: 'matomo_site',
      targetId: siteId,
    });
  }

  async listProjectSites(projectId: string) {
    return this.deps.db
      .select({
        id: matomoSites.id,
        name: matomoSites.name,
        timezone: matomoSites.timezone,
        mainUrl: matomoSites.mainUrl,
        matomoSiteId: matomoSites.matomoSiteId,
        connectionId: matomoSites.connectionId,
        isPrimary: projectSites.isPrimary,
      })
      .from(projectSites)
      .innerJoin(matomoSites, eq(matomoSites.id, projectSites.siteId))
      .where(eq(projectSites.projectId, projectId));
  }

  /**
   * Opens the credential for one call.
   *
   * The only place a Matomo token exists in plaintext. The returned object is
   * request-scoped and must not be stored, logged or returned.
   */
  /**
   * What a site currently exposes, for the mapping surfaces.
   *
   * Read live rather than stored: the point of a drift check is to compare a
   * recorded binding against what is true now.
   */
  async describeSiteMetadata(
    tenantId: string,
    siteId: string,
  ): Promise<{ metrics: string[]; dimensions: string[] }> {
    const [site] = await this.deps.db
      .select()
      .from(matomoSites)
      .where(and(eq(matomoSites.id, siteId), eq(matomoSites.tenantId, tenantId)))
      .limit(1);

    if (!site) {
      throw new AppError('not_found', {
        code: 'matomo_site_not_found',
        messageKey: 'matomo.site_not_found',
        internalMessage: `Site ${siteId} not found for tenant ${tenantId}.`,
      });
    }

    const connection = await this.resolveConnection(tenantId, site.connectionId);
    const connector = this.deps.connectorFor(connection.baseUrl);
    const snapshot = await connector.refreshMetadata(connection, site.matomoSiteId);

    return {
      metrics: [...snapshot.availableMetrics],
      dimensions: [...snapshot.availableDimensions],
    };
  }

  async resolveConnection(tenantId: string, connectionId: string): Promise<ResolvedConnection> {
    const row = await this.requireConnectionRow(tenantId, connectionId);

    return {
      connectionId: row.id,
      baseUrl: row.baseUrl,
      token: this.deps.secretBox.open({
        ciphertext: row.credentialCiphertext,
        nonce: row.credentialNonce,
        keyVersion: row.credentialKeyVersion,
      }),
    };
  }

  private async requireConnectionRow(tenantId: string, connectionId: string) {
    const [row] = await this.deps.db
      .select()
      .from(matomoConnections)
      .where(and(eq(matomoConnections.id, connectionId), eq(matomoConnections.tenantId, tenantId)))
      .limit(1);

    if (!row) {
      throw new AppError('not_found', {
        code: 'matomo_connection_not_found',
        messageKey: 'matomo.connection_not_found',
        internalMessage: `Connection ${connectionId} not found for tenant ${tenantId}.`,
      });
    }
    return row;
  }

  private toSummary(row: {
    id: string;
    name: string;
    baseUrl: string;
    status: string;
    lastTestedAt: Date | null;
    credentialCiphertext: string;
  }): ConnectionSummary {
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      status: row.status,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      // Whether a credential exists is useful; its value is never exposed.
      hasCredential: row.credentialCiphertext.length > 0,
    };
  }
}
