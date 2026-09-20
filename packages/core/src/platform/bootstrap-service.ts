import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { AppError, type PlatformInitState } from '@axp/contracts';
import {
  affectedRows,
  authIdentities,
  bootstrapTokens,
  type Database,
  newId,
  passwordHistory,
  PLATFORM_STATE_ID,
  platformState,
  roleAssignments,
  sessions,
  users,
} from '@axp/db';
import type { Logger } from '@axp/observability';
import { addMs, type Clock, minutes } from '../clock';
import { generateSecretToken, hashPassword, hashToken, normalizeEmail } from '../crypto';
import { assertPasswordAllowed } from '../identity/password-policy';
import type { AuditService } from '../audit/audit-service';

export type BootstrapPurpose = 'initial_bootstrap' | 'break_glass_recovery';

export interface BootstrapServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly tokenTtlMinutes: number;
}

export interface IssuedBootstrapToken {
  /** Plaintext token. Returned exactly once and never stored or logged. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly purpose: BootstrapPurpose;
}

export interface CompleteBootstrapInput {
  readonly token: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly password: string;
  readonly locale?: 'de' | 'en';
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface CompleteBootstrapResult {
  readonly userId: string;
}

/**
 * Secure initial bootstrap (Master Spec §6, Gap Review G4).
 *
 * Invariants enforced here:
 *   - no default accounts and no default passwords exist anywhere;
 *   - the first platform admin is created only by presenting a short-lived,
 *     single-use token minted by a privileged local process;
 *   - once initialized, the setup path stays closed. A platform instance with
 *     zero platform admins does not reopen it, because that would be a trivial
 *     takeover path; break-glass recovery is the separate, audited route.
 */
export class BootstrapService {
  constructor(private readonly deps: BootstrapServiceDeps) {}

  /** Reads the singleton state row, creating it on first contact. */
  async getInitState(): Promise<PlatformInitState> {
    const row = await this.readStateRow();
    return row.initState;
  }

  private async readStateRow() {
    const [existing] = await this.deps.db
      .select()
      .from(platformState)
      .where(eq(platformState.id, PLATFORM_STATE_ID))
      .limit(1);
    if (existing) return existing;

    // Insert-if-absent. A concurrently starting process may win the race;
    // ignore the duplicate and re-read rather than failing a health check.
    await this.deps.db
      .insert(platformState)
      .values({ id: PLATFORM_STATE_ID, initState: 'uninitialized' })
      .onDuplicateKeyUpdate({ set: { id: PLATFORM_STATE_ID } });

    const [created] = await this.deps.db
      .select()
      .from(platformState)
      .where(eq(platformState.id, PLATFORM_STATE_ID))
      .limit(1);
    if (!created) {
      throw new AppError('internal_error', {
        code: 'platform_state_unavailable',
        internalMessage: 'platform_state singleton row could not be created or read.',
      });
    }
    return created;
  }

  /**
   * Mints a one-time activation token for the initial bootstrap.
   *
   * Any previously issued, unconsumed initial-bootstrap token is invalidated
   * first: re-running the command must not leave several valid tokens alive.
   */
  async issueInitialBootstrapToken(requestedBy?: string): Promise<IssuedBootstrapToken> {
    const state = await this.readStateRow();
    if (state.initState === 'initialized') {
      await this.deps.audit.failure('platform.bootstrap.rejected', {
        targetType: 'platform',
        metadata: { reason: 'already_initialized' },
      });
      throw new AppError('conflict', {
        code: 'already_initialized',
        messageKey: 'bootstrap.already_initialized',
        internalMessage: 'Refused to issue a bootstrap token: platform is already initialized.',
      });
    }
    return this.mintToken('initial_bootstrap', requestedBy);
  }

  /**
   * Mints a break-glass recovery token.
   *
   * Separate purpose, separate audit action, and usable only on an already
   * initialized platform: it is a recovery path, not a second setup path.
   */
  async issueRecoveryToken(requestedBy?: string): Promise<IssuedBootstrapToken> {
    const state = await this.readStateRow();
    if (state.initState !== 'initialized') {
      throw new AppError('conflict', {
        code: 'not_initialized',
        messageKey: 'bootstrap.not_initialized',
        internalMessage: 'Break-glass recovery requires an initialized platform.',
      });
    }
    return this.mintToken('break_glass_recovery', requestedBy);
  }

