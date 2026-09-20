import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { AppError, type AuthContext, asUserId, type UserId } from '@axp/contracts';
import {
  affectedRows,
  authIdentities,
  type Database,
  loginAttempts,
  newId,
  sessions,
  users,
} from '@axp/db';
import type { Logger } from '@axp/observability';
import { addMs, type Clock, hours, minutes } from '../clock';
import {
  generateSecretToken,
  hashPassword,
  hashToken,
  normalizeEmail,
  verifyPassword,
} from '../crypto';
import type { AuditService } from '../audit/audit-service';
import { resolveAuthContext } from '../access/auth-context';

export interface SessionPolicy {
  readonly idleTimeoutMinutes: number;
  readonly absoluteLifetimeHours: number;
  readonly reauthWindowMinutes: number;
}

/**
 * Graduated brute-force protection (Master Spec §6).
 *
 * Failures are counted per account and per client address. After the threshold
 * the subject is locked for a doubling interval, capped. Responses stay generic
 * either way so the lock itself does not become an account oracle.
 */
export interface BruteForcePolicy {
  readonly failureThreshold: number;
  readonly baseLockMinutes: number;
  readonly maxLockMinutes: number;
  /** Failure counters older than this are forgotten. */
  readonly windowMinutes: number;
}

export const DEFAULT_BRUTE_FORCE_POLICY: BruteForcePolicy = {
  failureThreshold: 5,
  baseLockMinutes: 1,
  maxLockMinutes: 15,
  windowMinutes: 30,
};

export interface AuthServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit: AuditService;
  readonly sessionPolicy: SessionPolicy;
  readonly bruteForcePolicy?: BruteForcePolicy;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface LoginResult {
  /** Opaque session token for the cookie. Stored only as a hash. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly userId: UserId;
  readonly mustChangePassword: boolean;
}

export interface SessionValidation {
  readonly context: AuthContext;
  readonly sessionId: string;
  /** True while the caller is inside the re-authentication window. */
  readonly recentlyAuthenticated: boolean;
}

export class AuthService {
  private readonly bruteForce: BruteForcePolicy;

  constructor(private readonly deps: AuthServiceDeps) {
    this.bruteForce = deps.bruteForcePolicy ?? DEFAULT_BRUTE_FORCE_POLICY;
  }

