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
 * the e-mail address of a local account needs the current password and a
 * confirmation from the new mailbox; the old address is told (Master Spec
 * §12). "Passwort vergessen" answers the same whether or not an account exists.
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
      pendingEmailChange: await container.accountMail.pendingEmailChange(auth.userId),
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

  /** Starts a verified address change: password now, the new mailbox confirms. */
  app.post(
    '/me/email',
    { ...guard, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireAuth(request);
      const input = z
        .object({
          newEmail: z.string().trim().email().max(320),
          currentPassword: z.string().min(1).max(1024),
        })
        .strict()
        .parse(request.body);
      return {
        pendingEmailChange: await container.accountMail.requestEmailChange({
          userId: auth.userId,
          ...input,
        }),
      };
    },
  );

  app.delete('/me/email', guard, async (request) => {
    const auth = requireAuth(request);
    await container.accountMail.cancelEmailChange(auth.userId);
    return { ok: true };
  });

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

  // --- links from mails (public) ----------------------------------------------
  // Tokens travel in the body, never in a URL the server would log.

  /**
   * "Passwort vergessen". The answer is the same for every address and is
   * given before any lookup happens, so neither its content nor its timing
   * tells whether an account exists.
   */
  app.post(
    '/auth/password-reset',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { email } = z.object({ email: z.string().trim().min(1).max(320) }).parse(request.body);
      void container.accountMail
        .requestPasswordReset(email)
        .catch((error: unknown) =>
          request.log.error({ err: error }, 'Password reset request failed'),
        );
      void reply.status(202);
      return { ok: true };
    },
  );

  app.post(
    '/auth/password-reset/inspect',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
      return { valid: await container.accountMail.inspectPasswordReset(token) };
    },
  );

  app.post(
    '/auth/password-reset/complete',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const input = z
        .object({ token: z.string().min(10).max(200), newPassword: z.string().min(1).max(1024) })
        .parse(request.body);
      await container.accountMail.completePasswordReset(input);
      return { ok: true };
    },
  );

  /** Confirms a new address from its link; no session needed, the mailbox is the proof. */
  app.post(
    '/auth/email-change/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
      return container.accountMail.confirmEmailChange(token);
    },
  );

  // --- invitations (public) ------------------------------------------------

  app.post(
    '/invitations/inspect',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = z.object({ token: z.string().min(10).max(200) }).parse(request.body);
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
