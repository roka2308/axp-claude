import type { TenantSummary, TenantOverview, LifecycleImpact } from '@axp/contracts';
import { and, count, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import {
  AppError,
  type AuthContext,
  canTransitionTenant,
  TENANT_LIFECYCLE_STATES,
  type TenantLifecycle,
  tenantProcessingHalted,
} from '@axp/contracts';
import {
  dashboards,
  type Database,
  groups,
  matomoConnections,
  projects,
  sessions,
  tenantMemberships,
  tenants,
} from '@axp/db';
import type { Clock } from '../clock';
import type { TenantService } from './tenant-service';
import type { UserAdminService } from '../identity/user-admin-service';
import type { RoleAssignmentService } from '../access/role-assignment-service';

export interface TenantAdminServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly tenants: TenantService;
  readonly userAdmin: UserAdminService;
  readonly roles: RoleAssignmentService;
  readonly revokeAllSessions: (userId: string, reason: string) => Promise<number>;
}

/**
 * Tenants, as the Platform Admin sees them (D5).
 *
 * Creation is a small wizard - basic data, the first tenant administrator, an
 * optional first project - so that a new tenant is never left without someone
 * who can run it. Lifecycle changes are previewed, confirmed by typing the
 * tenant's name, and applied with their consequences: suspending a tenant
 * signs out everyone for whom it is the only tenant.
 */
export class TenantAdminService {
  constructor(private readonly deps: TenantAdminServiceDeps) {}

