import type { GroupSummary, GroupMember } from '@axp/contracts';
import { and, count, eq, inArray } from 'drizzle-orm';
import { AppError } from '@axp/contracts';
import {
  type Database,
  groupMembers,
  groups,
  newId,
  objectGrants,
  roleAssignments,
  tenantMemberships,
  users,
} from '@axp/db';
import type { AuditService } from '../audit/audit-service';

export interface GroupServiceDeps {
  readonly db: Database;
  readonly audit: AuditService;
}

/**
 * Groups (Master Spec §7, D5).
 *
 * "Gruppen sind der bevorzugte Skalierungsweg; Direct Grants für Ausnahmen."
 * A group holds role assignments and object grants like a user does, and its
 * members hold them through it - which is what the explanation chain shows as
 * User -> Group -> Rolle -> Scope.
 *
 * Groups belong to exactly one tenant, and so do their members: a group cannot
 * be a way to reach into another tenant.
 */
export class GroupService {
  constructor(private readonly deps: GroupServiceDeps) {}

  async list(tenantId: string): Promise<GroupSummary[]> {
    const rows = await this.deps.db
      .select({
        id: groups.id,
        name: groups.name,
        description: groups.description,
        memberCount: count(groupMembers.id),
      })
      .from(groups)
      .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
      .where(eq(groups.tenantId, tenantId))
      .groupBy(groups.id, groups.name, groups.description);

    return rows
      .map((row) => ({ ...row, memberCount: Number(row.memberCount) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async get(tenantId: string, groupId: string) {
    const group = await this.require(tenantId, groupId);
    const members = await this.members(groupId);
    return { ...group, members };
  }

  async members(groupId: string): Promise<GroupMember[]> {
    const rows = await this.deps.db
      .select({
        userId: users.id,
        first: users.firstName,
        last: users.lastName,
        email: users.email,
        status: users.status,
      })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(eq(groupMembers.groupId, groupId));

    return rows
      .map((row) => ({
        userId: row.userId,
        name: `${row.first} ${row.last}`.trim(),
        email: row.email,
        status: row.status,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** The groups a user belongs to within one tenant. */
  async groupsOfUser(tenantId: string, userId: string) {
    return this.deps.db
      .select({ id: groups.id, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.tenantId, tenantId)));
  }

  async create(input: {
    tenantId: string;
    name: string;
    description?: string;
    actorUserId: string;
  }): Promise<{ groupId: string }> {
    await this.assertNameFree(input.tenantId, input.name);

    const groupId = newId();
    await this.deps.db.insert(groups).values({
      id: groupId,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description ?? null,
    });

    await this.deps.audit.success('group.created', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetType: 'group',
      targetId: groupId,
      metadata: { name: input.name },
    });
    return { groupId };
  }

  async update(input: {
    tenantId: string;
    groupId: string;
    name: string;
    description?: string | null;
    actorUserId: string;
  }): Promise<void> {
    const group = await this.require(input.tenantId, input.groupId);
    if (group.name !== input.name) await this.assertNameFree(input.tenantId, input.name);

    await this.deps.db
      .update(groups)
      .set({ name: input.name, description: input.description ?? null })
      .where(eq(groups.id, input.groupId));

    await this.deps.audit.success('group.updated', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetType: 'group',
      targetId: input.groupId,
      metadata: { from: group.name, to: input.name },
    });
  }

  /**
   * Deletes a group and everything it held.
   *
   * Its role assignments and grants go with it - they are keyed by subject id
   * rather than by a foreign key, so they are removed explicitly here instead of
   * lingering as assignments to a group that no longer exists. What that takes
   * away from its members is what the impact preview shows beforehand.
   */
  async delete(input: { tenantId: string; groupId: string; actorUserId: string }): Promise<void> {
    const group = await this.require(input.tenantId, input.groupId);

    await this.deps.db.transaction(async (tx) => {
      await tx
        .delete(roleAssignments)
        .where(
          and(eq(roleAssignments.subjectType, 'group'), eq(roleAssignments.subjectId, group.id)),
        );
      await tx
        .delete(objectGrants)
        .where(and(eq(objectGrants.subjectType, 'group'), eq(objectGrants.subjectId, group.id)));
      await tx.delete(groups).where(eq(groups.id, group.id));
    });

    await this.deps.audit.success('group.deleted', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetType: 'group',
      targetId: group.id,
      metadata: { name: group.name },
    });
  }

  async addMember(input: {
    tenantId: string;
    groupId: string;
    userId: string;
    actorUserId: string;
  }): Promise<void> {
    await this.require(input.tenantId, input.groupId);
    await this.requireTenantMember(input.tenantId, input.userId);

    const [existing] = await this.deps.db
      .select({ id: groupMembers.id })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)))
      .limit(1);
    if (existing) return;

    await this.deps.db
      .insert(groupMembers)
      .values({ id: newId(), groupId: input.groupId, userId: input.userId });

    await this.deps.audit.success('group.membership.changed', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetType: 'group',
      targetId: input.groupId,
      metadata: { change: 'added', userId: input.userId },
    });
  }

  async removeMember(input: {
    tenantId: string;
    groupId: string;
    userId: string;
    actorUserId: string;
  }): Promise<void> {
    await this.require(input.tenantId, input.groupId);

    await this.deps.db
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)));

    await this.deps.audit.success('group.membership.changed', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetType: 'group',
      targetId: input.groupId,
      metadata: { change: 'removed', userId: input.userId },
    });
  }

  /** Group ids of a tenant among a set, for checks that must stay in-tenant. */
  async idsInTenant(tenantId: string, groupIds: readonly string[]): Promise<Set<string>> {
    if (groupIds.length === 0) return new Set();
    const rows = await this.deps.db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.tenantId, tenantId), inArray(groups.id, [...groupIds])));
    return new Set(rows.map((row) => row.id));
  }

  async require(tenantId: string, groupId: string) {
    const [group] = await this.deps.db
      .select()
      .from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.tenantId, tenantId)))
      .limit(1);

    if (!group) {
      throw new AppError('not_found', {
        code: 'group_not_found',
        messageKey: 'admin.group_not_found',
        internalMessage: `Group ${groupId} is not in tenant ${tenantId}.`,
      });
    }
    return group;
  }

  private async requireTenantMember(tenantId: string, userId: string) {
    const [membership] = await this.deps.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)))
      .limit(1);

    if (!membership) {
      throw new AppError('not_found', {
        code: 'user_not_in_tenant',
        messageKey: 'admin.user_not_found',
        internalMessage: `User ${userId} is not a member of tenant ${tenantId}.`,
      });
    }
  }

  private async assertNameFree(tenantId: string, name: string) {
    const [clash] = await this.deps.db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.tenantId, tenantId), eq(groups.name, name)))
      .limit(1);

    if (clash) {
      throw new AppError('conflict', {
        code: 'group_name_taken',
        messageKey: 'admin.group_name_taken',
        messageParams: { name },
        internalMessage: `A group named "${name}" already exists in tenant ${tenantId}.`,
      });
    }
  }
}

export type { GroupSummary, GroupMember };
