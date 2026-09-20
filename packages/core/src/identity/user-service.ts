import { and, eq } from 'drizzle-orm';
import { AppError, type Locale, type SystemRole, type ScopeType } from '@axp/contracts';
import {
  authIdentities,
  type Database,
  newId,
  passwordHistory,
  roleAssignments,
  users,
} from '@axp/db';
import type { Clock } from '../clock';
import { hashPassword, normalizeEmail, verifyPassword } from '../crypto';
import { assertPasswordAllowed, DEFAULT_PASSWORD_POLICY } from './password-policy';
import type { AuditService } from '../audit/audit-service';

export interface UserServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
}

export interface CreateLocalUserInput {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly locale?: Locale;
  /**
   * Optional initial password. Omitted for invited users, who set their own
   * password through the invite flow - the product ships no default passwords.
   */
  readonly password?: string;
  readonly status?: 'invited' | 'active';
  readonly mustChangePassword?: boolean;
  readonly actorUserId?: string;
}

export class UserService {
  constructor(private readonly deps: UserServiceDeps) {}

  async createLocalUser(input: CreateLocalUserInput): Promise<{ userId: string }> {
    const email = normalizeEmail(input.email);
    const now = this.deps.clock.now();

    const [existing] = await this.deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailNormalized, email))
      .limit(1);

    if (existing) {
      throw new AppError('conflict', {
        code: 'email_already_used',
        messageKey: 'user.email_already_used',
        fieldErrors: { email: 'user.email_already_used' },
        internalMessage: `A user with ${email} already exists.`,
      });
    }

    if (input.password) {
      assertPasswordAllowed(input.password, {
        email,
        firstName: input.firstName,
        lastName: input.lastName,
      });
    }

    const userId = newId();
    const passwordHash = input.password ? await hashPassword(input.password) : null;

    await this.deps.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: input.email.trim(),
        emailNormalized: email,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        status: input.status ?? 'invited',
        locale: input.locale ?? 'de',
      });

      await tx.insert(authIdentities).values({
        id: newId(),
        userId,
        providerType: 'local',
        providerSubject: email,
        passwordHash,
        passwordUpdatedAt: passwordHash ? now : null,
        mustChangePassword: input.mustChangePassword ? 1 : 0,
        managedAttributes: [],
      });

      if (passwordHash) {
        await tx.insert(passwordHistory).values({ id: newId(), userId, passwordHash });
      }
    });

    await this.deps.audit.success('user.invited', {
      actorUserId: input.actorUserId ?? null,
      targetType: 'user',
      targetId: userId,
      metadata: { status: input.status ?? 'invited' },
    });

    return { userId };
  }

  /**
   * Changes a local password.
   *
   * Enforces the history rule (§6) and leaves session revocation to the caller,
   * which knows whether the change was self-service or administrative.
   */
  async changePassword(params: {
    userId: string;
    currentPassword?: string;
    newPassword: string;
    requireCurrent: boolean;
    actorUserId?: string;
  }): Promise<void> {
    const now = this.deps.clock.now();

    const [identity] = await this.deps.db
      .select({
        id: authIdentities.id,
        passwordHash: authIdentities.passwordHash,
        email: users.emailNormalized,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(authIdentities)
      .innerJoin(users, eq(users.id, authIdentities.userId))
      .where(
        and(eq(authIdentities.userId, params.userId), eq(authIdentities.providerType, 'local')),
      )
      .limit(1);

    if (!identity) {
      throw new AppError('not_found', {
        code: 'local_identity_not_found',
        internalMessage: `User ${params.userId} has no local authentication identity.`,
      });
    }

    if (params.requireCurrent) {
      const ok =
        identity.passwordHash !== null &&
        params.currentPassword !== undefined &&
        (await verifyPassword(identity.passwordHash, params.currentPassword));
      if (!ok) {
        throw new AppError('authentication_required', {
          code: 'current_password_invalid',
          messageKey: 'auth.current_password_invalid',
          fieldErrors: { currentPassword: 'auth.current_password_invalid' },
          internalMessage: 'Password change rejected: current password did not verify.',
        });
      }
    }

    assertPasswordAllowed(params.newPassword, {
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
    });

    const history = await this.deps.db
      .select({ passwordHash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, params.userId))
      .orderBy(passwordHistory.createdAt)
      .limit(DEFAULT_PASSWORD_POLICY.historySize);

    for (const entry of history) {
      if (await verifyPassword(entry.passwordHash, params.newPassword)) {
        throw new AppError('validation_failed', {
          code: 'password_reused',
          messageKey: 'password.reused',
          fieldErrors: { newPassword: 'password.reused' },
          internalMessage: 'Password change rejected: value found in password history.',
        });
      }
    }

    const newHash = await hashPassword(params.newPassword);

    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(authIdentities)
        .set({ passwordHash: newHash, passwordUpdatedAt: now, mustChangePassword: 0 })
        .where(eq(authIdentities.id, identity.id));
      await tx
        .insert(passwordHistory)
        .values({ id: newId(), userId: params.userId, passwordHash: newHash });
    });

    await this.deps.audit.success('auth.password.changed', {
      actorUserId: params.actorUserId ?? params.userId,
      targetType: 'user',
      targetId: params.userId,
      metadata: { selfService: params.requireCurrent },
    });
  }

  /**
   * Whether a local account already has this exact password.
   *
   * Used by idempotent provisioning (the demo fixture) so re-running does not
   * try to "change" a password to the value it already holds - which the
   * history rule would correctly refuse. Internal domain API only: there is no
   * route that exposes it.
   */
  async passwordMatches(userId: string, candidate: string): Promise<boolean> {
    const [identity] = await this.deps.db
      .select({ passwordHash: authIdentities.passwordHash })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, userId), eq(authIdentities.providerType, 'local')))
      .limit(1);

    if (!identity?.passwordHash) return false;
    return verifyPassword(identity.passwordHash, candidate);
  }

  async deactivate(userId: string, actorUserId?: string): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db
      .update(users)
      .set({ status: 'deactivated', deactivatedAt: now })
      .where(eq(users.id, userId));
    await this.deps.audit.success('user.deactivated', {
      actorUserId: actorUserId ?? null,
      targetType: 'user',
      targetId: userId,
    });
  }

  async activate(userId: string, actorUserId?: string): Promise<void> {
    await this.deps.db
      .update(users)
      .set({ status: 'active', deactivatedAt: null })
      .where(eq(users.id, userId));
    await this.deps.audit.success('user.activated', {
      actorUserId: actorUserId ?? null,
      targetType: 'user',
      targetId: userId,
    });
  }

  async findByEmail(email: string) {
    const [row] = await this.deps.db
      .select()
      .from(users)
      .where(eq(users.emailNormalized, normalizeEmail(email)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Creates a scoped role assignment.
   *
   * Callers must have checked that the actor may hand out this role
   * (`ASSIGNABLE_ROLES_BY_ROLE`); this method only persists the decision.
   */
  async assignRole(params: {
    subjectType: 'user' | 'group';
    subjectId: string;
    role: SystemRole;
    scopeType: ScopeType;
    scopeId: string;
    actorUserId?: string;
    tenantId?: string;
  }): Promise<void> {
    const [existing] = await this.deps.db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.subjectType, params.subjectType),
          eq(roleAssignments.subjectId, params.subjectId),
          eq(roleAssignments.role, params.role),
          eq(roleAssignments.scopeType, params.scopeType),
          eq(roleAssignments.scopeId, params.scopeId),
        ),
      )
      .limit(1);
    if (existing) return;

    await this.deps.db.insert(roleAssignments).values({
      id: newId(),
      subjectType: params.subjectType,
      subjectId: params.subjectId,
      role: params.role,
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      grantedByUserId: params.actorUserId ?? null,
    });

    await this.deps.audit.success('role_assignment.created', {
      actorUserId: params.actorUserId ?? null,
      tenantId: params.tenantId ?? null,
      targetType: params.subjectType,
      targetId: params.subjectId,
      metadata: { role: params.role, scopeType: params.scopeType, scopeId: params.scopeId },
    });
  }
}
