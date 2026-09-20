import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppError } from '@axp/contracts';
import { auditEvents, authIdentities, bootstrapTokens, roleAssignments, users } from '@axp/db';
import { hours } from '@axp/core';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * Gate F0: "first admin can be bootstrapped once without default credentials"
 * and "second bootstrap attempt is rejected" (Gap Review G4).
 */
describe('secure initial bootstrap', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('starts uninitialized with no accounts at all', async () => {
    expect(await ctx.container.bootstrap.getInitState()).toBe('uninitialized');
    const rows = await ctx.container.db.select({ id: users.id }).from(users);
    expect(rows).toHaveLength(0);
  });

  it('creates the first platform admin from a one-time token', async () => {
    const issued = await ctx.container.bootstrap.issueInitialBootstrapToken('operator');
    const { userId } = await ctx.container.bootstrap.completeInitialBootstrap({
      token: issued.token,
      email: 'Admin@Example.Invalid',
      firstName: 'Petra',
      lastName: 'Plattform',
      password: STRONG_TEST_PASSWORD,
    });

    expect(await ctx.container.bootstrap.getInitState()).toBe('initialized');

    const [assignment] = await ctx.container.db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.subjectId, userId));
    expect(assignment).toMatchObject({
      role: 'platform_admin',
      scopeType: 'platform',
      scopeId: '',
    });

    const [user] = await ctx.container.db.select().from(users).where(eq(users.id, userId));
    expect(user?.status).toBe('active');
    // Email is stored as typed but matched case-insensitively.
    expect(user?.email).toBe('Admin@Example.Invalid');
    expect(user?.emailNormalized).toBe('admin@example.invalid');
  });

  it('never stores the token or the password in readable form', async () => {
    const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();
    await ctx.container.bootstrap.completeInitialBootstrap({
      token: issued.token,
      email: 'admin@example.invalid',
      firstName: 'Petra',
      lastName: 'Plattform',
      password: STRONG_TEST_PASSWORD,
    });

    const [tokenRow] = await ctx.container.db.select().from(bootstrapTokens);
    expect(tokenRow?.tokenHash).not.toBe(issued.token);
    expect(tokenRow?.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const [identity] = await ctx.container.db.select().from(authIdentities);
    expect(identity?.passwordHash).not.toContain(STRONG_TEST_PASSWORD);
    expect(identity?.passwordHash?.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects a second bootstrap attempt and keeps the setup path closed', async () => {
    const first = await ctx.container.bootstrap.issueInitialBootstrapToken();
    await ctx.container.bootstrap.completeInitialBootstrap({
      token: first.token,
      email: 'admin@example.invalid',
      firstName: 'Petra',
      lastName: 'Plattform',
      password: STRONG_TEST_PASSWORD,
    });

    // The consumed token cannot be replayed.
    await expect(
      ctx.container.bootstrap.completeInitialBootstrap({
        token: first.token,
        email: 'second@example.invalid',
        firstName: 'Second',
        lastName: 'Admin',
        password: STRONG_TEST_PASSWORD,
      }),
    ).rejects.toSatisfy((error: unknown) => AppError.isAppError(error));

    // And no new token can be minted either.
    await expect(ctx.container.bootstrap.issueInitialBootstrapToken()).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'already_initialized',
    );

    const allUsers = await ctx.container.db.select({ id: users.id }).from(users);
    expect(allUsers).toHaveLength(1);
  });

  it('refuses an expired token', async () => {
    const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();
    ctx.clock.advance(hours(2));

    expect(await ctx.container.bootstrap.isTokenUsable(issued.token)).toBe(false);
    await expect(
      ctx.container.bootstrap.completeInitialBootstrap({
        token: issued.token,
        email: 'admin@example.invalid',
        firstName: 'Petra',
        lastName: 'Plattform',
        password: STRONG_TEST_PASSWORD,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'invalid_bootstrap_token',
    );
    expect(await ctx.container.bootstrap.getInitState()).toBe('uninitialized');
  });

  it('invalidates a previous token when a new one is minted', async () => {
    const first = await ctx.container.bootstrap.issueInitialBootstrapToken();
    const second = await ctx.container.bootstrap.issueInitialBootstrapToken();

    expect(await ctx.container.bootstrap.isTokenUsable(first.token)).toBe(false);
    expect(await ctx.container.bootstrap.isTokenUsable(second.token)).toBe(true);
  });

  it('refuses a password that violates the policy before touching the database', async () => {
    const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();
    await expect(
      ctx.container.bootstrap.completeInitialBootstrap({
        token: issued.token,
        email: 'admin@example.invalid',
        firstName: 'Petra',
        lastName: 'Plattform',
        password: 'kurz',
      }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'password_policy',
    );

    expect(await ctx.container.bootstrap.getInitState()).toBe('uninitialized');
    // The token survives so the operator can retry with a valid password.
    expect(await ctx.container.bootstrap.isTokenUsable(issued.token)).toBe(true);
  });

  it('audits the bootstrap without recording the token or the password', async () => {
    const issued = await ctx.container.bootstrap.issueInitialBootstrapToken('operator');
    await ctx.container.bootstrap.completeInitialBootstrap({
      token: issued.token,
      email: 'admin@example.invalid',
      firstName: 'Petra',
      lastName: 'Plattform',
      password: STRONG_TEST_PASSWORD,
    });

    const events = await ctx.container.db.select().from(auditEvents);
    const actions = events.map((event) => event.action);
    expect(actions).toContain('platform.bootstrap.started');
    expect(actions).toContain('platform.bootstrap.completed');

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(issued.token);
    expect(serialised).not.toContain(STRONG_TEST_PASSWORD);
  });
});

/** Break-glass recovery is a separate, audited path - never a second setup. */
describe('break-glass recovery', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('is unavailable before the platform is initialized', async () => {
    await expect(ctx.container.bootstrap.issueRecoveryToken()).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'not_initialized',
    );
  });

  it('restores platform admin access and revokes existing sessions', async () => {
    const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();
    await ctx.container.bootstrap.completeInitialBootstrap({
      token: issued.token,
      email: 'admin@example.invalid',
      firstName: 'Petra',
      lastName: 'Plattform',
      password: STRONG_TEST_PASSWORD,
    });

    const session = await ctx.container.auth.login({
      email: 'admin@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });
    expect(await ctx.container.auth.validateSession(session.token)).not.toBeNull();

    const recovery = await ctx.container.bootstrap.issueRecoveryToken('on-call');
    await ctx.container.bootstrap.completeRecovery({
      token: recovery.token,
      email: 'admin@example.invalid',
      firstName: 'Petra',
      lastName: 'Plattform',
      password: `${STRONG_TEST_PASSWORD}-neu`,
    });

    // The old session is gone; recovery must not be usable from a stolen one.
    expect(await ctx.container.auth.validateSession(session.token)).toBeNull();

    const reauthenticated = await ctx.container.auth.login({
      email: 'admin@example.invalid',
      password: `${STRONG_TEST_PASSWORD}-neu`,
    });
    expect(reauthenticated.userId).toBeTruthy();

    const events = await ctx.container.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toContain('platform.recovery.completed');
  });

  it('does not accept a recovery token on the setup path', async () => {
    const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();
    await ctx.container.bootstrap.completeInitialBootstrap({
      token: issued.token,
      email: 'admin@example.invalid',
      firstName: 'Petra',
      lastName: 'Plattform',
      password: STRONG_TEST_PASSWORD,
    });

    const recovery = await ctx.container.bootstrap.issueRecoveryToken();
    // Purposes are not interchangeable.
    expect(await ctx.container.bootstrap.isTokenUsable(recovery.token, 'initial_bootstrap')).toBe(
      false,
    );
    expect(
      await ctx.container.bootstrap.isTokenUsable(recovery.token, 'break_glass_recovery'),
    ).toBe(true);
  });
});
