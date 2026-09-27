import type { RoleAssignmentView } from '@axp/contracts';
import { and, eq, inArray, or } from 'drizzle-orm';
import {
  AppError,
  ASSIGNABLE_ROLES_BY_ROLE,
  type AuthContext,
  roleAllowsScope,
  type ScopeType,
  type SubjectType,
  type SystemRole,
} from '@axp/contracts';
import {
  type Database,
  groupMembers,
  groups,
  newId,
  projects,
  roleAssignments,
  tenantMemberships,
  tenants,
  users,
} from '@axp/db';
import type { AuditService } from '../audit/audit-service';

export interface RoleAssignmentServiceDeps {
  readonly db: Database;
  readonly audit: AuditService;
}

/**
 * Role assignments (Master Spec §7, Shared Contract §3).
 *
 * The rules that make administration safe live here rather than in the UI:
 *
 *   - a role can only be anchored at a scope it allows (tenant admin at a
 *     tenant, platform admin at the platform);
 *   - the actor must be allowed to hand out that role at that scope - a tenant
 *     admin within their own tenant, and never `platform_admin`;
 *   - the subject must belong to the tenant the scope belongs to;
 *   - the last tenant admin of a tenant, and the last platform admin, cannot
 *     be removed - a tenant nobody can administer is a support ticket.
 */
export class RoleAssignmentService {
  constructor(private readonly deps: RoleAssignmentServiceDeps) {}

