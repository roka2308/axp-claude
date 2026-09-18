import { eq, inArray, or, and } from 'drizzle-orm';
import {
  type AuthContext,
  type GroupId,
  type ProjectId,
  type RoleAssignment,
  type RoleAssignmentId,
  type SystemRole,
  type TenantId,
  type UserId,
  type ScopeType,
} from '@axp/contracts';
import { type Database, groupMembers, projects, roleAssignments, users } from '@axp/db';

/**
 * Resolves everything the authorization layer needs about a caller, server-side.
 *
 * Tenant and project ids are derived here from database rows - never taken from
 * the browser (Shared Contract §4). Group memberships are folded in because
 * role assignments may target a group rather than a user.
 */
export async function resolveAuthContext(
  db: Database,
  userId: UserId,
  authenticatedAt: Date,
): Promise<AuthContext | null> {
  const [user] = await db
    .select({
      id: users.id,
      status: users.status,
      locale: users.locale,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.status !== 'active') return null;

  const groupRows = await db
    .select({ groupId: groupMembers.groupId })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  const groupIds = groupRows.map((row) => row.groupId as GroupId);

  const subjectFilter =
    groupIds.length > 0
      ? or(
          and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, userId)),
          and(
            eq(roleAssignments.subjectType, 'group'),
            inArray(roleAssignments.subjectId, groupIds),
          ),
        )
      : and(eq(roleAssignments.subjectType, 'user'), eq(roleAssignments.subjectId, userId));

  const assignmentRows = await db.select().from(roleAssignments).where(subjectFilter);

  const assignments: RoleAssignment[] = assignmentRows.map((row) => ({
    id: row.id as RoleAssignmentId,
    subjectType: row.subjectType,
    subjectId: row.subjectId as UserId | GroupId,
    role: row.role as SystemRole,
    scopeType: row.scopeType as ScopeType,
    scopeId: row.scopeId,
  }));

  const tenantIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.scopeType === 'tenant') tenantIds.add(assignment.scopeId);
    if (assignment.scopeType === 'project') projectIds.add(assignment.scopeId);
  }

  // A project-scoped assignment also puts its owning tenant in reach. The
  // mapping is read from the database rather than inferred, so a stale or
  // forged project id cannot widen the caller's tenant set.
  if (projectIds.size > 0) {
    const owningTenants = await db
      .select({ tenantId: projects.tenantId })
      .from(projects)
      .where(inArray(projects.id, [...projectIds]));
    for (const row of owningTenants) tenantIds.add(row.tenantId);
  }

  return {
    userId: user.id as UserId,
    status: user.status,
    locale: user.locale,
    roleAssignments: assignments,
    groupIds,
    tenantIds: [...tenantIds] as TenantId[],
    projectIds: [...projectIds] as ProjectId[],
    authenticatedAt,
  };
}
