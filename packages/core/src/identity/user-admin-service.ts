import type { ProfileField, UserListEntry, UserDetail } from '@axp/contracts';
import { PROFILE_FIELDS } from '@axp/contracts';
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { AppError, type AuthContext, type Locale } from '@axp/contracts';
import {
  authIdentities,
  type Database,
  groupMembers,
  groups,
  newId,
  roleAssignments,
  sessions,
  tenantMemberships,
  userInvitations,
  users,
} from '@axp/db';
import type { Clock } from '../clock';
import type { AuditService } from '../audit/audit-service';
import { generateSecretToken, hashToken, normalizeEmail } from '../crypto';
import type { UserService } from './user-service';

export interface UserAdminServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly users: UserService;
  readonly revokeAllSessions: (userId: string, reason: string) => Promise<number>;
  /** How long an invitation link stays usable. */
  readonly invitationTtlHours: number;
}

/**
 * User administration within a tenant (D5).
 *
 * "User Detail ist eine echte editierbare Seite, keine tote Card." Every method
 * is scoped to a tenant the caller administers, and every user it touches must
 * be a member of that tenant: an id from another tenant is answered as if it
 * did not exist.
 *
 * Deactivation replaces deletion in normal administration (§6). It stops the
 * account at once - status and every live session - and keeps its rows, so
 * reactivation restores exactly what it had.
 */
export class UserAdminService {
  constructor(private readonly deps: UserAdminServiceDeps) {}

  async list(tenantId: string, filter: { query?: string } = {}): Promise<UserListEntry[]> {
    const rows = await this.deps.db
      .select({
        id: users.id,
        first: users.firstName,
        last: users.lastName,
        email: users.email,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        provider: authIdentities.providerType,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .leftJoin(authIdentities, eq(authIdentities.userId, users.id))
      .where(eq(tenantMemberships.tenantId, tenantId));

    const userIds = [...new Set(rows.map((row) => row.id))];
    const groupRows =
      userIds.length > 0
        ? await this.deps.db
            .select({ userId: groupMembers.userId, groupId: groups.id, name: groups.name })
            .from(groupMembers)
            .innerJoin(groups, eq(groups.id, groupMembers.groupId))
            .where(and(inArray(groupMembers.userId, userIds), eq(groups.tenantId, tenantId)))
        : [];
    const directRoles =
      userIds.length > 0
        ? await this.deps.db
            .select({ userId: roleAssignments.subjectId, role: roleAssignments.role })
            .from(roleAssignments)
            .where(
              and(
                eq(roleAssignments.subjectType, 'user'),
                inArray(roleAssignments.subjectId, userIds),
              ),
            )
        : [];
    const groupIds = [...new Set(groupRows.map((row) => row.groupId))];
    const groupRoles =
      groupIds.length > 0
        ? await this.deps.db
            .select({ groupId: roleAssignments.subjectId, role: roleAssignments.role })
            .from(roleAssignments)
            .where(
              and(
                eq(roleAssignments.subjectType, 'group'),
                inArray(roleAssignments.subjectId, groupIds),
              ),
            )
        : [];

    const query = normalise(filter.query ?? '');
    const seen = new Set<string>();

    return rows
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .map((row) => {
        const memberOf = groupRows.filter((entry) => entry.userId === row.id);
        const roles = new Set([
          ...directRoles.filter((entry) => entry.userId === row.id).map((entry) => entry.role),
          ...groupRoles
            .filter((entry) => memberOf.some((group) => group.groupId === entry.groupId))
            .map((entry) => entry.role),
        ]);
        return {
          id: row.id,
          name: `${row.first} ${row.last}`.trim(),
          email: row.email,
          status: row.status,
          provider: row.provider ?? 'local',
          lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
          groups: memberOf.map((group) => group.name).sort((a, b) => a.localeCompare(b, 'de')),
          roles: [...roles].sort(),
        } satisfies UserListEntry;
      })
      .filter(
        (entry) =>
          !query || normalise(entry.name).includes(query) || normalise(entry.email).includes(query),
      )
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  async detail(tenantId: string, userId: string): Promise<UserDetail> {
    await this.requireMember(tenantId, userId);
    const now = this.deps.clock.now();

    const [row] = await this.deps.db
      .select({
        user: users,
        provider: authIdentities.providerType,
        managed: authIdentities.managedAttributes,
      })
      .from(users)
      .leftJoin(authIdentities, eq(authIdentities.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);

    const live = await this.deps.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          gt(sessions.absoluteExpiresAt, now),
          gt(sessions.idleExpiresAt, now),
        ),
      );

    const [invitation] = await this.deps.db
      .select({ expiresAt: userInvitations.expiresAt })
      .from(userInvitations)
      .where(
        and(
          eq(userInvitations.userId, userId),
          isNull(userInvitations.usedAt),
          gt(userInvitations.expiresAt, now),
        ),
      )
      .orderBy(desc(userInvitations.createdAt))
      .limit(1);

    const memberOf = await this.deps.db
      .select({ id: groups.id, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.tenantId, tenantId)));

    const user = row!.user;
    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      locale: user.locale,
      status: user.status,
      provider: row!.provider ?? 'local',
      managedAttributes: ((row!.managed ?? []) as string[]).filter((field): field is ProfileField =>
        (PROFILE_FIELDS as readonly string[]).includes(field),
      ),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
      activeSessions: live.length,
      pendingInvitation: invitation ? { expiresAt: invitation.expiresAt.toISOString() } : null,
      groups: memberOf.sort((a, b) => a.name.localeCompare(b.name, 'de')),
    };
  }

