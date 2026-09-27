import { and, eq, inArray, ne, or } from 'drizzle-orm';
import {
  AppError,
  type ObjectAccess,
  type ObjectType,
  type ScopeType,
  type SubjectType,
  type SystemRole,
} from '@axp/contracts';
import {
  type Database,
  dashboards,
  groupMembers,
  groups,
  objectGrants,
  projects,
  roleAssignments,
  tenantMemberships,
  tenants,
  users,
} from '@axp/db';
import {
  type AccessDiff,
  type AccessModel,
  computeEffectiveAccess,
  diffEffectiveAccess,
  type EffectiveAccess,
} from './effective-access';

export interface EffectiveAccessServiceDeps {
  readonly db: Database;
}

/** A change an administrator is about to make, described before it is made. */
export type AccessChange =
  | {
      readonly kind: 'assign_role';
      readonly subjectType: SubjectType;
      readonly subjectId: string;
      readonly role: SystemRole;
      readonly scopeType: ScopeType;
      readonly scopeId: string;
    }
  | { readonly kind: 'remove_role'; readonly assignmentId: string }
  | { readonly kind: 'add_member'; readonly groupId: string; readonly userId: string }
  | { readonly kind: 'remove_member'; readonly groupId: string; readonly userId: string }
  | {
      readonly kind: 'grant';
      readonly subjectType: SubjectType;
      readonly subjectId: string;
      readonly objectType: ObjectType;
      readonly objectId: string;
      readonly access: ObjectAccess;
    }
  | { readonly kind: 'revoke'; readonly grantId: string }
  | { readonly kind: 'delete_group'; readonly groupId: string }
  | { readonly kind: 'deactivate_user'; readonly userId: string };

export interface ImpactPreview {
  readonly change: AccessChange;
  /** One entry per person the change reaches, with what they gain and lose. */
  readonly affected: readonly (AccessDiff & { readonly name: string })[];
  /** True when nobody's access changes - worth knowing before confirming. */
  readonly noEffect: boolean;
}

/** Who can open one object, and why - the "Objekte" view (D5). */
export interface ObjectAccessEntry {
  readonly userId: string;
  readonly name: string;
  readonly view: EffectiveAccess['dashboards'][number]['view'];
  readonly edit: EffectiveAccess['dashboards'][number]['edit'];
}

interface ModelAdjustment {
  readonly extraGroupIds?: readonly string[];
  readonly removedGroupIds?: readonly string[];
  readonly inactive?: boolean;
}

/**
 * Effective Access over the database (D5, Gate F5).
 *
 * Loads what one person holds in one tenant into an `AccessModel` and hands it
 * to the pure engine. The impact preview is the same computation over a model
 * with the proposed change applied in memory - nothing is written until the
 * administrator confirms, and what they see is exactly what the engine will
 * answer afterwards.
 */
export class EffectiveAccessService {
  constructor(private readonly deps: EffectiveAccessServiceDeps) {}

  async explainUser(tenantId: string, userId: string): Promise<EffectiveAccess> {
    return computeEffectiveAccess(await this.loadModel(tenantId, userId));
  }