  async list(): Promise<TenantSummary[]> {
    const rows = await this.deps.db.select().from(tenants);
    const projectCounts = await this.countBy(projects, projects.tenantId);
    const memberCounts = await this.countBy(tenantMemberships, tenantMemberships.tenantId);

    return rows
      .map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        lifecycle: row.lifecycle,
        projects: projectCounts.get(row.id) ?? 0,
        users: memberCounts.get(row.id) ?? 0,
        lifecycleChangedAt: row.lifecycleChangedAt?.toISOString() ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async overview(tenantId: string): Promise<TenantOverview> {
    const tenant = await this.require(tenantId);

    const projectList = await this.deps.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.tenantId, tenantId));
    const [memberCount] = await this.deps.db
      .select({ n: count() })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.tenantId, tenantId));
    const [groupCount] = await this.deps.db
      .select({ n: count() })
      .from(groups)
      .where(eq(groups.tenantId, tenantId));
    const [dashboardCount] = await this.deps.db
      .select({ n: count() })
      .from(dashboards)
      .where(and(eq(dashboards.tenantId, tenantId), ne(dashboards.lifecycle, 'trash')));
    const [connectionCount] = await this.deps.db
      .select({ n: count() })
      .from(matomoConnections)
      .where(eq(matomoConnections.tenantId, tenantId));

    return {
      id: tenant.id,
      portableId: tenant.portableId,
      name: tenant.name,
      slug: tenant.slug,
      lifecycle: tenant.lifecycle,
      defaultLocale: tenant.defaultLocale,
      lifecycleChangedAt: tenant.lifecycleChangedAt?.toISOString() ?? null,
      projects: projectList.length,
      users: Number(memberCount?.n ?? 0),
      groups: Number(groupCount?.n ?? 0),
      dashboards: Number(dashboardCount?.n ?? 0),
      connections: Number(connectionCount?.n ?? 0),
      projectList: projectList.sort((a, b) => a.name.localeCompare(b.name, 'de')),
      allowedTransitions: TENANT_LIFECYCLE_STATES.filter((state) =>
        canTransitionTenant(tenant.lifecycle, state),
      ),
    };
  }

  /**
   * The create wizard, in one call: tenant, first tenant admin, optional project.
   *
   * Steps 1-3 of D5 collect the data; step 4 ("Prüfung und Erzeugung") is this.
   * The tenant starts in `provisioning`, so it serves nobody until someone
   * activates it deliberately.
   */
  async create(input: {
    actor: AuthContext;
    name: string;
    slug: string;
    defaultLocale: 'de' | 'en';
    admin: { email: string; firstName: string; lastName: string };
    firstProject?: { name: string; slug: string; timezone?: string };
  }): Promise<{
    tenantId: string;
    adminUserId: string;
    invitation: { token: string; expiresAt: string } | null;
    projectId: string | null;
  }> {
    const clash = await this.deps.tenants.findTenantBySlug(input.slug);
    if (clash) {
      throw new AppError('conflict', {
        code: 'tenant_slug_taken',
        messageKey: 'admin.tenant_slug_taken',
        fieldErrors: { slug: 'admin.tenant_slug_taken' },
      });
    }

    const { tenantId } = await this.deps.tenants.createTenant({
      portableId: `tenant.${input.slug}`,
      name: input.name,
      slug: input.slug,
      defaultLocale: input.defaultLocale,
      actorUserId: input.actor.userId,
    });

    const { userId, invitation } = await this.deps.userAdmin.invite({
      tenantId,
      email: input.admin.email,
      firstName: input.admin.firstName,
      lastName: input.admin.lastName,
      locale: input.defaultLocale,
      actorUserId: input.actor.userId,
    });

    await this.deps.roles.assign({
      actor: input.actor,
      subjectType: 'user',
      subjectId: userId,
      role: 'tenant_admin',
      scopeType: 'tenant',
      scopeId: tenantId,
    });

    let projectId: string | null = null;
    if (input.firstProject) {
      projectId = (
        await this.deps.tenants.createProject({
          tenantId,
          portableId: `project.${input.firstProject.slug}`,
          name: input.firstProject.name,
          slug: input.firstProject.slug,
          ...(input.firstProject.timezone ? { timezone: input.firstProject.timezone } : {}),
          defaultLocale: input.defaultLocale,
          actorUserId: input.actor.userId,
        })
      ).projectId;
    }

    return { tenantId, adminUserId: userId, invitation, projectId };
  }

  async lifecycleImpact(tenantId: string, to: TenantLifecycle): Promise<LifecycleImpact> {
    const tenant = await this.require(tenantId);
    const now = this.deps.clock.now();

    const members = await this.deps.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.tenantId, tenantId));
    const memberIds = members.map((member) => member.userId);
    const exclusive = await this.exclusiveMembers(tenantId, memberIds);

    const live =
      exclusive.length > 0
        ? await this.deps.db
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                inArray(sessions.userId, exclusive),
                isNull(sessions.revokedAt),
                gt(sessions.idleExpiresAt, now),
                gt(sessions.absoluteExpiresAt, now),
              ),
            )
        : [];

    const [dashboardCount] = await this.deps.db
      .select({ n: count() })
      .from(dashboards)
      .where(and(eq(dashboards.tenantId, tenantId), ne(dashboards.lifecycle, 'trash')));

    const halts = !tenantProcessingHalted(tenant.lifecycle) && tenantProcessingHalted(to);
    return {
      from: tenant.lifecycle,
      to,
      allowed: canTransitionTenant(tenant.lifecycle, to),
      haltsProcessing: halts,
      resumesProcessing: tenantProcessingHalted(tenant.lifecycle) && !tenantProcessingHalted(to),
      usersSignedOut: halts ? exclusive.length : 0,
      liveSessions: halts ? live.length : 0,
      affectedUsers: memberIds.length,
      dashboards: Number(dashboardCount?.n ?? 0),
      irreversible: to === 'deleted',
      confirmationPhrase: tenant.name,
    };
  }

  /**
   * Applies a lifecycle change after its preview has been confirmed.
   *
   * The confirmation is the tenant's name, typed. Re-authentication is checked
   * by the caller (the route), because it is a property of the session.
   */
  async changeLifecycle(input: {
    tenantId: string;
    to: TenantLifecycle;
    confirmation: string;
    actorUserId: string;
  }): Promise<LifecycleImpact> {
    const impact = await this.lifecycleImpact(input.tenantId, input.to);

    if (!impact.allowed) {
      throw new AppError('conflict', {
        code: 'invalid_lifecycle_transition',
        messageKey: 'tenant.invalid_lifecycle_transition',
        messageParams: { from: impact.from, to: impact.to },
      });
    }
    if (input.confirmation.trim() !== impact.confirmationPhrase) {
      throw new AppError('validation_failed', {
        code: 'confirmation_mismatch',
        messageKey: 'admin.confirmation_mismatch',
        fieldErrors: { confirmation: 'admin.confirmation_mismatch' },
      });
    }

    await this.deps.tenants.changeLifecycle(input.tenantId, input.to, input.actorUserId);

    // Suspension stops access at once rather than at the next request: the
    // sessions of people for whom this is the only tenant are ended now.
    if (impact.haltsProcessing) {
      const members = await this.deps.db
        .select({ userId: tenantMemberships.userId })
        .from(tenantMemberships)
        .where(eq(tenantMemberships.tenantId, input.tenantId));
      for (const userId of await this.exclusiveMembers(
        input.tenantId,
        members.map((member) => member.userId),
      )) {
        await this.deps.revokeAllSessions(userId, `tenant_${input.to}`);
      }
    }

    return impact;
  }

  private async require(tenantId: string) {
    const [tenant] = await this.deps.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) {
      throw new AppError('not_found', {
        code: 'tenant_not_found',
        messageKey: 'tenant.not_found',
      });
    }
    return tenant;
  }

  /** Members with no other tenant - the ones a suspension locks out entirely. */
  private async exclusiveMembers(tenantId: string, memberIds: readonly string[]) {
    if (memberIds.length === 0) return [];
    const elsewhere = await this.deps.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(
        and(
          inArray(tenantMemberships.userId, [...memberIds]),
          ne(tenantMemberships.tenantId, tenantId),
        ),
      );
    const other = new Set(elsewhere.map((row) => row.userId));
    return memberIds.filter((id) => !other.has(id));
  }

  private async countBy(
    table: typeof projects | typeof tenantMemberships,
    column: typeof projects.tenantId | typeof tenantMemberships.tenantId,
  ): Promise<Map<string, number>> {
    const rows = await this.deps.db
      .select({ tenantId: column, n: count() })
      .from(table)
      .groupBy(column);
    return new Map(rows.map((row) => [row.tenantId, Number(row.n)]));
  }
}

export type { TenantSummary, TenantOverview, LifecycleImpact };