  async assign(input: {
    actor: AuthContext;
    subjectType: SubjectType;
    subjectId: string;
    role: SystemRole;
    scopeType: ScopeType;
    scopeId: string;
  }): Promise<{ assignmentId: string }> {
    if (!roleAllowsScope(input.role, input.scopeType)) {
      throw new AppError('validation_failed', {
        code: 'role_scope_not_allowed',
        messageKey: 'admin.role_scope_not_allowed',
        messageParams: { role: input.role, scope: input.scopeType },
      });
    }

    const tenantId = await this.tenantOfScope(input.scopeType, input.scopeId);
    await this.assertMayAssign(input.actor, input.role, input.scopeType, tenantId);
    await this.assertSubjectInScope(input.subjectType, input.subjectId, input.scopeType, tenantId);

    const [existing] = await this.deps.db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.subjectType, input.subjectType),
          eq(roleAssignments.subjectId, input.subjectId),
          eq(roleAssignments.role, input.role),
          eq(roleAssignments.scopeType, input.scopeType),
          eq(roleAssignments.scopeId, input.scopeId),
        ),
      )
      .limit(1);
    if (existing) return { assignmentId: existing.id };

    const assignmentId = newId();
    await this.deps.db.insert(roleAssignments).values({
      id: assignmentId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      grantedByUserId: input.actor.userId,
    });

    await this.deps.audit.success('role_assignment.created', {
      actorUserId: input.actor.userId,
      tenantId,
      targetType: input.subjectType,
      targetId: input.subjectId,
      metadata: {
        assignmentId,
        role: input.role,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      },
    });

    return { assignmentId };
  }

  async remove(input: { actor: AuthContext; assignmentId: string }): Promise<void> {
    const [row] = await this.deps.db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, input.assignmentId))
      .limit(1);

    if (!row) {
      throw new AppError('not_found', {
        code: 'role_assignment_not_found',
        messageKey: 'admin.role_assignment_not_found',
      });
    }

    const tenantId = await this.tenantOfScope(row.scopeType, row.scopeId);
    await this.assertMayAssign(input.actor, row.role, row.scopeType, tenantId);

    if (row.role === 'tenant_admin' || row.role === 'platform_admin') {
      const remaining = await this.countHolders(row.role, row.scopeType, row.scopeId, row.id);
      if (remaining === 0) {
        throw new AppError('conflict', {
          code: 'last_admin',
          messageKey:
            row.role === 'tenant_admin' ? 'admin.last_tenant_admin' : 'admin.last_platform_admin',
          internalMessage: `Refused to remove the last ${row.role} at ${row.scopeType}:${row.scopeId}.`,
        });
      }
    }

    await this.deps.db.delete(roleAssignments).where(eq(roleAssignments.id, row.id));

    await this.deps.audit.success('role_assignment.removed', {
      actorUserId: input.actor.userId,
      tenantId,
      targetType: row.subjectType,
      targetId: row.subjectId,
      metadata: {
        assignmentId: row.id,
        role: row.role,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
      },
    });
  }

  /** The roles an actor may hand out at a scope - what the UI offers, nothing more. */
  async assignableRoles(
    actor: AuthContext,
    scopeType: ScopeType,
    scopeId: string,
  ): Promise<SystemRole[]> {
    const tenantId = await this.tenantOfScope(scopeType, scopeId).catch(() => null);
    const roles = new Set<SystemRole>();
    for (const assignment of actor.roleAssignments) {
      const reaches =
        assignment.scopeType === 'platform' ||
        (assignment.scopeType === 'tenant' && tenantId !== null && assignment.scopeId === tenantId);
      if (!reaches) continue;
      for (const role of ASSIGNABLE_ROLES_BY_ROLE[assignment.role]) {
        if (roleAllowsScope(role, scopeType)) roles.add(role);
      }
    }
    return [...roles];
  }

  /**
   * Every assignment that reaches a user in one tenant: direct, and through
   * each of their groups, with the scope named.
   */
  async listForUser(tenantId: string, userId: string): Promise<RoleAssignmentView[]> {
    const memberships = await this.deps.db
      .select({ id: groups.id, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.tenantId, tenantId)));

    const groupIds = memberships.map((group) => group.id);
    const rows = await this.deps.db
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

    const groupNames = new Map(memberships.map((group) => [group.id, group.name]));
    return this.present(tenantId, rows, groupNames);
  }

  async listForGroup(tenantId: string, groupId: string): Promise<RoleAssignmentView[]> {
    const rows = await this.deps.db
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.subjectType, 'group'), eq(roleAssignments.subjectId, groupId)));
    return this.present(tenantId, rows, new Map());
  }

  /** Every assignment anchored in a tenant, for the "Rollen" view. */
  async listForTenant(tenantId: string): Promise<RoleAssignmentView[]> {
    const projectRows = await this.deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.tenantId, tenantId));
    const projectIds = projectRows.map((project) => project.id);

    const rows = await this.deps.db
      .select()
      .from(roleAssignments)
      .where(
        or(
          and(eq(roleAssignments.scopeType, 'tenant'), eq(roleAssignments.scopeId, tenantId)),
          ...(projectIds.length > 0
            ? [
                and(
                  eq(roleAssignments.scopeType, 'project'),
                  inArray(roleAssignments.scopeId, projectIds),
                ),
              ]
            : []),
        ),
      );
    return this.present(tenantId, rows, new Map());
  }

  // --- rules ---------------------------------------------------------------

  /**
   * Whether the actor may hand out (or take back) this role at this scope.
   *
   * A platform admin reaches every scope. A tenant admin reaches their tenant
   * and its projects, and `ASSIGNABLE_ROLES_BY_ROLE` keeps `platform_admin` out
   * of their hands entirely (Master Spec §7).
   */
  private async assertMayAssign(
    actor: AuthContext,
    role: SystemRole,
    scopeType: ScopeType,
    tenantId: string | null,
  ): Promise<void> {
    const allowed = actor.roleAssignments.some((assignment) => {
      const reaches =
        assignment.scopeType === 'platform' ||
        (assignment.scopeType === 'tenant' && tenantId !== null && assignment.scopeId === tenantId);
      return reaches && ASSIGNABLE_ROLES_BY_ROLE[assignment.role].includes(role);
    });

    if (!allowed) {
      throw new AppError('permission_denied', {
        code: 'role_not_assignable',
        messageKey: 'admin.role_not_assignable',
        messageParams: { role },
        internalMessage: `User ${actor.userId} may not assign ${role} at ${scopeType} in tenant ${tenantId}.`,
      });
    }
  }

  private async assertSubjectInScope(
    subjectType: SubjectType,
    subjectId: string,
    scopeType: ScopeType,
    tenantId: string | null,
  ): Promise<void> {
    if (scopeType === 'platform') {
      // Groups are tenant-bound, so a platform role goes to a person.
      if (subjectType !== 'user') {
        throw new AppError('validation_failed', {
          code: 'platform_role_needs_user',
          messageKey: 'admin.platform_role_needs_user',
        });
      }
      return;
    }

    const found =
      subjectType === 'group'
        ? await this.deps.db
            .select({ id: groups.id })
            .from(groups)
            .where(and(eq(groups.id, subjectId), eq(groups.tenantId, tenantId!)))
            .limit(1)
        : await this.deps.db
            .select({ id: tenantMemberships.id })
            .from(tenantMemberships)
            .where(
              and(
                eq(tenantMemberships.userId, subjectId),
                eq(tenantMemberships.tenantId, tenantId!),
              ),
            )
            .limit(1);

    if (found.length === 0) {
      throw new AppError('not_found', {
        code: 'subject_not_in_tenant',
        messageKey: 'access.subject_not_found',
        internalMessage: `${subjectType} ${subjectId} is not in tenant ${tenantId}.`,
      });
    }
  }

  /** The tenant a scope belongs to, read from the database; null for the platform. */
  private async tenantOfScope(scopeType: ScopeType, scopeId: string): Promise<string | null> {
    if (scopeType === 'platform') return null;

    const [row] =
      scopeType === 'tenant'
        ? await this.deps.db
            .select({ tenantId: tenants.id })
            .from(tenants)
            .where(eq(tenants.id, scopeId))
            .limit(1)
        : await this.deps.db
            .select({ tenantId: projects.tenantId })
            .from(projects)
            .where(eq(projects.id, scopeId))
            .limit(1);

    if (!row) {
      throw new AppError('not_found', {
        code: 'scope_not_found',
        messageKey: 'admin.scope_not_found',
        internalMessage: `${scopeType} ${scopeId} does not exist.`,
      });
    }
    return row.tenantId;
  }

  private async countHolders(
    role: SystemRole,
    scopeType: ScopeType,
    scopeId: string,
    excludingId: string,
  ): Promise<number> {
    const rows = await this.deps.db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.role, role),
          eq(roleAssignments.scopeType, scopeType),
          eq(roleAssignments.scopeId, scopeId),
        ),
      );
    return rows.filter((row) => row.id !== excludingId).length;
  }

  private async present(
    tenantId: string,
    rows: readonly (typeof roleAssignments.$inferSelect)[],
    groupNames: ReadonlyMap<string, string>,
  ): Promise<RoleAssignmentView[]> {
    const [tenant] = await this.deps.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const projectIds = rows.filter((row) => row.scopeType === 'project').map((row) => row.scopeId);
    const projectNames = new Map(
      projectIds.length > 0
        ? (
            await this.deps.db
              .select({ id: projects.id, name: projects.name })
              .from(projects)
              .where(inArray(projects.id, projectIds))
          ).map((row) => [row.id, row.name])
        : [],
    );

    const userIds = rows.filter((row) => row.subjectType === 'user').map((row) => row.subjectId);
    const groupIds = rows.filter((row) => row.subjectType === 'group').map((row) => row.subjectId);
    const subjectNames = new Map<string, string>([
      ...(userIds.length > 0
        ? (
            await this.deps.db
              .select({ id: users.id, first: users.firstName, last: users.lastName })
              .from(users)
              .where(inArray(users.id, userIds))
          ).map((row) => [row.id, `${row.first} ${row.last}`.trim()] as [string, string])
        : []),
      ...(groupIds.length > 0
        ? (
            await this.deps.db
              .select({ id: groups.id, name: groups.name })
              .from(groups)
              .where(inArray(groups.id, groupIds))
          ).map((row) => [row.id, row.name] as [string, string])
        : []),
    ]);

    return rows.map((row) => ({
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      subjectLabel: subjectNames.get(row.subjectId) ?? '—',
      role: row.role,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      scopeLabel:
        row.scopeType === 'platform'
          ? 'Plattform'
          : row.scopeType === 'tenant'
            ? row.scopeId === tenantId
              ? (tenant?.name ?? '—')
              : '—'
            : (projectNames.get(row.scopeId) ?? '—'),
      ...(row.subjectType === 'group' && groupNames.has(row.subjectId)
        ? { viaGroup: { id: row.subjectId, name: groupNames.get(row.subjectId)! } }
        : {}),
    }));
  }
}

export type { RoleAssignmentView };
