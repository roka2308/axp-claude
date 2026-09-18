import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, asUserId } from '@axp/contracts';
import { hours, minutes } from '@axp/core';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

async function createActiveUser(ctx: TestContext, email = 'user@example.invalid') {
  const { userId } = await ctx.container.users.createLocalUser({
    email,
    firstName: 'Vera',
    lastName: 'Viewer',
    password: STRONG_TEST_PASSWORD,
    status: 'active',
  });
  return userId;
}

describe('local authentication', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('signs in with correct credentials and issues a session', async () => {
    const userId = await createActiveUser(ctx);
    const result = await ctx.container.auth.login({
      email: 'USER@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });

    expect(result.userId).toBe(userId);
    const validation = await ctx.container.auth.validateSession(result.token);
    expect(validation?.context.userId).toBe(userId);
    expect(validation?.recentlyAuthenticated).toBe(true);
  });

  it('gives the same generic error for a wrong password and an unknown account', async () => {
    await createActiveUser(ctx);

    const wrongPassword = await ctx.container.auth
      .login({ email: 'user@example.invalid', password: 'falsch-aber-lang-genug' })
      .catch((error: unknown) => error);
    const unknownAccount = await ctx.container.auth
      .login({ email: 'niemand@example.invalid', password: STRONG_TEST_PASSWORD })
      .catch((error: unknown) => error);

    // Non-enumerating: the response must not distinguish the two cases.
    expect(AppError.isAppError(wrongPassword)).toBe(true);
    expect(AppError.isAppError(unknownAccount)).toBe(true);
    expect((wrongPassword as AppError).code).toBe((unknownAccount as AppError).code);
    expect((wrongPassword as AppError).messageKey).toBe((unknownAccount as AppError).messageKey);
  });

  it('refuses a deactivated account without revealing that it exists', async () => {
    const userId = await createActiveUser(ctx);
    await ctx.container.users.deactivate(userId);

    await expect(
      ctx.container.auth.login({
        email: 'user@example.invalid',
        password: STRONG_TEST_PASSWORD,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'invalid_credentials',
    );
  });

  it('locks the account temporarily after repeated failures', async () => {
    await createActiveUser(ctx);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await ctx.container.auth
        .login({ email: 'user@example.invalid', password: 'falsch-aber-lang-genug' })
        .catch(() => undefined);
    }

    // Even the correct password is refused while the lock holds.
    await expect(
      ctx.container.auth.login({
        email: 'user@example.invalid',
        password: STRONG_TEST_PASSWORD,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'temporarily_locked',
    );

    ctx.clock.advance(minutes(20));
    const result = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });
    expect(result.token).toBeTruthy();
  });

  it('expires a session when the absolute lifetime is reached', async () => {
    await createActiveUser(ctx);
    const result = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });

    ctx.clock.advance(hours(13));
    expect(await ctx.container.auth.validateSession(result.token)).toBeNull();
  });

  it('expires a session after the idle timeout even within the absolute lifetime', async () => {
    await createActiveUser(ctx);
    const result = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });

    ctx.clock.advance(minutes(61));
    expect(await ctx.container.auth.validateSession(result.token)).toBeNull();
  });

  it('closes the re-authentication window while the session stays valid', async () => {
    await createActiveUser(ctx);
    const result = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });

    ctx.clock.advance(minutes(20));
    const validation = await ctx.container.auth.validateSession(result.token);
    expect(validation).not.toBeNull();
    // Sensitive actions must ask for the password again after this point.
    expect(validation?.recentlyAuthenticated).toBe(false);
  });

  it('revokes sessions immediately on logout', async () => {
    await createActiveUser(ctx);
    const result = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });

    await ctx.container.auth.logout(result.token);
    expect(await ctx.container.auth.validateSession(result.token)).toBeNull();
  });

  it('invalidates live sessions when the user is deactivated', async () => {
    const userId = await createActiveUser(ctx);
    const result = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });

    await ctx.container.users.deactivate(userId);
    // Deactivation takes effect on the next request, not at the next expiry.
    expect(await ctx.container.auth.validateSession(result.token)).toBeNull();
  });

  it('revokes every session of a user on demand', async () => {
    const userId = await createActiveUser(ctx);
    const first = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });
    const second = await ctx.container.auth.login({
      email: 'user@example.invalid',
      password: STRONG_TEST_PASSWORD,
    });

    const revoked = await ctx.container.auth.revokeAllSessionsForUser(
      asUserId(userId),
      'password_changed',
    );
    expect(revoked).toBe(2);
    expect(await ctx.container.auth.validateSession(first.token)).toBeNull();
    expect(await ctx.container.auth.validateSession(second.token)).toBeNull();
  });

  it('rejects an unknown or malformed session token', async () => {
    expect(await ctx.container.auth.validateSession('')).toBeNull();
    expect(await ctx.container.auth.validateSession('not-a-real-token')).toBeNull();
  });
});

describe('password change', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('requires the current password for self-service changes', async () => {
    const userId = await createActiveUser(ctx);

    await expect(
      ctx.container.users.changePassword({
        userId,
        currentPassword: 'falsches-altes-passwort',
        newPassword: `${STRONG_TEST_PASSWORD}-neu`,
        requireCurrent: true,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'current_password_invalid',
    );
  });

  it('refuses to reuse a password from the history', async () => {
    const userId = await createActiveUser(ctx);

    await ctx.container.users.changePassword({
      userId,
      currentPassword: STRONG_TEST_PASSWORD,
      newPassword: `${STRONG_TEST_PASSWORD}-zwei`,
      requireCurrent: true,
    });

    await expect(
      ctx.container.users.changePassword({
        userId,
        currentPassword: `${STRONG_TEST_PASSWORD}-zwei`,
        newPassword: STRONG_TEST_PASSWORD,
        requireCurrent: true,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.code === 'password_reused',
    );
  });
});
