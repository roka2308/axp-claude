import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { seedReferenceDashboard } from '@axp/fixtures';
import { JobRunner, MemoryMailTransport } from '@axp/core';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  grantProjectAccess,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

const DEMO_MATOMO_TOKEN = 'demo-token-not-a-real-credential';
const WRONG_PASSWORD = 'falsches-pferd-batterie-heftklammer';
const SHARE_PASSWORD = 'freigabe-pferd-batterie-heftklammer';
const RESET_PASSWORD = 'neues-pferd-batterie-heftklammer';
const SEARCH_TERM = 'suchbegriff-7d1c';

/**
 * Log and telemetry content review (Phase 10; Master Spec §4, §24).
 *
 * Runs the flows that handle secrets and numbers - sign-in, invitation,
 * recovery, a protected share, widgets, an export, search - with every log
 * record captured, then reads the records back. Whatever reached the log
 * must not include a credential, a token, a person's address or a number
 * from Matomo.
 */
describe('log and telemetry content', () => {
  const lines: string[] = [];
  const secrets = new Map<string, string>();
  const numbers = new Set<number>();
  let ctx: TestContext;
  let app: FastifyInstance;

  beforeAll(async () => {
    await resetDatabase();
    const mail = new MemoryMailTransport();
    ctx = await createTestContext({
      mailTransport: mail,
      logDestination: { write: (line: string) => void lines.push(line) },
    });
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();
    const worker = new JobRunner({
      queue: ctx.container.jobs,
      logger: ctx.logger,
      handlers: { 'account.mail': ctx.container.accountMail.asJobHandler() },
      workerId: 'test',
      pollMs: 1000,
    });

    const tenantId = (
      await ctx.container.tenants.createTenant({
        portableId: 'demo.tenant',
        name: 'Kunde',
        slug: 'kunde',
      })
    ).tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');
    const projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: 'demo.project',
        name: 'Portal',
        slug: 'portal',
      })
    ).projectId;
    const admin = await person(tenantId, 'admin@example.invalid', 'tenant_admin', 'tenant');
    const editor = await person(tenantId, 'editor@example.invalid', 'dashboard_editor', 'tenant');
    await grantProjectAccess(ctx, editor, projectId, 'edit');
    const viewer = await person(tenantId, 'viewer@example.invalid', 'viewer', 'tenant');
    await grantProjectAccess(ctx, viewer, projectId, 'view');
    const { dashboardId } = await seedReferenceDashboard(ctx.container, {
      tenantId,
      projectId,
      actorUserId: editor,
    });

    secrets.set('the user password', STRONG_TEST_PASSWORD);
    secrets.set('the Matomo token', DEMO_MATOMO_TOKEN);
    secrets.set('the credential encryption key', ctx.config.secrets.credentialEncryptionKey);
    secrets.set('the session secret', ctx.config.secrets.sessionSecret);

    // A failed sign-in with a password that is not the account's.
    await login('viewer@example.invalid', WRONG_PASSWORD);
    secrets.set('a mistyped password', WRONG_PASSWORD);

    const adminSession = await signIn('admin@example.invalid');
    const editorSession = await signIn('editor@example.invalid');
    const viewerSession = await signIn('viewer@example.invalid');
    secrets.set('a session token', viewerSession);

    // Widgets and their numbers.
    const view = 'timeRange=last_30_days&comparison=previous_period&breakpoint=desktop';
    const layout = (await get(`/dashboards/${dashboardId}/layout?${view}`, viewerSession)).json();
    for (const widget of (layout.widgets as { widgetId: string }[]).map((entry) => ({
      id: entry.widgetId,
    }))) {
      const tile = await get(
        `/dashboards/${dashboardId}/widgets/${widget.id}?${view}`,
        viewerSession,
      );
      collectNumbers(tile.json(), numbers);
      await get(`/dashboards/${dashboardId}/widgets/${widget.id}/detail`, viewerSession);
    }

    // An export, created and downloaded.
    const exported = await post(`/dashboards/${dashboardId}/exports`, viewerSession, {
      format: 'csv',
      widgetId: layout.widgets[0].widgetId,
    });
    if (exported.statusCode === 201) await get(`/exports/${exported.json().id}`, viewerSession);

    // A password-protected share, opened from outside.
    const share = await post(`/dashboards/${dashboardId}/shares`, editorSession, {
      label: 'Vorstand',
      expiresOn: '2026-10-15',
      password: SHARE_PASSWORD,
      rights: { timeRange: true, comparison: true, detail: true, export: false },
    });
    expect(share.statusCode, share.body).toBe(201);
    const shareToken = share.json().token as string;
    secrets.set('a share token', shareToken);
    secrets.set('a share password', SHARE_PASSWORD);
    const unlocked = await app.inject({
      method: 'POST',
      url: '/public/share/unlock',
      headers: { 'x-share-token': shareToken },
      payload: { password: SHARE_PASSWORD },
    });
    const shareSession = unlocked.json().sessionToken as string;
    secrets.set('a share session', shareSession);
    await app.inject({
      method: 'GET',
      url: '/public/share/layout',
      headers: { 'x-share-token': shareToken, 'x-share-session': shareSession },
    });

    // An invitation, inspected and accepted.
    const invited = await post(`/admin/tenants/${tenantId}/users`, adminSession, {
      email: 'neu@example.invalid',
      firstName: 'Nora',
      lastName: 'Neu',
    });
    const invitationToken = invited.json().invitation.token as string;
    secrets.set('an invitation token', invitationToken);
    await app.inject({
      method: 'POST',
      url: '/invitations/inspect',
      payload: { token: invitationToken },
    });
    await worker.drain();
    await app.inject({
      method: 'POST',
      url: '/invitations/accept',
      payload: { token: invitationToken, password: STRONG_TEST_PASSWORD },
    });

    // Recovery, for an account and for nobody.
    await app.inject({
      method: 'POST',
      url: '/auth/password-reset',
      payload: { email: 'editor@example.invalid' },
    });
    await app.inject({
      method: 'POST',
      url: '/auth/password-reset',
      payload: { email: 'niemand@example.invalid' },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await worker.drain();
    const resetMail = mail.outbox.find(
      (message) => message.to.address === 'editor@example.invalid',
    );
    const resetToken = new URL(/(https?:\/\/\S+)/.exec(resetMail!.text)![1]!).searchParams.get(
      'token',
    )!;
    secrets.set('a reset token', resetToken);
    secrets.set('a new password', RESET_PASSWORD);
    await app.inject({
      method: 'POST',
      url: '/auth/password-reset/complete',
      payload: { token: resetToken, newPassword: RESET_PASSWORD },
    });

    // Search with a term, and a person list filtered by an address.
    await get(`/search?q=${SEARCH_TERM}`, viewerSession);
    await get(`/admin/tenants/${tenantId}/users?query=viewer%40example.invalid`, adminSession);
    secrets.set('a search term', SEARCH_TERM);

    // Something that fails, so an error path is logged too.
    await get(`/dashboards/${dashboardId}/widgets/does-not-exist`, viewerSession);
    void admin;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it('captured the flows', () => {
    if (process.env.TELEMETRY_DUMP) writeFileSync(process.env.TELEMETRY_DUMP, lines.join(''));
    expect(lines.length).toBeGreaterThan(50);
    expect(numbers.size).toBeGreaterThan(3);
  });

  it('holds no credential, token or password', () => {
    const log = lines.join('');
    const leaked = [...secrets.entries()].filter(([, value]) => value && log.includes(value));
    expect(leaked.map(([name]) => name)).toEqual([]);
  });

  it('holds no address and no search term', () => {
    const log = lines.join('');
    expect(log.match(/[\w.+-]+@example\.invalid/g) ?? []).toEqual([]);
    expect(log).not.toContain('%40example');
  });

  it('holds no number from Matomo', () => {
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    // Timing and size fields are the log's own numbers, not analytics values.
    const own = new Set(['time', 'pid', 'responseTime', 'durationMs', 'statusCode', 'remotePort']);
    const found: string[] = [];
    for (const record of records) {
      for (const [path, value] of leaves(record)) {
        if (typeof value !== 'number' || own.has(path.split('.').pop()!)) continue;
        if (numbers.has(value)) found.push(`${path}=${value} (${String(record.msg)})`);
      }
    }
    expect(found).toEqual([]);
  });

  it('never records a raw analytics payload key', () => {
    const log = lines.join('');
    expect(log).not.toContain('[dropped:analytics-payload]');
  });

  async function person(
    tenantId: string,
    email: string,
    role: 'viewer' | 'dashboard_editor' | 'tenant_admin',
    scope: 'tenant',
  ): Promise<string> {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: email.split('@')[0]!,
      lastName: 'Tester',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.tenants.addMembership(tenantId, userId);
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role,
      scopeType: scope,
      scopeId: tenantId,
    });
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

/** Distinctive numbers a widget showed: too specific to occur by chance. */
function collectNumbers(value: unknown, into: Set<number>): void {
  if (typeof value === 'number') {
    if (Math.abs(value) >= 100 || (!Number.isInteger(value) && Math.abs(value) > 0.001)) {
      into.add(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      // Layout geometry is not an analytics value.
      if (['x', 'y', 'w', 'h', 'version', 'publishedVersion'].includes(key)) continue;
      collectNumbers(item, into);
    }
  }
}

function* leaves(value: unknown, path = ''): Generator<[string, unknown]> {
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value))
      yield* leaves(item, path ? `${path}.${key}` : key);
  } else {
    yield [path, value];
  }
}
