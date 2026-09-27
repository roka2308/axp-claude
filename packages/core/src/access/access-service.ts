import { and, eq, inArray, or } from 'drizzle-orm';
import {
  AppError,
  type AccessReason,
  type AuthContext,
  type DataAccessDecision,
  type GroupId,
  type ObjectAccess,
  type ObjectGrant,
  type ObjectType,
  type SubjectType,
  type UserId,
} from '@axp/contracts';
import { type Database, dashboards, groups, newId, objectGrants, projects, users } from '@axp/db';
import type { AuditService } from '../audit/audit-service';
import type { AuthorizationService } from './authorization-service';

export interface AccessServiceDeps {
  readonly db: Database;
  readonly audit: AuditService;
  readonly authorization: AuthorizationService;
}

/** An object grant with the names a person needs to read it. */
export interface ObjectGrantView extends ObjectGrant {
  readonly subjectLabel: string;
  readonly objectLabel: string;
}

/**
 * Object grants, and the decision that uses them (ADR 0006).
 *
 * "Rolle ist nicht gleich automatischer Datenzugriff" (Master Spec §7). A role
 * says what someone may do in a scope; a grant says which objects they may do
 * it to. Seeing or changing the analytics data behind a dashboard needs both:
 *
 *   view  - `dashboard.read_published` at the project, and a view or edit
 *           grant on the dashboard or its project;
 *   edit  - `dashboard.edit_draft` at the project, and an edit grant on the
 *           dashboard or its project.
 *
 * Grants are positive only; there is nothing that takes access away except
 * removing what gave it (§7, "no deny rules"). They accumulate across direct
 * grants and every group the user belongs to.
 */
export class AccessService {
  constructor(private readonly deps: AccessServiceDeps) {}

  // --- grants --------------------------------------------------------------

  async grant(input: {
    tenantId: string;
    subjectType: SubjectType;
    subjectId: string;
    objectType: ObjectType;
    objectId: string;
    access: ObjectAccess;
    actorUserId?: string;
  }): Promise<{ grantId: string }> {
    // The object and the subject are checked against the tenant from the
    // database. An id that belongs to another tenant is refused as if it did
    // not exist, because to this tenant it does not.
    await this.requireObjectInTenant(input.tenantId, input.objectType, input.objectId);
    await this.requireSubjectInTenant(input.tenantId, input.subjectType, input.subjectId);

    const [existing] = await this.deps.db
      .select({ id: objectGrants.id })
      .from(objectGrants)
      .where(
        and(
          eq(objectGrants.subjectType, input.subjectType),
          eq(objectGrants.subjectId, input.subjectId),
          eq(objectGrants.objectType, input.objectType),
          eq(objectGrants.objectId, input.objectId),
          eq(objectGrants.access, input.access),
        ),
      )
      .limit(1);
    if (existing) return { grantId: existing.id };

    const grantId = newId();
    await this.deps.db.insert(objectGrants).values({
      id: grantId,
      tenantId: input.tenantId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      objectType: input.objectType,
      objectId: input.objectId,
      access: input.access,
      grantedByUserId: input.actorUserId ?? null,
    });

    await this.deps.audit.success('object_grant.changed', {
      actorUserId: input.actorUserId ?? null,
      tenantId: input.tenantId,
      targetType: input.objectType,
      targetId: input.objectId,
      metadata: {
        change: 'granted',
        grantId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        access: input.access,
      },
    });

    return { grantId };
  }

  async revoke(input: { tenantId: string; grantId: string; actorUserId?: string }): Promise<void> {
    const [row] = await this.deps.db
      .select()
      .from(objectGrants)
      .where(and(eq(objectGrants.id, input.grantId), eq(objectGrants.tenantId, input.tenantId)))
      .limit(1);

    if (!row) {
      throw new AppError('not_found', {
        code: 'grant_not_found',
        messageKey: 'access.grant_not_found',
        internalMessage: `Grant ${input.grantId} is not in tenant ${input.tenantId}.`,
      });
    }

    await this.deps.db.delete(objectGrants).where(eq(objectGrants.id, row.id));

    await this.deps.audit.success('object_grant.changed', {
      actorUserId: input.actorUserId ?? null,
      tenantId: input.tenantId,
      targetType: row.objectType,
      targetId: row.objectId,
      metadata: {
        change: 'revoked',
        grantId: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        access: row.access,
      },
    });
  }

