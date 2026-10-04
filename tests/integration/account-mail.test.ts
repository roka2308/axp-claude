import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { accountTokens, auditEvents, jobs, userInvitations, users } from '@axp/db';
import { JobRunner, MemoryMailTransport } from '@axp/core';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

const NEW_PASSWORD = 'zweites-pferd-batterie-heftklammer';

/**
 * Mailed links (Phase 10, DEV-005): invitations, "Passwort vergessen" and the
 * verified change of one's own address.
 */
describe('account mail', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let mail: MemoryMailTransport;
  let worker: JobRunner;
  let tenantId: string;
  let adminToken: string;

  beforeEach(async () => {
    await resetDatabase();
    mail = new MemoryMailTransport();
    ctx = await createTestContext({ mailTransport: mail });
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();
    worker = new JobRunner({
      queue: ctx.container.jobs,
      logger: ctx.logger,
      handlers: { 'account.mail': ctx.container.accountMail.asJobHandler() },
      workerId: 'test',
      pollMs: 1000,
    });

    tenantId = (
      await ctx.container.tenants.createTenant({
        portableId: 'demo.tenant',
        name: 'Kunde',
        slug: 'kunde',
      })
    ).tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');
    const admin = await person('admin@example.invalid');
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: admin,
      role: 'tenant_admin',
      scopeType: 'tenant',
      scopeId: tenantId,
    });
    adminToken = await signIn('admin@example.invalid');
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  describe('invitations', () => {
    it('mails the link to the invited person, and the mail carries a working link', async () => {
      const response = await post(`/admin/tenants/${tenantId}/users`, adminToken, {
        email: 'neu@example.invalid',
        firstName: 'Nora',
        lastName: 'Neu',
        locale: 'en',
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().invitation.mailed).toBe(true);

      // The queue carries ids only; the token waits encrypted on the record.
      const [job] = await ctx.container.db.select().from(jobs);
      expect(Object.keys(job!.payload as object).sort()).toEqual(['purpose', 'recordId']);
      const [stored] = await ctx.container.db.select().from(userInvitations);
      expect(stored!.sealedToken).toBeTruthy();
      expect(stored!.sealedToken).not.toContain(response.json().invitation.token);

      await worker.drain();
      expect(mail.outbox).toHaveLength(1);
      const message = mail.outbox[0]!;
      expect(message.to.address).toBe('neu@example.invalid');
      expect(message.subject).toBe('Your invitation to Analytics Experience');
      const token = linkToken(message.text, '/invite');
      expect(token).toBe(response.json().invitation.token);

      // Sent: nothing left that could open the account.
      const [after] = await ctx.container.db.select().from(userInvitations);
      expect(after!.sealedToken).toBeNull();

      const accepted = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        payload: { token, password: STRONG_TEST_PASSWORD },
      });
      expect(accepted.statusCode).toBe(200);
    });

    it('sends nothing for an invitation replaced before the mail went out', async () => {
      const created = await post(`/admin/tenants/${tenantId}/users`, adminToken, {
        email: 'neu@example.invalid',
        firstName: 'Nora',
        lastName: 'Neu',
      });
      const userId = created.json().userId as string;
      await post(`/admin/tenants/${tenantId}/users/${userId}/invitation`, adminToken);
      await worker.drain();
      // Two invitations queued, only the live one is sent.
      expect(mail.outbox).toHaveLength(1);
    });
  });

  describe('password recovery', () => {
    it('answers the same for an unknown address, a deactivated account and a real one', async () => {
      const deactivated = await person('weg@example.invalid');
      await ctx.container.users.deactivate(deactivated);
      await person('echt@example.invalid');

      const answers = [];
      for (const email of [
        'niemand@example.invalid',
        'weg@example.invalid',
        'echt@example.invalid',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/password-reset',
          payload: { email },
        });
        answers.push({ status: response.statusCode, body: response.body });
      }
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
      expect(answers[0]!.status).toBe(202);

      await settle();
      await worker.drain();
      expect(mail.outbox.map((message) => message.to.address)).toEqual(['echt@example.invalid']);
    });

    it('resets the password once, ends every session and keeps the history rule', async () => {
      const userId = await person('echt@example.invalid');
      const session = await signIn('echt@example.invalid');
      await ctx.container.accountMail.requestPasswordReset('ECHT@example.invalid');
      await worker.drain();
      const token = linkToken(mail.outbox[0]!.text, '/reset-password');

      const inspect = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/inspect',
        payload: { token },
      });
      expect(inspect.json()).toEqual({ valid: true });

      // The previous password is refused by the history rule.
      const reused = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/complete',
        payload: { token, newPassword: STRONG_TEST_PASSWORD },
      });
      expect(reused.statusCode).toBe(422);

      const done = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/complete',
        payload: { token, newPassword: NEW_PASSWORD },
      });
      expect(done.statusCode).toBe(200);

      // The old session is gone; the old password no longer works; the new one does.
      expect((await get('/auth/me', session)).statusCode).toBe(401);
      expect((await login('echt@example.invalid', STRONG_TEST_PASSWORD)).statusCode).toBe(401);
      expect((await login('echt@example.invalid', NEW_PASSWORD)).statusCode).toBe(200);

      // Single use.
      const again = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/complete',
        payload: { token, newPassword: 'drittes-pferd-batterie-heftklammer' },
      });
      expect(again.statusCode).toBe(404);
      expect(again.json().error.messageKey).toBe('recovery.link_invalid');

      const actions = (
        await ctx.container.db
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(eq(auditEvents.targetId, userId))
      ).map((row) => row.action);
      expect(actions).toEqual(
        expect.arrayContaining(['auth.password.reset_requested', 'auth.password.reset']),
      );
    });

    it('expires the link and throttles repeated requests', async () => {
      await person('echt@example.invalid');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await ctx.container.accountMail.requestPasswordReset('echt@example.invalid');
      }
      expect(await ctx.container.db.select().from(accountTokens)).toHaveLength(3);
      await worker.drain();
      const token = linkToken(mail.outbox[0]!.text, '/reset-password');

      ctx.clock.advance(61 * 60_000);
      expect(await ctx.container.accountMail.inspectPasswordReset(token)).toBe(false);
    });
  });

  describe('verified address change', () => {
    it('needs the current password, verifies the new mailbox and tells the old one', async () => {
      const userId = await person('alt@example.invalid');
      const session = await signIn('alt@example.invalid');

      const wrong = await post('/me/email', session, {
        newEmail: 'neu@example.invalid',
        currentPassword: 'falsch-falsch-falsch',
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.fieldErrors.currentPassword).toBeTruthy();

      const requested = await post('/me/email', session, {
        newEmail: 'Neu@example.invalid',
        currentPassword: STRONG_TEST_PASSWORD,
      });
      expect(requested.statusCode).toBe(200);
      expect((await get('/me/profile', session)).json().pendingEmailChange.newEmail).toBe(
        'Neu@example.invalid',
      );

      await worker.drain();
      const recipients = mail.outbox.map((message) => message.to.address).sort();
      expect(recipients).toEqual(['Neu@example.invalid', 'alt@example.invalid']);
      const notice = mail.outbox.find((message) => message.to.address === 'alt@example.invalid')!;
      expect(notice.text).not.toContain('token=');
      const verification = mail.outbox.find(
        (message) => message.to.address === 'Neu@example.invalid',
      )!;
      const token = linkToken(verification.text, '/profile/email/confirm');

      // Until confirmed, the old address is the account's.
      expect((await login('alt@example.invalid', STRONG_TEST_PASSWORD)).statusCode).toBe(200);

      const confirmed = await app.inject({
        method: 'POST',
        url: '/auth/email-change/confirm',
        payload: { token },
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toEqual({ email: 'Neu@example.invalid' });

      expect((await login('alt@example.invalid', STRONG_TEST_PASSWORD)).statusCode).toBe(401);
      expect((await login('neu@example.invalid', STRONG_TEST_PASSWORD)).statusCode).toBe(200);
      const [row] = await ctx.container.db.select().from(users).where(eq(users.id, userId));
      expect(row!.emailVerifiedAt).not.toBeNull();

      const twice = await app.inject({
        method: 'POST',
        url: '/auth/email-change/confirm',
        payload: { token },
      });
      expect(twice.statusCode).toBe(404);
    });

    it('refuses an address another account uses, and a cancelled change cannot be confirmed', async () => {
      await person('alt@example.invalid');
      await person('besetzt@example.invalid');
      const session = await signIn('alt@example.invalid');

      const taken = await post('/me/email', session, {
        newEmail: 'besetzt@example.invalid',
        currentPassword: STRONG_TEST_PASSWORD,
      });
      expect(taken.statusCode).toBe(409);

      await post('/me/email', session, {
        newEmail: 'neu@example.invalid',
        currentPassword: STRONG_TEST_PASSWORD,
      });
      await worker.drain();
      const token = linkToken(
        mail.outbox.find((message) => message.to.address === 'neu@example.invalid')!.text,
        '/profile/email/confirm',
      );
      const cancelled = await app.inject({
        method: 'DELETE',
        url: '/me/email',
        headers: { authorization: `Bearer ${session}` },
      });
      expect(cancelled.statusCode).toBe(200);
      const confirm = await app.inject({
        method: 'POST',
        url: '/auth/email-change/confirm',
        payload: { token },
      });
      expect(confirm.statusCode).toBe(404);
      expect((await get('/me/profile', session)).json().pendingEmailChange).toBeNull();
    });

    it('leaves an address the identity provider manages alone', async () => {
      const { userId } = await ctx.container.users.createFederatedUser({
        email: 'sso@example.invalid',
        firstName: 'Sso',
        lastName: 'Person',
        providerSubject: 'sub-1',
        managedAttributes: ['email', 'firstName', 'lastName'],
      });
      await expect(
        ctx.container.accountMail.requestEmailChange({
          userId,
          newEmail: 'anders@example.invalid',
          currentPassword: 'egal-egal-egal-egal',
        }),
      ).rejects.toMatchObject({ code: 'email_managed' });
    });
  });

  async function person(email: string): Promise<string> {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: email.split('@')[0]!,
      lastName: 'Tester',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.tenants.addMembership(tenantId, userId);
    return userId;
  }

  function login(email: string, password: string) {
    return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  }

  async function signIn(email: string): Promise<string> {
    const response = await login(email, STRONG_TEST_PASSWORD);
    expect(response.statusCode, email).toBe(200);
    return response.json().token as string;
  }

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  function post(url: string, token: string, payload: unknown = {}) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as object,
    });
  }
});

/** The token of the one link in a mail, checked to point at the expected page. */
function linkToken(text: string, path: string): string {
  const match = /(https?:\/\/\S+)/.exec(text);
  expect(match, 'a link in the mail').toBeTruthy();
  const url = new URL(match![1]!);
  expect(url.pathname).toBe(path);
  return url.searchParams.get('token')!;
}

/** The reset request is answered before its work is done; let that work finish. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
