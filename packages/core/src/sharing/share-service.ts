import { and, desc, eq, gt, lte } from 'drizzle-orm';
import {
  AppError,
  type AuthContext,
  type DashboardSnapshot,
  SHARE_MAX_LIFETIME_DAYS,
  type ShareCreateRequest,
  type ShareCreated,
  type ShareRights,
  type ShareSummary,
  type ShareUnlocked,
  type ShareViewMeta,
} from '@axp/contracts';
import {
  type Database,
  dashboards,
  dashboardShares,
  dashboardVersions,
  matomoSites,
  newId,
  projects,
  projectSites,
  shareSessions,
  tenants,
  users,
} from '@axp/db';
import { asUserId } from '@axp/contracts';
import type { AuditService } from '../audit/audit-service';
import type { Clock } from '../clock';
import { generateSecretToken, hashPassword, hashToken, verifyPassword } from '../crypto';
import type { AuthorizationService } from '../access/authorization-service';
import type { AccessService } from '../access/access-service';
import type { EntitlementService } from '../entitlements/entitlement-service';
import { resolveAuthContext } from '../access/auth-context';
import { addDays, startOfDayInstant, todayIn } from '../analytics/calendar';

export interface ShareServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly authorization: AuthorizationService;
  readonly access: AccessService;
  readonly entitlements: EntitlementService;
  /** Deletes a share's export files when it is revoked. */
  readonly discardExports: (shareId: string) => Promise<void>;
}

/** Password attempts before a pause, and how long the pause lasts. */
const UNLOCK_ATTEMPTS = 5;
const UNLOCK_BLOCK_MINUTES = 15;
/** A password unlock lasts a working day at most, never past the share. */
const SHARE_SESSION_HOURS = 12;

type ShareRow = typeof dashboardShares.$inferSelect;

/** Everything needed to render a share, once it has been found usable. */
export interface ResolvedShare {
  readonly share: ShareRow;
  readonly rights: ShareRights;
  readonly meta: ShareViewMeta;
  readonly snapshot: DashboardSnapshot;
  readonly publishedVersion: number;
  readonly tenantName: string;
  readonly projectName: string;
  readonly site: { readonly id: string; readonly name: string; readonly timezone: string };
}

export type ShareResolution =
  | { readonly state: 'unavailable' }
  | { readonly state: 'password_required'; readonly share: ShareRow }
  | ({ readonly state: 'available' } & ResolvedShare);

type Standing = { status: ShareSummary['status']; reason?: ShareSummary['unavailableReason'] };

/**
 * External shares (Master Spec §15, Shared Contract §11).
 *
 * A share is a whole published dashboard behind an unguessable link, with a
 * mandatory expiry and explicit rights. Whether it works is decided on every
 * request, from the current state of everything it depends on: not revoked,
 * not expired, the dashboard still published, the tenant active, and the
 * person who shared it still allowed to. A share never grants more than its
 * creator currently holds - when their access goes, the link goes with it.
 */
export class ShareService {
  constructor(private readonly deps: ShareServiceDeps) {}