  /** Who in this tenant can view or edit one dashboard, and through what. */
  async explainDashboard(tenantId: string, dashboardId: string): Promise<ObjectAccessEntry[]> {
    const members = await this.memberIds(tenantId);
    const entries: ObjectAccessEntry[] = [];

    for (const userId of members) {
      const model = await this.loadModel(tenantId, userId);
      const access = computeEffectiveAccess(model);
      const dashboard = access.dashboards.find((entry) => entry.id === dashboardId);
      if (!dashboard) {
        throw new AppError('not_found', {
          code: 'dashboard_not_found',
          messageKey: 'dashboard.not_found',
        });
      }
      // Listed when there is anything to say: a grant, a role, or both.
      if (
        dashboard.view.roleReasons.length + dashboard.view.grantReasons.length > 0 ||
        dashboard.edit.grantReasons.length > 0
      ) {
        entries.push({
          userId,
          name: model.user.name,
          view: dashboard.view,
          edit: dashboard.edit,
        });
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async preview(tenantId: string, change: AccessChange): Promise<ImpactPreview> {
    const affected: (AccessDiff & { name: string })[] = [];

    for (const target of await this.affectedBy(tenantId, change)) {
      const before = await this.loadModel(tenantId, target.userId);
      const after = await this.loadModel(tenantId, target.userId, target.adjustment);
      const changed = applyRowChange(after, change, target.userId);

      const diff = diffEffectiveAccess(
        computeEffectiveAccess(before),
        computeEffectiveAccess(changed),
      );
      affected.push({ ...diff, name: before.user.name });
    }

    return { change, affected, noEffect: affected.every((entry) => entry.unchanged) };
  }

  // --- who a change reaches --------------------------------------------------

  private async affectedBy(
    tenantId: string,
    change: AccessChange,
  ): Promise<{ userId: string; adjustment?: ModelAdjustment }[]> {
    switch (change.kind) {
      case 'add_member':
        return [{ userId: change.userId, adjustment: { extraGroupIds: [change.groupId] } }];
      case 'remove_member':
        return [{ userId: change.userId, adjustment: { removedGroupIds: [change.groupId] } }];
      case 'delete_group':
        return (await this.groupMemberIds(change.groupId)).map((userId) => ({
          userId,
          adjustment: { removedGroupIds: [change.groupId] },
        }));
      case 'deactivate_user':
        return [{ userId: change.userId, adjustment: { inactive: true } }];
      case 'assign_role':
      case 'grant':
        return change.subjectType === 'user'
          ? [{ userId: change.subjectId }]
          : (await this.groupMemberIds(change.subjectId)).map((userId) => ({ userId }));
      case 'remove_role': {
        const [row] = await this.deps.db
          .select()
          .from(roleAssignments)
          .where(eq(roleAssignments.id, change.assignmentId))
          .limit(1);
        if (!row) return [];
        return row.subjectType === 'user'
          ? [{ userId: row.subjectId }]
          : (await this.groupMemberIds(row.subjectId)).map((userId) => ({ userId }));
      }
      case 'revoke': {
        const [row] = await this.deps.db
          .select()
          .from(objectGrants)
          .where(and(eq(objectGrants.id, change.grantId), eq(objectGrants.tenantId, tenantId)))
          .limit(1);
        if (!row) return [];
        return row.subjectType === 'user'
          ? [{ userId: row.subjectId }]
          : (await this.groupMemberIds(row.subjectId)).map((userId) => ({ userId }));
      }
    }
  }

  // --- loading ---------------------------------------------------------------

  async loadModel(
    tenantId: string,
    userId: string,
    adjustment: ModelAdjustment = {},
  ): Promise<AccessModel> {
    const [tenant] = await this.deps.db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [user] = await this.deps.db
      .select({ id: users.id, first: users.firstName, last: users.lastName, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!tenant || !user) {
      throw new AppError('not_found', {
        code: 'access_subject_not_found',
        messageKey: 'admin.user_not_found',
      });
    }

    const memberGroups = await this.deps.db
      .select({ id: groups.id, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.tenantId, tenantId)));

    const extra =
      adjustment.extraGroupIds && adjustment.extraGroupIds.length > 0
        ? await this.deps.db
            .select({ id: groups.id, name: groups.name })
            .from(groups)
            .where(
              and(eq(groups.tenantId, tenantId), inArray(groups.id, [...adjustment.extraGroupIds])),
            )
        : [];

    const removed = new Set(adjustment.removedGroupIds ?? []);
    const groupList = [...memberGroups, ...extra].filter(
      (group, index, all) =>
        !removed.has(group.id) && all.findIndex((other) => other.id === group.id) === index,
    );
    const groupIds = groupList.map((group) => group.id);

    const projectRows = await this.deps.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.tenantId, tenantId));

    const dashboardRows = await this.deps.db
      .select({
        id: dashboards.id,
        name: dashboards.name,
        projectId: dashboards.projectId,
        publishedVersionId: dashboards.publishedVersionId,
      })
      .from(dashboards)
      .where(and(eq(dashboards.tenantId, tenantId), ne(dashboards.lifecycle, 'trash')));

    const subjectAssignments = await this.deps.db
      .select()
      .from(roleAssignments)
      .where(
        groupIds.length > 0
          ? or(
              and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, userId)),
              and(
                eq(roleAssignments.subjectType, 'group'),
                inArray(roleAssignments.subjectId, groupIds),
              ),
            )
          : and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, userId)),
      );

    // Only what belongs to this tenant (or the platform) is part of the answer.
    const projectIds = new Set(projectRows.map((project) => project.id));
    const assignments = subjectAssignments.filter(
      (row) =>
        row.scopeType === 'platform' ||
        (row.scopeType === 'tenant' && row.scopeId === tenantId) ||
        (row.scopeType === 'project' && projectIds.has(row.scopeId)),
    );

    const grants = await this.deps.db
      .select()
      .from(objectGrants)
      .where(
        and(
          eq(objectGrants.tenantId, tenantId),
          groupIds.length > 0
            ? or(
                and(eq(objectGrants.subjectType, 'user'), eq(objectGrants.subjectId, userId)),
                and(
                  eq(objectGrants.subjectType, 'group'),
                  inArray(objectGrants.subjectId, groupIds),
                ),
              )
            : and(eq(objectGrants.subjectType, 'user'), eq(objectGrants.subjectId, userId)),
        ),
      );

    return {
      user: {
        id: user.id,
        name: `${user.first} ${user.last}`.trim(),
        active: !adjustment.inactive && user.status === 'active',
      },
      tenant,
      groups: groupList,
      projects: projectRows,
      dashboards: dashboardRows.map((row) => ({
        id: row.id,
        name: row.name,
        projectId: row.projectId,
        published: row.publishedVersionId !== null,
      })),
      assignments: assignments.map((row) => ({
        id: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        role: row.role,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
      })),
      grants: grants.map((row) => ({
        id: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        objectType: row.objectType as ObjectType,
        objectId: row.objectId,
        access: row.access,
      })),
    };
  }

  private async memberIds(tenantId: string): Promise<string[]> {
    const rows = await this.deps.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(eq(tenantMemberships.tenantId, tenantId));
    return rows.map((row) => row.userId);
  }

  private async groupMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.deps.db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    return rows.map((row) => row.userId);
  }
}

/**
 * Applies a role or grant change to a loaded model, in memory.
 *
 * Group membership changes are already in the model through the adjustment;
 * this handles the rows a change adds or removes.
 */
function applyRowChange(model: AccessModel, change: AccessChange, userId: string): AccessModel {
  switch (change.kind) {
    case 'assign_role':
      return {
        ...model,
        assignments: [
          ...model.assignments,
          {
            id: 'preview',
            subjectType: change.subjectType,
            subjectId: change.subjectType === 'user' ? userId : change.subjectId,
            role: change.role,
            scopeType: change.scopeType,
            scopeId: change.scopeId,
          },
        ],
      };
    case 'remove_role':
      return {
        ...model,
        assignments: model.assignments.filter((row) => row.id !== change.assignmentId),
      };
    case 'grant':
      return {
        ...model,
        grants: [
          ...model.grants,
          {
            id: 'preview',
            subjectType: change.subjectType,
            subjectId: change.subjectType === 'user' ? userId : change.subjectId,
            objectType: change.objectType,
            objectId: change.objectId,
            access: change.access,
          },
        ],
      };
    case 'revoke':
      return { ...model, grants: model.grants.filter((row) => row.id !== change.grantId) };
    default:
      return model;
  }
}