  private async mintToken(
    purpose: BootstrapPurpose,
    requestedBy?: string,
  ): Promise<IssuedBootstrapToken> {
    const now = this.deps.clock.now();
    const token = generateSecretToken(32);
    const expiresAt = addMs(now, minutes(this.deps.tokenTtlMinutes));

    await this.deps.db
      .update(bootstrapTokens)
      .set({ consumedAt: now })
      .where(and(eq(bootstrapTokens.purpose, purpose), isNull(bootstrapTokens.consumedAt)));

    await this.deps.db.insert(bootstrapTokens).values({
      id: newId(),
      purpose,
      tokenHash: hashToken(token),
      expiresAt,
      requestedBy: requestedBy?.slice(0, 255) ?? null,
    });

    await this.deps.audit.success(
      purpose === 'initial_bootstrap' ? 'platform.bootstrap.started' : 'platform.recovery.started',
      { targetType: 'platform', metadata: { requestedBy: requestedBy ?? null } },
    );

    return { token, expiresAt, purpose };
  }

  /**
   * True when the token is currently usable. Lets the setup page decide whether
   * to show the form at all, before asking anyone for a password.
   */
  async isTokenUsable(
    token: string,
    purpose: BootstrapPurpose = 'initial_bootstrap',
  ): Promise<boolean> {
    const now = this.deps.clock.now();
    const [row] = await this.deps.db
      .select({ id: bootstrapTokens.id })
      .from(bootstrapTokens)
      .where(
        and(
          eq(bootstrapTokens.tokenHash, hashToken(token)),
          eq(bootstrapTokens.purpose, purpose),
          isNull(bootstrapTokens.consumedAt),
          gt(bootstrapTokens.expiresAt, now),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * Creates the first platform admin and closes the setup path.
   *
   * Runs as one transaction that re-reads the state row `FOR UPDATE`, so two
   * concurrent submissions cannot both succeed: the second finds the platform
   * initialized and is rejected.
   */
  async completeInitialBootstrap(input: CompleteBootstrapInput): Promise<CompleteBootstrapResult> {
    const now = this.deps.clock.now();
    const email = normalizeEmail(input.email);

    assertPasswordAllowed(input.password, {
      email,
      firstName: input.firstName,
      lastName: input.lastName,
    });

    const passwordHash = await hashPassword(input.password);
    const userId = newId();

    try {
      await this.deps.db.transaction(async (tx) => {
        const [state] = await tx
          .select()
          .from(platformState)
          .where(eq(platformState.id, PLATFORM_STATE_ID))
          .for('update')
          .limit(1);

        if (!state || state.initState === 'initialized') {
          throw new AppError('conflict', {
            code: 'already_initialized',
            messageKey: 'bootstrap.already_initialized',
            internalMessage: 'Bootstrap rejected inside transaction: platform already initialized.',
          });
        }

        const [tokenRow] = await tx
          .select()
          .from(bootstrapTokens)
          .where(
            and(
              eq(bootstrapTokens.tokenHash, hashToken(input.token)),
              eq(bootstrapTokens.purpose, 'initial_bootstrap'),
              isNull(bootstrapTokens.consumedAt),
              gt(bootstrapTokens.expiresAt, now),
            ),
          )
          .for('update')
          .limit(1);

        if (!tokenRow) {
          throw new AppError('permission_denied', {
            code: 'invalid_bootstrap_token',
            messageKey: 'bootstrap.invalid_token',
            internalMessage: 'Bootstrap token missing, expired or already consumed.',
          });
        }

        await tx.insert(users).values({
          id: userId,
          email: input.email.trim(),
          emailNormalized: email,
          emailVerifiedAt: now,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          status: 'active',
          locale: input.locale ?? 'de',
        });

        await tx.insert(authIdentities).values({
          id: newId(),
          userId,
          providerType: 'local',
          providerSubject: email,
          passwordHash,
          passwordUpdatedAt: now,
          mustChangePassword: 0,
          managedAttributes: [],
        });

        await tx.insert(passwordHistory).values({ id: newId(), userId, passwordHash });

        await tx.insert(roleAssignments).values({
          id: newId(),
          subjectType: 'user',
          subjectId: userId,
          role: 'platform_admin',
          scopeType: 'platform',
          scopeId: '',
        });

        await tx
          .update(bootstrapTokens)
          .set({ consumedAt: now, consumedByUserId: userId })
          .where(eq(bootstrapTokens.id, tokenRow.id));

        await tx
          .update(platformState)
          .set({ initState: 'initialized', initializedAt: now, initializedByUserId: userId })
          .where(eq(platformState.id, PLATFORM_STATE_ID));
      });
    } catch (error) {
      await this.deps.audit.failure('platform.bootstrap.rejected', {
        targetType: 'platform',
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        metadata: { reason: AppError.isAppError(error) ? error.code : 'unexpected' },
      });
      throw error;
    }

    await this.deps.audit.success('platform.bootstrap.completed', {
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    this.deps.logger.info({ userId }, 'Platform initialized with first platform admin');
    return { userId };
  }

  /**
   * Break-glass recovery (Gap Review G4).
   *
   * Deliberately separate from the setup path: it works only on an initialized
   * platform, uses its own token purpose, and is audited under its own action.
   * An existing account is re-activated and elevated; otherwise a new platform
   * admin is created. Either way every existing session of that account is
   * revoked, so a recovery cannot be piggybacked on a stolen session.
   */
  async completeRecovery(input: CompleteBootstrapInput): Promise<CompleteBootstrapResult> {
    const now = this.deps.clock.now();
    const email = normalizeEmail(input.email);

    assertPasswordAllowed(input.password, {
      email,
      firstName: input.firstName,
      lastName: input.lastName,
    });

    const passwordHash = await hashPassword(input.password);
    let userId = '';

    try {
      await this.deps.db.transaction(async (tx) => {
        const [tokenRow] = await tx
          .select()
          .from(bootstrapTokens)
          .where(
            and(
              eq(bootstrapTokens.tokenHash, hashToken(input.token)),
              eq(bootstrapTokens.purpose, 'break_glass_recovery'),
              isNull(bootstrapTokens.consumedAt),
              gt(bootstrapTokens.expiresAt, now),
            ),
          )
          .for('update')
          .limit(1);

        if (!tokenRow) {
          throw new AppError('permission_denied', {
            code: 'invalid_recovery_token',
            messageKey: 'bootstrap.invalid_token',
            internalMessage: 'Recovery token missing, expired or already consumed.',
          });
        }

        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.emailNormalized, email))
          .limit(1);

        if (existing) {
          userId = existing.id;
          await tx
            .update(users)
            .set({ status: 'active', deactivatedAt: null, emailVerifiedAt: now })
            .where(eq(users.id, userId));

          const [identity] = await tx
            .select({ id: authIdentities.id })
            .from(authIdentities)
            .where(and(eq(authIdentities.userId, userId), eq(authIdentities.providerType, 'local')))
            .limit(1);

          if (identity) {
            await tx
              .update(authIdentities)
              .set({ passwordHash, passwordUpdatedAt: now, mustChangePassword: 0 })
              .where(eq(authIdentities.id, identity.id));
          } else {
            await tx.insert(authIdentities).values({
              id: newId(),
              userId,
              providerType: 'local',
              providerSubject: email,
              passwordHash,
              passwordUpdatedAt: now,
              mustChangePassword: 0,
              managedAttributes: [],
            });
          }

          await tx
            .update(sessions)
            .set({ revokedAt: now, revokedReason: 'break_glass_recovery' })
            .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
        } else {
          userId = newId();
          await tx.insert(users).values({
            id: userId,
            email: input.email.trim(),
            emailNormalized: email,
            emailVerifiedAt: now,
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
            status: 'active',
            locale: input.locale ?? 'de',
          });
          await tx.insert(authIdentities).values({
            id: newId(),
            userId,
            providerType: 'local',
            providerSubject: email,
            passwordHash,
            passwordUpdatedAt: now,
            mustChangePassword: 0,
            managedAttributes: [],
          });
        }

        await tx.insert(passwordHistory).values({ id: newId(), userId, passwordHash });

        await tx
          .insert(roleAssignments)
          .values({
            id: newId(),
            subjectType: 'user',
            subjectId: userId,
            role: 'platform_admin',
            scopeType: 'platform',
            scopeId: '',
          })
          .onDuplicateKeyUpdate({ set: { scopeId: '' } });

        await tx
          .update(bootstrapTokens)
          .set({ consumedAt: now, consumedByUserId: userId })
          .where(eq(bootstrapTokens.id, tokenRow.id));
      });
    } catch (error) {
      await this.deps.audit.failure('platform.recovery.completed', {
        targetType: 'platform',
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        metadata: { reason: AppError.isAppError(error) ? error.code : 'unexpected' },
      });
      throw error;
    }

    await this.deps.audit.success('platform.recovery.completed', {
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    this.deps.logger.warn({ userId }, 'Break-glass recovery completed: platform admin restored');
    return { userId };
  }

  /** Removes consumed and expired tokens. Runs as a worker maintenance task. */
  async purgeExpiredTokens(): Promise<number> {
    const now = this.deps.clock.now();
    const result = await this.deps.db
      .delete(bootstrapTokens)
      .where(
        sql`${bootstrapTokens.expiresAt} < ${now} OR ${bootstrapTokens.consumedAt} IS NOT NULL`,
      );
    return affectedRows(result);
  }
}