  async create(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly dashboardId: string;
    readonly timezone: string;
    readonly actorUserId: string;
    readonly request: ShareCreateRequest;
  }): Promise<ShareCreated> {
    const now = this.deps.clock.now();
    const today = todayIn(input.timezone, now);

    if (input.request.expiresOn < today) {
      throw new AppError('validation_failed', {
        code: 'share_expiry_in_past',
        messageKey: 'share.expiry_in_past',
        internalMessage: `Expiry ${input.request.expiresOn} is before ${today}.`,
      });
    }
    if (input.request.expiresOn > addDays(today, SHARE_MAX_LIFETIME_DAYS)) {
      throw new AppError('validation_failed', {
        code: 'share_expiry_too_far',
        messageKey: 'share.expiry_too_far',
        messageParams: { days: SHARE_MAX_LIFETIME_DAYS },
        internalMessage: `Expiry ${input.request.expiresOn} is more than ${SHARE_MAX_LIFETIME_DAYS} days out.`,
      });
    }

    const [dashboard] = await this.deps.db
      .select({
        lifecycle: dashboards.lifecycle,
        publishedVersionId: dashboards.publishedVersionId,
      })
      .from(dashboards)
      .where(and(eq(dashboards.id, input.dashboardId), eq(dashboards.tenantId, input.tenantId)))
      .limit(1);
    if (!dashboard?.publishedVersionId || isHidden(dashboard.lifecycle)) {
      throw new AppError('setup_required', {
        code: 'share_needs_published_dashboard',
        messageKey: 'share.needs_published_dashboard',
        internalMessage: `Dashboard ${input.dashboardId} is not published and visible.`,
      });
    }

    // The link works until the chosen day ends where the project lives.
    const expiresAt = new Date(
      startOfDayInstant(addDays(input.request.expiresOn, 1), input.timezone).getTime() - 1,
    );
    const token = generateSecretToken(32);
    const id = newId();

    await this.deps.db.insert(dashboardShares).values({
      id,
      tenantId: input.tenantId,
      projectId: input.projectId,
      dashboardId: input.dashboardId,
      tokenHash: hashToken(token),
      label: input.request.label,
      expiresAt,
      allowTimeRange: input.request.rights.timeRange ? 1 : 0,
      allowComparison: input.request.rights.comparison ? 1 : 0,
      allowDetail: input.request.rights.detail ? 1 : 0,
      allowExport: input.request.rights.export ? 1 : 0,
      passwordHash: input.request.password ? await hashPassword(input.request.password) : null,
      createdByUserId: input.actorUserId,
      createdAt: now,
    });

    await this.deps.audit.record({
      action: 'share.created',
      outcome: 'success',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      targetType: 'dashboard',
      targetId: input.dashboardId,
      // The settings, never the link or the password.
      metadata: {
        shareId: id,
        expiresAt: expiresAt.toISOString(),
        rights: input.request.rights,
        passwordProtected: Boolean(input.request.password),
      },
    });

    const [summary] = await this.list(input.tenantId, input.dashboardId, id);
    return { share: summary!, token };
  }

  /** A dashboard's shares with their current standing, newest first. */
  async list(tenantId: string, dashboardId: string, onlyId?: string): Promise<ShareSummary[]> {
    const rows = await this.deps.db
      .select({ share: dashboardShares, firstName: users.firstName, lastName: users.lastName })
      .from(dashboardShares)
      .leftJoin(users, eq(users.id, dashboardShares.createdByUserId))
      .where(
        and(
          eq(dashboardShares.tenantId, tenantId),
          eq(dashboardShares.dashboardId, dashboardId),
          ...(onlyId ? [eq(dashboardShares.id, onlyId)] : []),
        ),
      )
      .orderBy(desc(dashboardShares.createdAt));

    const summaries: ShareSummary[] = [];
    for (const row of rows) {
      const standing = await this.standing(row.share);
      summaries.push({
        id: row.share.id,
        dashboardId: row.share.dashboardId,
        label: row.share.label,
        status: standing.status,
        ...(standing.reason ? { unavailableReason: standing.reason } : {}),
        expiresAt: row.share.expiresAt.toISOString(),
        rights: rightsOf(row.share),
        passwordProtected: row.share.passwordHash !== null,
        createdAt: row.share.createdAt.toISOString(),
        createdBy: row.firstName ? `${row.firstName} ${row.lastName}`.trim() : null,
        revokedAt: row.share.revokedAt?.toISOString() ?? null,
        lastAccessedAt: row.share.lastAccessedAt?.toISOString() ?? null,
        accessCount: row.share.accessCount,
      });
    }
    return summaries;
  }

  /** Revoking is immediate and final; the link stops at its next request. */
  async revoke(input: {
    readonly tenantId: string;
    readonly dashboardId: string;
    readonly shareId: string;
    readonly actorUserId: string;
  }): Promise<ShareSummary> {
    const [row] = await this.deps.db
      .select()
      .from(dashboardShares)
      .where(
        and(
          eq(dashboardShares.id, input.shareId),
          eq(dashboardShares.tenantId, input.tenantId),
          eq(dashboardShares.dashboardId, input.dashboardId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError('not_found', {
        code: 'share_not_found',
        messageKey: 'share.not_found',
        internalMessage: `Share ${input.shareId} is not on dashboard ${input.dashboardId}.`,
      });
    }

    if (!row.revokedAt) {
      const now = this.deps.clock.now();
      await this.deps.db
        .update(dashboardShares)
        .set({ revokedAt: now, revokedByUserId: input.actorUserId })
        .where(eq(dashboardShares.id, row.id));
      await this.deps.db.delete(shareSessions).where(eq(shareSessions.shareId, row.id));
      await this.deps.discardExports(row.id);
      await this.deps.audit.record({
        action: 'share.revoked',
        outcome: 'success',
        actorUserId: input.actorUserId,
        tenantId: row.tenantId,
        projectId: row.projectId,
        targetType: 'dashboard',
        targetId: row.dashboardId,
        metadata: { shareId: row.id },
      });
    }

    const [summary] = await this.list(input.tenantId, input.dashboardId, row.id);
    return summary!;
  }

  /**
   * What is behind a link, decided now.
   *
   * Every reason a link does not work - unknown, revoked, expired, archived,
   * suspended, creator gone - collapses to `unavailable` for the recipient.
   */
  async resolve(token: string, sessionToken?: string): Promise<ShareResolution> {
    if (!token || token.length > 128) return { state: 'unavailable' };
    const [share] = await this.deps.db
      .select()
      .from(dashboardShares)
      .where(eq(dashboardShares.tokenHash, hashToken(token)))
      .limit(1);
    if (!share) return { state: 'unavailable' };

    const standing = await this.standing(share);
    if (standing.status !== 'active') return { state: 'unavailable' };

    if (share.passwordHash && !(await this.sessionValid(share.id, sessionToken))) {
      return { state: 'password_required', share };
    }

    const [context] = await this.deps.db
      .select({
        tenantName: tenants.name,
        projectName: projects.name,
        versionSnapshot: dashboardVersions.snapshot,
        version: dashboardVersions.version,
        description: dashboards.description,
      })
      .from(dashboards)
      .innerJoin(tenants, eq(tenants.id, dashboards.tenantId))
      .innerJoin(projects, eq(projects.id, dashboards.projectId))
      .innerJoin(dashboardVersions, eq(dashboardVersions.id, dashboards.publishedVersionId))
      .where(eq(dashboards.id, share.dashboardId))
      .limit(1);
    if (!context) return { state: 'unavailable' };

    // Always the latest published version (Shared Contract §11) - never the draft.
    const snapshot = context.versionSnapshot as unknown as DashboardSnapshot;
    const [site] = await this.deps.db
      .select({ id: matomoSites.id, name: matomoSites.name, timezone: matomoSites.timezone })
      .from(projectSites)
      .innerJoin(matomoSites, eq(matomoSites.id, projectSites.siteId))
      .where(
        and(
          eq(projectSites.projectId, share.projectId),
          eq(projectSites.siteId, snapshot.siteId),
          eq(matomoSites.tenantId, share.tenantId),
        ),
      )
      .limit(1);
    if (!site) return { state: 'unavailable' };

    const rights = rightsOf(share);
    return {
      state: 'available',
      share,
      rights,
      snapshot,
      publishedVersion: context.version,
      tenantName: context.tenantName,
      projectName: context.projectName,
      site,
      meta: {
        dashboardName: snapshot.name,
        ...(snapshot.description ? { description: snapshot.description } : {}),
        tenantName: context.tenantName,
        expiresAt: share.expiresAt.toISOString(),
        rights,
      },
    };
  }

  /**
   * Checks a share's password and opens a short session for it.
   *
   * Refuses without saying why when the link itself does not work. After
   * repeated wrong passwords the share pauses for a while, so a password
   * cannot be guessed through the link.
   */
  async unlock(token: string, password: string): Promise<ShareUnlocked> {
    const resolution = await this.resolve(token);
    if (resolution.state === 'unavailable') throw unavailable();
    const share = resolution.share;
    if (!share.passwordHash) throw unavailable();

    const now = this.deps.clock.now();
    if (share.unlockBlockedUntil && share.unlockBlockedUntil > now) {
      throw new AppError('rate_limited', {
        code: 'share_unlock_paused',
        messageKey: 'share.unlock_paused',
        messageParams: { minutes: UNLOCK_BLOCK_MINUTES },
        internalMessage: `Share ${share.id} is paused after failed password attempts.`,
      });
    }

    if (!(await verifyPassword(share.passwordHash, password))) {
      const failed = share.failedUnlocks + 1;
      await this.deps.db
        .update(dashboardShares)
        .set({
          failedUnlocks: failed >= UNLOCK_ATTEMPTS ? 0 : failed,
          ...(failed >= UNLOCK_ATTEMPTS
            ? { unlockBlockedUntil: new Date(now.getTime() + UNLOCK_BLOCK_MINUTES * 60_000) }
            : {}),
        })
        .where(eq(dashboardShares.id, share.id));
      throw new AppError('validation_failed', {
        code: 'share_password_wrong',
        messageKey: 'share.password_wrong',
        internalMessage: `Wrong password for share ${share.id}.`,
      });
    }

    const sessionToken = generateSecretToken(32);
    const expiresAt = new Date(
      Math.min(share.expiresAt.getTime(), now.getTime() + SHARE_SESSION_HOURS * 3_600_000),
    );
    await this.deps.db.insert(shareSessions).values({
      id: newId(),
      shareId: share.id,
      tokenHash: hashToken(sessionToken),
      expiresAt,
      createdAt: now,
    });
    await this.deps.db
      .update(dashboardShares)
      .set({ failedUnlocks: 0, unlockBlockedUntil: null })
      .where(eq(dashboardShares.id, share.id));

    return { sessionToken, expiresAt: expiresAt.toISOString() };
  }

  /** Counts a view. Throttled to one write a minute per share. */
  async touch(share: ShareRow): Promise<void> {
    const now = this.deps.clock.now();
    if (share.lastAccessedAt && now.getTime() - share.lastAccessedAt.getTime() < 60_000) return;
    await this.deps.db
      .update(dashboardShares)
      .set({ lastAccessedAt: now, accessCount: share.accessCount + 1 })
      .where(eq(dashboardShares.id, share.id));
  }

  async purgeExpiredSessions(): Promise<number> {
    const now = this.deps.clock.now();
    const expired = await this.deps.db
      .select({ id: shareSessions.id })
      .from(shareSessions)
      .where(lte(shareSessions.expiresAt, now));
    if (expired.length > 0) {
      await this.deps.db.delete(shareSessions).where(lte(shareSessions.expiresAt, now));
    }
    return expired.length;
  }

  private async sessionValid(shareId: string, sessionToken: string | undefined): Promise<boolean> {
    if (!sessionToken || sessionToken.length > 128) return false;
    const [session] = await this.deps.db
      .select({ id: shareSessions.id })
      .from(shareSessions)
      .where(
        and(
          eq(shareSessions.tokenHash, hashToken(sessionToken)),
          eq(shareSessions.shareId, shareId),
          gt(shareSessions.expiresAt, this.deps.clock.now()),
        ),
      )
      .limit(1);
    return Boolean(session);
  }

  /** Whether a share works right now, and if not, why - for its owners. */
  private async standing(share: ShareRow): Promise<Standing> {
    if (share.revokedAt) return { status: 'revoked' };
    if (share.expiresAt <= this.deps.clock.now()) return { status: 'expired' };

    const [row] = await this.deps.db
      .select({
        tenantLifecycle: tenants.lifecycle,
        dashboardLifecycle: dashboards.lifecycle,
        publishedVersionId: dashboards.publishedVersionId,
      })
      .from(dashboards)
      .innerJoin(tenants, eq(tenants.id, dashboards.tenantId))
      .where(eq(dashboards.id, share.dashboardId))
      .limit(1);

    if (!row || (row.tenantLifecycle !== 'active' && row.tenantLifecycle !== 'provisioning')) {
      return { status: 'unavailable', reason: 'tenant_inactive' };
    }
    if (!row.publishedVersionId || isHidden(row.dashboardLifecycle)) {
      return { status: 'unavailable', reason: 'dashboard_not_published' };
    }
    // The customer lost the module: the link is kept, and stops working.
    if (
      !(await this.deps.entitlements.hasEntitlement(
        { tenantId: share.tenantId },
        'sharing.external',
      ))
    ) {
      return { status: 'unavailable', reason: 'entitlement_missing' };
    }
    if (!(await this.creatorMayShare(share))) {
      return { status: 'unavailable', reason: 'creator_lost_access' };
    }
    return { status: 'active' };
  }

  /**
   * A share lends its creator's access; it cannot outlive it. Checked against
   * the creator's current roles and grants, exactly as their own request would be.
   */
  private async creatorMayShare(share: ShareRow): Promise<boolean> {
    if (!share.createdByUserId) return false;
    const context: AuthContext | null = await resolveAuthContext(
      this.deps.db,
      asUserId(share.createdByUserId),
      this.deps.clock.now(),
    );
    if (!context) return false;

    const mayShare = await this.deps.authorization.can(context, 'dashboard.share', {
      type: 'project',
      projectId: share.projectId,
    });
    if (!mayShare) return false;

    const decision = await this.deps.access.decideDashboard(context, share.dashboardId, 'view');
    return decision.granted;
  }
}

function rightsOf(share: ShareRow): ShareRights {
  return {
    timeRange: share.allowTimeRange === 1,
    comparison: share.allowComparison === 1,
    detail: share.allowDetail === 1,
    export: share.allowExport === 1,
  };
}

function isHidden(lifecycle: string): boolean {
  return lifecycle === 'archived' || lifecycle === 'trash';
}

function unavailable(): AppError {
  return new AppError('not_found', {
    code: 'share_unavailable',
    messageKey: 'share.unavailable',
    internalMessage: 'The share is unknown, revoked, expired or its dashboard is gone.',
  });
}