  /**
   * Local password login.
   *
   * Every failure path returns the same generic error and takes a comparable
   * amount of work: unknown account, wrong password and deactivated account
   * must not be distinguishable from outside (§6, "non-enumerating").
   */
  async login(input: LoginInput): Promise<LoginResult> {
    const now = this.deps.clock.now();
    const email = normalizeEmail(input.email);
    const subjects = [`email:${email}`, ...(input.ipAddress ? [`ip:${input.ipAddress}`] : [])];

    await this.assertNotLockedOut(subjects, now);

    const [row] = await this.deps.db
      .select({
        userId: users.id,
        status: users.status,
        firstName: users.firstName,
        lastName: users.lastName,
        passwordHash: authIdentities.passwordHash,
        mustChangePassword: authIdentities.mustChangePassword,
      })
      .from(users)
      .innerJoin(
        authIdentities,
        and(eq(authIdentities.userId, users.id), eq(authIdentities.providerType, 'local')),
      )
      .where(eq(users.emailNormalized, email))
      .limit(1);

    // Verify against a dummy hash when the account does not exist so the
    // response time does not reveal whether the address is known.
    const passwordMatches = await verifyPassword(
      row?.passwordHash ?? (await getDummyHash()),
      input.password,
    );

    if (!row || !row.passwordHash || !passwordMatches || row.status !== 'active') {
      await this.registerFailure(subjects, now);
      await this.deps.audit.failure('auth.login.failed', {
        actorUserId: row?.userId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        metadata: {
          reason: !row ? 'unknown_account' : !passwordMatches ? 'bad_password' : 'inactive_account',
        },
      });
      throw invalidCredentials();
    }

    await this.clearFailures(subjects);

    const { token, expiresAt } = await this.createSession({
      userId: asUserId(row.userId),
      now,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    await this.deps.db.update(users).set({ lastLoginAt: now }).where(eq(users.id, row.userId));

    await this.deps.audit.success('auth.login.succeeded', {
      actorUserId: row.userId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    return {
      token,
      expiresAt,
      userId: asUserId(row.userId),
      mustChangePassword: row.mustChangePassword === 1,
    };
  }

  private async createSession(params: {
    userId: UserId;
    now: Date;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
    const token = generateSecretToken(32);
    const sessionId = newId();
    const absoluteExpiresAt = addMs(
      params.now,
      hours(this.deps.sessionPolicy.absoluteLifetimeHours),
    );
    const idleExpiresAt = addMs(params.now, minutes(this.deps.sessionPolicy.idleTimeoutMinutes));

    await this.deps.db.insert(sessions).values({
      id: sessionId,
      userId: params.userId,
      tokenHash: hashToken(token),
      authenticatedAt: params.now,
      lastSeenAt: params.now,
      absoluteExpiresAt,
      idleExpiresAt,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent?.slice(0, 255) ?? null,
    });

    const expiresAt = absoluteExpiresAt < idleExpiresAt ? absoluteExpiresAt : idleExpiresAt;
    return { token, expiresAt, sessionId };
  }

  /**
   * Validates a session token and resolves the caller.
   *
   * Sliding idle expiry is refreshed on use; the absolute lifetime is not, so a
   * session cannot be kept alive indefinitely by activity alone.
   */
  async validateSession(token: string): Promise<SessionValidation | null> {
    if (!token) return null;
    const now = this.deps.clock.now();

    const [row] = await this.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1);

    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.absoluteExpiresAt <= now || row.idleExpiresAt <= now) return null;

    const context = await resolveAuthContext(
      this.deps.db,
      asUserId(row.userId),
      row.authenticatedAt,
    );
    // The user was deactivated while the session was alive: revoke it now.
    if (!context) {
      await this.revokeSessionById(row.id, 'user_inactive');
      return null;
    }

    const nextIdleExpiry = addMs(now, minutes(this.deps.sessionPolicy.idleTimeoutMinutes));
    // Throttle the write: refreshing on every request would make each read a write.
    if (nextIdleExpiry.getTime() - row.idleExpiresAt.getTime() > 60_000) {
      await this.deps.db
        .update(sessions)
        .set({ lastSeenAt: now, idleExpiresAt: nextIdleExpiry })
        .where(eq(sessions.id, row.id));
    }

    const reauthDeadline = addMs(
      row.authenticatedAt,
      minutes(this.deps.sessionPolicy.reauthWindowMinutes),
    );

    return {
      context,
      sessionId: row.id,
      recentlyAuthenticated: now < reauthDeadline,
    };
  }

  async logout(token: string, actorUserId?: string): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db
      .update(sessions)
      .set({ revokedAt: now, revokedReason: 'logout' })
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
    await this.deps.audit.success('auth.logout', { actorUserId: actorUserId ?? null });
  }

  private async revokeSessionById(sessionId: string, reason: string): Promise<void> {
    await this.deps.db
      .update(sessions)
      .set({ revokedAt: this.deps.clock.now(), revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  /**
   * Revokes every active session of a user.
   *
   * Called on deactivation, password change and recovery so access stops
   * immediately rather than at the next expiry (§6).
   */
  async revokeAllSessionsForUser(userId: UserId, reason: string): Promise<number> {
    const now = this.deps.clock.now();
    const result = await this.deps.db
      .update(sessions)
      .set({ revokedAt: now, revokedReason: reason.slice(0, 64) })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));

    const affected = affectedRows(result);
    await this.deps.audit.success('auth.session.revoked', {
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      metadata: { reason, revokedCount: affected },
    });
    return affected;
  }

  /** Housekeeping: drops sessions that can no longer be used. */
  async purgeExpiredSessions(): Promise<number> {
    const now = this.deps.clock.now();
    const result = await this.deps.db
      .delete(sessions)
      .where(
        or(
          lt(sessions.absoluteExpiresAt, now),
          lt(sessions.idleExpiresAt, now),
          sql`${sessions.revokedAt} IS NOT NULL AND ${sessions.revokedAt} < ${addMs(now, -hours(24))}`,
        ),
      );
    return affectedRows(result);
  }

  private async assertNotLockedOut(subjectKeys: readonly string[], now: Date): Promise<void> {
    for (const subjectKey of subjectKeys) {
      const [row] = await this.deps.db
        .select({ lockedUntil: loginAttempts.lockedUntil })
        .from(loginAttempts)
        .where(eq(loginAttempts.subjectKey, subjectKey))
        .limit(1);

      if (row?.lockedUntil && row.lockedUntil > now) {
        throw new AppError('rate_limited', {
          code: 'temporarily_locked',
          messageKey: 'auth.temporarily_locked',
          messageParams: { retryAfterSeconds: Math.ceil((+row.lockedUntil - +now) / 1000) },
          internalMessage: `Login refused: ${subjectKey} is locked until ${row.lockedUntil.toISOString()}.`,
        });
      }
    }
  }

  private async registerFailure(subjectKeys: readonly string[], now: Date): Promise<void> {
    const windowStart = addMs(now, -minutes(this.bruteForce.windowMinutes));

    for (const subjectKey of subjectKeys) {
      const [existing] = await this.deps.db
        .select()
        .from(loginAttempts)
        .where(eq(loginAttempts.subjectKey, subjectKey))
        .limit(1);

      const stale = !existing || existing.lastFailedAt < windowStart;
      const failedCount = stale ? 1 : existing.failedCount + 1;
      const lockedUntil =
        failedCount >= this.bruteForce.failureThreshold
          ? addMs(now, minutes(this.lockMinutesFor(failedCount)))
          : null;

      if (!existing) {
        await this.deps.db.insert(loginAttempts).values({
          id: newId(),
          subjectKey,
          failedCount,
          firstFailedAt: now,
          lastFailedAt: now,
          lockedUntil,
        });
      } else {
        await this.deps.db
          .update(loginAttempts)
          .set({
            failedCount,
            firstFailedAt: stale ? now : existing.firstFailedAt,
            lastFailedAt: now,
            lockedUntil,
          })
          .where(eq(loginAttempts.subjectKey, subjectKey));
      }
    }
  }

  /** Doubling backoff from the threshold upwards, capped by policy. */
  private lockMinutesFor(failedCount: number): number {
    const overshoot = failedCount - this.bruteForce.failureThreshold;
    const minutesToLock = this.bruteForce.baseLockMinutes * 2 ** Math.max(0, overshoot);
    return Math.min(minutesToLock, this.bruteForce.maxLockMinutes);
  }

  private async clearFailures(subjectKeys: readonly string[]): Promise<void> {
    for (const subjectKey of subjectKeys) {
      await this.deps.db.delete(loginAttempts).where(eq(loginAttempts.subjectKey, subjectKey));
    }
  }
}

function invalidCredentials(): AppError {
  return new AppError('authentication_required', {
    code: 'invalid_credentials',
    messageKey: 'auth.invalid_credentials',
    internalMessage: 'Login failed (generic response - see audit trail for the actual reason).',
  });
}

/**
 * A real Argon2id hash over a random value, used to equalise response time for
 * unknown accounts: verifying against it always fails, but costs the same as a
 * genuine check. Computed once, lazily, so process start stays fast.
 */
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(generateSecretToken(24));
  return dummyHashPromise;
}
