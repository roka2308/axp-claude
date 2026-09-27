import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { AppError } from '@axp/contracts';
import { authIdentities, tenants, users } from '@axp/db';
import { type Container, PROFILE_FIELDS, type ProfileField } from '@axp/core';
import { requireAuth } from '../plugins/authentication';

/**
 * Self service (D5 "Mein Profil"), re-authentication and invitations.
 *
 * A person edits the fields they own. Fields an identity provider owns are
 * shown as "Durch Identity Provider verwaltet" and refused on write. Changing
 * the e-mail address of a local account needs a verification mail, which the
 * product cannot send yet (DEV-005) - so it is shown, explained, and not
 * offered.
 */
export function registerSelfServiceRoutes(app: FastifyInstance, container: Container): void {
  const guard = { onRequest: [app.authenticate] };

  /** Confirms the password again, opening the re-auth window for this session. */
  app.post(
    '/auth/reauthenticate',
    { ...guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireAuth(request);
      const { password } = z.object({ password: z.string().min(1).max(1024) }).parse(request.body);
      if (!request.sessionId) {
        throw new AppError('authentication_required', { code: 'missing_session' });
      }

      await container.auth.reauthenticate({
        sessionId: request.sessionId,
        userId: auth.userId,
        password,
      });
      return { ok: true };
    },
  );

  app.get('/me/profile', guard, async (request) => {
    const auth = requireAuth(request);
    const [row] = await container.db
      .select({
        user: users,
        provider: authIdentities.providerType,
        managed: authIdentities.managedAttributes,
      })
      .from(users)
      .leftJoin(authIdentities, eq(authIdentities.userId, users.id))
      .where(eq(users.id, auth.userId))
      .limit(1);

    const user = row!.user;
    return {
      profile: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        locale: user.locale,
        provider: row!.provider ?? 'local',
        managedAttributes: ((row!.managed ?? []) as string[]).filter(
          (field): field is ProfileField => (PROFILE_FIELDS as readonly string[]).includes(field),
        ),
        emailVerified: user.emailVerifiedAt !== null,
      },
      recentlyAuthenticated: request.recentlyAuthenticated ?? false,
    };
  });

  app.patch('/me/profile', guard, async (request) => {
    const auth = requireAuth(request);
    const changes = z
      .object({
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        locale: z.enum(['de', 'en']).optional(),
      })
      .strict()
      .parse(request.body);

    await container.userAdmin.updateProfile({
      userId: auth.userId,
      changes,
      actorUserId: auth.userId,
    });
    return { ok: true };
  });

  /**
   * Changes the caller's own password, then ends every session - this one
   * included. A password change that left an old session alive would not
   * protect against whoever prompted it (§6).
   */
  app.post(
    '/me/password',
    { ...guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireAuth(request);
      const input = z
        .object({
          currentPassword: z.string().min(1).max(1024),
          newPassword: z.string().min(1).max(1024),
        })
        .parse(request.body);

      await container.users.changePassword({
        userId: auth.userId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        requireCurrent: true,
        actorUserId: auth.userId,
      });
      await container.auth.revokeAllSessionsForUser(auth.userId, 'password_changed');
      return { ok: true, signedOut: true };
    },
  );

  /** "Was darf ich, wo, und warum?" - the caller's own effective access, per tenant. */
  app.get('/me/access', guard, async (request) => {
    const auth = requireAuth(request);
    const result = [];
    for (const tenantId of auth.tenantIds) {
      const [tenant] = await container.db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      result.push({
        tenantId,
        tenantName: tenant?.name ?? '—',
        effective: await container.effectiveAccess.explainUser(tenantId, auth.userId),
      });
    }
    return { tenants: result };
  });

  // --- invitations (public) ------------------------------------------------

  app.get(
    '/invitations/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.params);
      const invitation = await container.userAdmin.inspectInvitation(token);
      if (!invitation) {
        throw new AppError('not_found', {
          code: 'invitation_invalid',
          messageKey: 'admin.invitation_invalid',
        });
      }
      return invitation;
    },
  );

  app.post(
    '/invitations/accept',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const input = z
        .object({ token: z.string().min(10).max(200), password: z.string().min(1).max(1024) })
        .parse(request.body);
      return container.userAdmin.acceptInvitation(input);
    },
  );
}