  /** Every grant in a tenant, optionally narrowed to one object or subject, with names. */
  async listGrants(
    tenantId: string,
    filter: {
      objectType?: ObjectType;
      objectId?: string;
      subjectType?: SubjectType;
      subjectIds?: readonly string[];
    } = {},
  ): Promise<ObjectGrantView[]> {
    const conditions = [eq(objectGrants.tenantId, tenantId)];
    if (filter.objectType) conditions.push(eq(objectGrants.objectType, filter.objectType));
    if (filter.objectId) conditions.push(eq(objectGrants.objectId, filter.objectId));
    if (filter.subjectType) conditions.push(eq(objectGrants.subjectType, filter.subjectType));
    if (filter.subjectIds) {
      if (filter.subjectIds.length === 0) return [];
      conditions.push(inArray(objectGrants.subjectId, [...filter.subjectIds]));
    }

    const rows = await this.deps.db
      .select()
      .from(objectGrants)
      .where(and(...conditions));

    const labels = await this.labelsFor(rows);
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      subjectType: row.subjectType,
      subjectId: row.subjectId as UserId | GroupId,
      objectType: row.objectType as ObjectType,
      objectId: row.objectId,
      access: row.access,
      subjectLabel: labels.get(`${row.subjectType}:${row.subjectId}`) ?? '—',
      objectLabel: labels.get(`${row.objectType}:${row.objectId}`) ?? '—',
    }));
  }

  /**
   * Grants a dashboard's creator edit access to it.
   *
   * Without this, an editor who creates a dashboard could not open it - the
   * grant rule has no exception for authorship, so authorship produces a grant.
   */
  async grantCreator(params: {
    tenantId: string;
    dashboardId: string;
    userId: string;
  }): Promise<void> {
    await this.grant({
      tenantId: params.tenantId,
      subjectType: 'user',
      subjectId: params.userId,
      objectType: 'dashboard',
      objectId: params.dashboardId,
      access: 'edit',
      actorUserId: params.userId,
    });
  }

  // --- the decision --------------------------------------------------------

  /**
   * Whether the caller may view or edit the data behind a dashboard, and why.
   *
   * Never short-circuits: both halves are always evaluated, so a refusal can
   * say "the role is there but nobody granted this dashboard" rather than just
   * "no" - which is the question an administrator actually needs answered.
   */
  async decideDashboard(
    context: AuthContext,
    dashboardId: string,
    need: ObjectAccess,
  ): Promise<DataAccessDecision> {
    const [dashboard] = await this.deps.db
      .select({ id: dashboards.id, projectId: dashboards.projectId, name: dashboards.name })
      .from(dashboards)
      .where(eq(dashboards.id, dashboardId))
      .limit(1);

    if (!dashboard) {
      throw new AppError('not_found', {
        code: 'dashboard_not_found',
        messageKey: 'dashboard.not_found',
        internalMessage: `Dashboard ${dashboardId} does not exist.`,
      });
    }

    const capability = need === 'edit' ? 'dashboard.edit_draft' : 'dashboard.read_published';
    const role = await this.deps.authorization.explain(context, capability, {
      type: 'project',
      projectId: dashboard.projectId,
    });

    const grants =
      (
        await this.grantReasons(
          context,
          [{ id: dashboard.id, projectId: dashboard.projectId }],
          need,
        )
      ).get(dashboard.id) ?? [];

    const granted = role.granted && grants.length > 0;
    return {
      dashboardId,
      need,
      granted,
      role,
      grants,
      ...(granted
        ? {}
        : {
            missing:
              !role.granted && grants.length === 0
                ? 'role_and_grant'
                : !role.granted
                  ? 'role'
                  : 'grant',
          }),
    };
  }

  /** Throws `permission_denied` naming the missing half, or returns quietly. */
  async assertDashboard(context: AuthContext, dashboardId: string, need: ObjectAccess) {
    const decision = await this.decideDashboard(context, dashboardId, need);
    if (decision.granted) return decision;

    throw new AppError('permission_denied', {
      code: decision.missing === 'grant' ? 'no_object_grant' : 'capability_denied',
      messageKey:
        decision.missing === 'grant'
          ? 'errors.permission_denied.no_object_grant'
          : 'errors.permission_denied.capability',
      internalMessage: `User ${context.userId} lacks ${need} on dashboard ${dashboardId} (${decision.missing}).`,
    });
  }

  /**
   * Refuses unless the caller holds a grant on the project itself.
   *
   * For the places that show a project's analytics without a dashboard in
   * between - the catalog's formula preview is one. A Semantic Catalog Manager
   * defines what numbers mean; seeing this customer's numbers is a separate
   * permission (Master Spec §7).
   */
  async assertProjectData(context: AuthContext, projectId: string): Promise<void> {
    const subjectFilter =
      context.groupIds.length > 0
        ? or(
            and(eq(objectGrants.subjectType, 'user'), eq(objectGrants.subjectId, context.userId)),
            and(
              eq(objectGrants.subjectType, 'group'),
              inArray(objectGrants.subjectId, [...context.groupIds]),
            ),
          )
        : and(eq(objectGrants.subjectType, 'user'), eq(objectGrants.subjectId, context.userId));

    const [grant] = await this.deps.db
      .select({ id: objectGrants.id })
      .from(objectGrants)
      .where(
        and(
          subjectFilter,
          eq(objectGrants.objectType, 'project'),
          eq(objectGrants.objectId, projectId),
        ),
      )
      .limit(1);

    if (grant) return;

    throw new AppError('permission_denied', {
      code: 'no_object_grant',
      messageKey: 'errors.permission_denied.no_project_data_grant',
      internalMessage: `User ${context.userId} has no data grant on project ${projectId}.`,
    });
  }

  /**
   * The subset of dashboards the caller may open at the given level.
   *
   * One query for the grants, however many dashboards: this runs for every
   * project page, library and search.
   */
  async filterDashboards<T extends { id: string; projectId: string }>(
    context: AuthContext,
    candidates: readonly T[],
    need: ObjectAccess,
  ): Promise<T[]> {
    if (candidates.length === 0) return [];

    const capability = need === 'edit' ? 'dashboard.edit_draft' : 'dashboard.read_published';
    const roleByProject = new Map<string, boolean>();
    for (const projectId of new Set(candidates.map((candidate) => candidate.projectId))) {
      roleByProject.set(
        projectId,
        await this.deps.authorization.can(context, capability, { type: 'project', projectId }),
      );
    }

    const reasons = await this.grantReasons(context, candidates, need);
    return candidates.filter(
      (candidate) =>
        roleByProject.get(candidate.projectId) === true &&
        (reasons.get(candidate.id)?.length ?? 0) > 0,
    );
  }

  /**
   * Every grant chain that covers each dashboard at the needed level.
   *
   * A grant covers a dashboard when it names the dashboard or its project, is
   * held by the user or one of their groups, and is at least as strong as
   * needed (`edit` satisfies `view`).
   */
  private async grantReasons(
    context: AuthContext,
    targets: readonly { id: string; projectId: string }[],
    need: ObjectAccess,
  ): Promise<Map<string, AccessReason[]>> {
    const result = new Map<string, AccessReason[]>(targets.map((target) => [target.id, []]));
    if (targets.length === 0) return result;

    const subjectFilter =
      context.groupIds.length > 0
        ? or(
            and(eq(objectGrants.subjectType, 'user'), eq(objectGrants.subjectId, context.userId)),
            and(
              eq(objectGrants.subjectType, 'group'),
              inArray(objectGrants.subjectId, [...context.groupIds]),
            ),
          )
        : and(eq(objectGrants.subjectType, 'user'), eq(objectGrants.subjectId, context.userId));

    const objectIds = [
      ...new Set([...targets.map((target) => target.id), ...targets.map((t) => t.projectId)]),
    ];

    const rows = await this.deps.db
      .select()
      .from(objectGrants)
      .where(and(subjectFilter, inArray(objectGrants.objectId, objectIds)));

    const usable = rows.filter((row) => need === 'view' || row.access === 'edit');
    if (usable.length === 0) return result;

    const labels = await this.labelsFor(usable);

    for (const target of targets) {
      for (const row of usable) {
        const covers =
          (row.objectType === 'dashboard' && row.objectId === target.id) ||
          (row.objectType === 'project' && row.objectId === target.projectId);
        if (!covers) continue;

        const viaGroup = row.subjectType === 'group';
        result.get(target.id)!.push({
          chain: [
            { kind: 'user', userId: context.userId, label: 'user' },
            ...(viaGroup
              ? [
                  {
                    kind: 'group' as const,
                    groupId: row.subjectId as GroupId,
                    label: labels.get(`group:${row.subjectId}`) ?? 'group',
                  },
                ]
              : []),
            {
              kind: 'object_grant',
              grantId: row.id,
              objectType: row.objectType as ObjectType,
              objectId: row.objectId,
              access: row.access,
              label: labels.get(`${row.objectType}:${row.objectId}`) ?? row.objectId,
            },
          ],
          summaryKey: viaGroup
            ? row.objectType === 'project'
              ? 'access.reason.grant_via_group_project'
              : 'access.reason.grant_via_group_dashboard'
            : row.objectType === 'project'
              ? 'access.reason.grant_direct_project'
              : 'access.reason.grant_direct_dashboard',
        });
      }
    }

    return result;
  }

  // --- tenancy checks and names --------------------------------------------

  private async requireObjectInTenant(tenantId: string, objectType: ObjectType, objectId: string) {
    const [row] =
      objectType === 'dashboard'
        ? await this.deps.db
            .select({ tenantId: dashboards.tenantId })
            .from(dashboards)
            .where(eq(dashboards.id, objectId))
            .limit(1)
        : await this.deps.db
            .select({ tenantId: projects.tenantId })
            .from(projects)
            .where(eq(projects.id, objectId))
            .limit(1);

    if (!row || row.tenantId !== tenantId) {
      throw new AppError('not_found', {
        code: 'grant_object_not_found',
        messageKey: 'access.object_not_found',
        internalMessage: `${objectType} ${objectId} is not in tenant ${tenantId}.`,
      });
    }
  }

  private async requireSubjectInTenant(
    tenantId: string,
    subjectType: SubjectType,
    subjectId: string,
  ) {
    if (subjectType === 'group') {
      const [group] = await this.deps.db
        .select({ tenantId: groups.tenantId })
        .from(groups)
        .where(eq(groups.id, subjectId))
        .limit(1);
      if (!group || group.tenantId !== tenantId) {
        throw new AppError('not_found', {
          code: 'grant_subject_not_found',
          messageKey: 'access.subject_not_found',
          internalMessage: `Group ${subjectId} is not in tenant ${tenantId}.`,
        });
      }
      return;
    }

    const [user] = await this.deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, subjectId))
      .limit(1);
    if (!user) {
      throw new AppError('not_found', {
        code: 'grant_subject_not_found',
        messageKey: 'access.subject_not_found',
        internalMessage: `User ${subjectId} does not exist.`,
      });
    }
  }

  /** Display names for the subjects and objects of a set of grant rows. */
  private async labelsFor(
    rows: readonly {
      subjectType: string;
      subjectId: string;
      objectType: string;
      objectId: string;
    }[],
  ): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const ids = (kind: string, field: 'subject' | 'object') => [
      ...new Set(
        rows
          .filter((row) => (field === 'subject' ? row.subjectType : row.objectType) === kind)
          .map((row) => (field === 'subject' ? row.subjectId : row.objectId)),
      ),
    ];

    const userIds = ids('user', 'subject');
    const groupIds = ids('group', 'subject');
    const dashboardIds = ids('dashboard', 'object');
    const projectIds = ids('project', 'object');

    if (userIds.length > 0) {
      for (const row of await this.deps.db
        .select({ id: users.id, first: users.firstName, last: users.lastName })
        .from(users)
        .where(inArray(users.id, userIds))) {
        labels.set(`user:${row.id}`, `${row.first} ${row.last}`.trim());
      }
    }
    if (groupIds.length > 0) {
      for (const row of await this.deps.db
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(inArray(groups.id, groupIds))) {
        labels.set(`group:${row.id}`, row.name);
      }
    }
    if (dashboardIds.length > 0) {
      for (const row of await this.deps.db
        .select({ id: dashboards.id, name: dashboards.name })
        .from(dashboards)
        .where(inArray(dashboards.id, dashboardIds))) {
        labels.set(`dashboard:${row.id}`, row.name);
      }
    }
    if (projectIds.length > 0) {
      for (const row of await this.deps.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds))) {
        labels.set(`project:${row.id}`, row.name);
      }
    }

    return labels;
  }
}