  /**
   * Edits profile fields.
   *
   * A field the identity provider owns is refused, not silently ignored: the
   * next sign-in would overwrite it anyway, and an administrator who thinks
   * they changed a name should learn that they did not (§12).
   */
  async updateProfile(input: {
    tenantId?: string;
    userId: string;
    changes: Partial<Record<Exclude<ProfileField, 'email'>, string>>;
    actorUserId: string;
  }): Promise<void> {
    if (input.tenantId) await this.requireMember(input.tenantId, input.userId);

    const [identity] = await this.deps.db
      .select({ managed: authIdentities.managedAttributes })
      .from(authIdentities)
      .where(eq(authIdentities.userId, input.userId))
      .limit(1);
    const managed = new Set((identity?.managed ?? []) as string[]);

    const touched = Object.keys(input.changes).filter(
      (field) => input.changes[field as keyof typeof input.changes] !== undefined,
    );
    const blocked = touched.filter((field) => managed.has(field));
    if (blocked.length > 0) {
      throw new AppError('validation_failed', {
        code: 'attribute_managed_by_idp',
        messageKey: 'admin.attribute_managed_by_idp',
        fieldErrors: Object.fromEntries(
          blocked.map((field) => [field, 'admin.attribute_managed_by_idp']),
        ),
      });
    }

    const set: Partial<typeof users.$inferInsert> = {};
    if (input.changes.firstName !== undefined) set.firstName = input.changes.firstName.trim();
    if (input.changes.lastName !== undefined) set.lastName = input.changes.lastName.trim();
    if (input.changes.locale !== undefined) set.locale = input.changes.locale as Locale;
    if (Object.keys(set).length === 0) return;

    await this.deps.db.update(users).set(set).where(eq(users.id, input.userId));
    await this.deps.audit.success('user.updated', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId ?? null,
      targetType: 'user',
      targetId: input.userId,
      // Field names only: the values are personal data and do not belong in
      // an audit trail that many people can read.
      metadata: { fields: touched },
    });
  }

  /**
   * Invites a person into a tenant.
   *
   * A new person gets an `invited` account with no password and a single-use
   * invitation link; they choose their own password when they accept. Someone
   * who already has an account simply becomes a member - there is nothing for
   * them to accept.
   *
   * The token is returned once and never stored in the clear. Until the
   * product can send mail (DEV-005), the administrator passes it on.
   */
  async invite(input: {
    tenantId: string;
    email: string;
    firstName: string;
    lastName: string;
    locale?: Locale;
    actorUserId: string;
  }): Promise<{ userId: string; invitation: { token: string; expiresAt: string } | null }> {
    const existing = await this.deps.users.findByEmail(input.email);

    if (existing) {
      await this.addMembership(input.tenantId, existing.id, input.actorUserId);
      return { userId: existing.id, invitation: null };
    }

    const { userId } = await this.deps.users.createLocalUser({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      locale: input.locale ?? 'de',
      status: 'invited',
      actorUserId: input.actorUserId,
    });
    await this.addMembership(input.tenantId, userId, input.actorUserId);

    return {
      userId,
      invitation: await this.issueInvitation(input.tenantId, userId, input.actorUserId),
    };
  }

  /** A fresh link for an invitation that expired or was lost. The old one stops working. */
  async reissueInvitation(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
  }): Promise<{ token: string; expiresAt: string }> {
    await this.requireMember(input.tenantId, input.userId);
    const [user] = await this.deps.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);

    if (user?.status !== 'invited') {
      throw new AppError('conflict', {
        code: 'not_invited',
        messageKey: 'admin.user_not_invited',
      });
    }
    return this.issueInvitation(input.tenantId, input.userId, input.actorUserId);
  }

  /** What the acceptance page may show before a password is chosen. */
  async inspectInvitation(token: string): Promise<{ email: string; firstName: string } | null> {
    const row = await this.findUsableInvitation(token);
    if (!row) return null;
    const [user] = await this.deps.db
      .select({ email: users.email, firstName: users.firstName })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    return user ?? null;
  }

  async acceptInvitation(input: { token: string; password: string }): Promise<{ email: string }> {
    const invitation = await this.findUsableInvitation(input.token);
    if (!invitation) {
      throw new AppError('validation_failed', {
        code: 'invitation_invalid',
        messageKey: 'admin.invitation_invalid',
      });
    }

    await this.deps.users.changePassword({
      userId: invitation.userId,
      newPassword: input.password,
      requireCurrent: false,
      actorUserId: invitation.userId,
    });

    const now = this.deps.clock.now();
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(userInvitations)
        .set({ usedAt: now })
        .where(eq(userInvitations.id, invitation.id));
      // Following the link proves control of the address it was sent to.
      await tx
        .update(users)
        .set({ status: 'active', emailVerifiedAt: now })
        .where(eq(users.id, invitation.userId));
    });

    await this.deps.audit.success('user.invitation.accepted', {
      actorUserId: invitation.userId,
      tenantId: invitation.tenantId,
      targetType: 'user',
      targetId: invitation.userId,
    });

    const [user] = await this.deps.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, invitation.userId))
      .limit(1);
    return { email: user!.email };
  }

  /**
   * Deactivates an account and ends its sessions at once.
   *
   * Refused when it would reach further than the actor's authority: their own
   * account (a locked-out administrator is a support call), a platform admin
   * (outside a tenant admin's reach), or a person who also belongs to another
   * tenant (the status is global, so it would lock them out there too).
   */
  async deactivate(input: {
    tenantId: string;
    userId: string;
    actor: AuthContext;
  }): Promise<{ revokedSessions: number }> {
    await this.requireMember(input.tenantId, input.userId);
    await this.assertMayChangeStatus(input.tenantId, input.userId, input.actor);

    await this.deps.users.deactivate(input.userId, input.actor.userId, input.tenantId);
    const revokedSessions = await this.deps.revokeAllSessions(input.userId, 'deactivated');
    return { revokedSessions };
  }

  async reactivate(input: { tenantId: string; userId: string; actor: AuthContext }): Promise<void> {
    await this.requireMember(input.tenantId, input.userId);
    await this.assertMayChangeStatus(input.tenantId, input.userId, input.actor);
    await this.deps.users.activate(input.userId, input.actor.userId, input.tenantId);
  }

  async revokeSessions(input: {
    tenantId: string;
    userId: string;
    actorUserId: string;
  }): Promise<{ revokedSessions: number }> {
    await this.requireMember(input.tenantId, input.userId);
    const revokedSessions = await this.deps.revokeAllSessions(
      input.userId,
      `admin:${input.actorUserId}`,
    );
    return { revokedSessions };
  }

  async addMembership(tenantId: string, userId: string, actorUserId?: string): Promise<void> {
    const [existing] = await this.deps.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)))
      .limit(1);
    if (existing) return;

    await this.deps.db.insert(tenantMemberships).values({ id: newId(), tenantId, userId });
    await this.deps.audit.success('user.updated', {
      actorUserId: actorUserId ?? null,
      tenantId,
      targetType: 'user',
      targetId: userId,
      metadata: { membership: 'added' },
    });
  }

  async requireMember(tenantId: string, userId: string): Promise<void> {
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

  // --- internals -------------------------------------------------------------

  private async issueInvitation(tenantId: string, userId: string, actorUserId: string) {
    const token = generateSecretToken();
    const expiresAt = new Date(
      this.deps.clock.now().getTime() + this.deps.invitationTtlHours * 3_600_000,
    );

    await this.deps.db.transaction(async (tx) => {
      // One live invitation per person: a new link retires the old one.
      await tx
        .update(userInvitations)
        .set({ usedAt: this.deps.clock.now() })
        .where(and(eq(userInvitations.userId, userId), isNull(userInvitations.usedAt)));
      await tx.insert(userInvitations).values({
        id: newId(),
        userId,
        tenantId,
        tokenHash: hashToken(token),
        expiresAt,
        createdByUserId: actorUserId,
      });
    });

    await this.deps.audit.success('user.invited', {
      actorUserId,
      tenantId,
      targetType: 'user',
      targetId: userId,
      metadata: { invitation: 'issued' },
    });

    return { token, expiresAt: expiresAt.toISOString() };
  }

  private async findUsableInvitation(token: string) {
    if (!token) return null;
    const [row] = await this.deps.db
      .select()
      .from(userInvitations)
      .where(
        and(
          eq(userInvitations.tokenHash, hashToken(token)),
          isNull(userInvitations.usedAt),
          gt(userInvitations.expiresAt, this.deps.clock.now()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async assertMayChangeStatus(
    tenantId: string,
    userId: string,
    actor: AuthContext,
  ): Promise<void> {
    const refuse = (code: string, messageKey: string) => {
      throw new AppError('permission_denied', { code, messageKey });
    };

    if (userId === actor.userId)
      refuse('cannot_change_own_status', 'admin.cannot_change_own_status');

    const actorIsPlatformAdmin = actor.roleAssignments.some(
      (assignment) => assignment.role === 'platform_admin',
    );
    if (actorIsPlatformAdmin) return;

    const [platformRole] = await this.deps.db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.subjectType, 'user'),
          eq(roleAssignments.subjectId, userId),
          eq(roleAssignments.role, 'platform_admin'),
        ),
      )
      .limit(1);
    if (platformRole) refuse('target_is_platform_admin', 'admin.target_is_platform_admin');

    const [elsewhere] = await this.deps.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.userId, userId), ne(tenantMemberships.tenantId, tenantId)))
      .limit(1);
    if (elsewhere) refuse('user_in_other_tenants', 'admin.user_in_other_tenants');
  }
}

function normalise(text: string): string {
  return normalizeEmail(text)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '');
}

export type { ProfileField, UserListEntry, UserDetail };
export { PROFILE_FIELDS };
