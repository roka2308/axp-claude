import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { THEME_PRESETS } from '@axp/contracts';
import { dashboardShares, reportSchedules, themes, themeVersions } from '@axp/db';
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

/**
 * Themes, entitlements and diagnostics (D9, Gate F9).
 */
describe('themes, entitlements and diagnostics', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let mail: MemoryMailTransport;

  let tenantId: string;
  let projectId: string;
  let dashboardId: string;
  let editorId: string;
  let viewerId: string;
  let platform: string;
  let tenantAdmin: string;
  let editor: string;
  let viewer: string;

  beforeEach(async () => {
    await resetDatabase();
    mail = new MemoryMailTransport();
    ctx = await createTestContext({ mailTransport: mail });
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();

    tenantId = (
      await ctx.container.tenants.createTenant({
        portableId: 'demo.tenant',
        name: 'Kunde',
        slug: 'kunde',
      })
    ).tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');
    projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: 'demo.project',
        name: 'Portal',
        slug: 'portal',
      })
    ).projectId;

    await user('platform@example.invalid', 'platform_admin', 'platform');
    await user('tenantadmin@example.invalid', 'tenant_admin', 'tenant');
    editorId = await user('editor@example.invalid', 'dashboard_editor', 'project');
    await grantProjectAccess(ctx, editorId, projectId, 'edit');
    viewerId = await user('viewer@example.invalid', 'viewer', 'project');
    await grantProjectAccess(ctx, viewerId, projectId, 'view');
    dashboardId = (
      await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId: editorId })
    ).dashboardId;

    platform = await signIn('platform@example.invalid');
    tenantAdmin = await signIn('tenantadmin@example.invalid');
    editor = await signIn('editor@example.invalid');
    viewer = await signIn('viewer@example.invalid');
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- themes ------------------------------------------------------------------------

  describe('themes', () => {
    it('publishes the reference theme and applies it, inherited platform -> tenant -> project', async () => {
      await saveDraft('/themes/platform', platform, THEME_PRESETS['telekom-default']);
      expect((await post('/themes/platform/publish', platform)).statusCode).toBe(200);
      await saveDraft(
        `/themes/tenants/${tenantId}`,
        tenantAdmin,
        THEME_PRESETS['neutral-customer'],
      );
      expect((await post(`/themes/tenants/${tenantId}/publish`, tenantAdmin)).statusCode).toBe(200);
      await saveDraft(`/themes/projects/${projectId}`, tenantAdmin, {
        name: 'Portal',
        tokens: { '--chart-series-1': '#7a3db8' },
      });
      expect((await post(`/themes/projects/${projectId}/publish`, tenantAdmin)).statusCode).toBe(
        200,
      );

      const css = (await get(`/theme/effective?projectId=${projectId}`, editor)).json()
        .css as string;
      // The tenant's accent overrides the platform's; the project adds its own.
      expect(css).toContain('--accent-default:#0f6e6e;');
      expect(css).not.toContain('#e20074');
      expect(css).toContain('--chart-series-1:#7a3db8;');
      // Light values are scoped to light mode.
      expect(css).toMatch(/@media \(prefers-color-scheme: light\)/);

      const overview = (await get(`/themes/projects/${projectId}`, tenantAdmin)).json();
      expect(overview.inherited['--accent-default']).toBe('#0f6e6e');
    });

    it('refuses anything but allowlisted tokens with plain values - no CSS, no script', async () => {
      const attempts = [
        { '--accent-default': 'url(javascript:alert(1))' },
        { '--accent-default': '#fff;}body{display:none' },
        { '--surface-card': 'expression(alert(1))' },
        { '--font-sans': "Arial'; @import url(//evil.example)" },
        { '--grid-columns-desktop': '16' },
        { 'background-image': 'url(https://evil.example/x.png)' },
        { '--accent-default': '<script>alert(1)</script>' },
      ];
      for (const tokens of attempts) {
        const response = await put(`/themes/tenants/${tenantId}/draft`, tenantAdmin, {
          name: 'Böse',
          tokens,
        });
        expect(response.statusCode, JSON.stringify(tokens)).toBe(422);
        expect(response.json().error.messageKey).toBe('theme.tokens_refused');
      }
      // Unknown top-level fields are refused too: there is no place for CSS.
      const extra = await put(`/themes/tenants/${tenantId}/draft`, tenantAdmin, {
        name: 'Extra',
        tokens: {},
        css: 'body{display:none}',
      });
      expect(extra.statusCode).toBe(422);
      expect(await ctx.handle.db.select().from(themes)).toHaveLength(0);
    });

    it('does not publish a theme whose contrast fails, and says which pair', async () => {
      await saveDraft(`/themes/tenants/${tenantId}`, tenantAdmin, {
        name: 'Gelb',
        tokens: { '--accent-default': '#ffd400' },
      });
      const validation = (await post(`/themes/tenants/${tenantId}/validate`, tenantAdmin)).json();
      expect(validation.publishable).toBe(false);
      expect(
        validation.contrast
          .filter((check: { pass: boolean }) => !check.pass)
          .map((check: { reason: string }) => check.reason),
      ).toEqual(['button_label']);

      const refused = await post(`/themes/tenants/${tenantId}/publish`, tenantAdmin);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.messageKey).toBe('theme.contrast_failed');
      expect(await ctx.handle.db.select().from(themeVersions)).toHaveLength(0);
    });

    it('does not publish a platform theme that would break a customer theme built on it', async () => {
      // The customer's link colour passes on white...
      await saveDraft(`/themes/tenants/${tenantId}`, tenantAdmin, {
        name: 'Kunde',
        tokens: { '--text-link': '#2f6fd6' },
      });
      expect((await post(`/themes/tenants/${tenantId}/publish`, tenantAdmin)).statusCode).toBe(200);
      // ...and a platform card colour that passes on its own would make it fail.
      await saveDraft('/themes/platform', platform, {
        name: 'Plattform',
        tokens: { '--surface-card': '#f5f6f8' },
      });
      const validation = (await post('/themes/platform/validate', platform)).json();
      expect(validation.contrast.every((check: { pass: boolean }) => check.pass)).toBe(true);
      expect(validation.dependents).toEqual([{ scope: 'tenant', name: 'Kunde', failing: 1 }]);
      const refused = await post('/themes/platform/publish', platform);
      expect(refused.json().error.messageKey).toBe('theme.dependents_fail');
    });

    it('rolls back by publishing an older version again', async () => {
      await saveDraft(
        `/themes/tenants/${tenantId}`,
        tenantAdmin,
        THEME_PRESETS['neutral-customer'],
      );
      await post(`/themes/tenants/${tenantId}/publish`, tenantAdmin);
      await saveDraft(`/themes/tenants/${tenantId}`, tenantAdmin, THEME_PRESETS['telekom-default']);
      await post(`/themes/tenants/${tenantId}/publish`, tenantAdmin);
      const rolled = (
        await post(`/themes/tenants/${tenantId}/rollback`, tenantAdmin, { version: 1 })
      ).json();
      expect(rolled.published.version).toBe(3);
      expect(rolled.published.tokens['--accent-default']).toBe('#0f6e6e');
      expect(rolled.versions[0]).toMatchObject({
        version: 3,
        rolledBackFromVersion: 1,
        isCurrent: true,
      });
    });

    it('is managed by the right people only', async () => {
      expect(
        (await put('/themes/platform/draft', tenantAdmin, { name: 'x', tokens: {} })).statusCode,
      ).toBe(403);
      expect(
        (await put(`/themes/tenants/${tenantId}/draft`, editor, { name: 'x', tokens: {} }))
          .statusCode,
      ).toBe(403);
      expect((await get(`/themes/tenants/${tenantId}`, viewer)).statusCode).toBe(403);
    });
  });

  // --- entitlements -------------------------------------------------------------------

  describe('entitlements', () => {
    it('losing a module keeps its configuration, and gaining it back restores it', async () => {
      // Configuration for three modules.
      const schedule = await post(`/projects/${projectId}/reports`, editor, {
        dashboardId,
        name: 'Wochenbericht',
        format: 'pdf',
        period: 'last_7_days',
        comparison: 'previous_period',
        rhythm: { frequency: 'daily', time: '07:00' },
        timezone: 'Europe/Berlin',
        deliveryMode: 'attachment',
        recipientUserIds: [viewerId],
      });
      expect(schedule.statusCode).toBe(201);
      const share = await post(`/dashboards/${dashboardId}/shares`, editor, {
        label: 'Vorstand',
        expiresOn: '2026-10-15',
        rights: { timeRange: false, comparison: false, detail: false, export: false },
      });
      const token = share.json().token as string;
      await saveDraft(
        `/themes/tenants/${tenantId}`,
        tenantAdmin,
        THEME_PRESETS['neutral-customer'],
      );
      await post(`/themes/tenants/${tenantId}/publish`, tenantAdmin);

      for (const entitlement of ['reporting.scheduled', 'sharing.external', 'theming.custom']) {
        expect(
          (
            await put(`/admin/platform/tenants/${tenantId}/entitlements/${entitlement}`, platform, {
              enabled: false,
            })
          ).statusCode,
        ).toBe(200);
      }

      // Each module answers "not in your contract" - a state of its own.
      const reports = await get(`/projects/${projectId}/reports`, editor);
      expect(reports.statusCode).toBe(403);
      expect(reports.json().error).toMatchObject({
        category: 'entitlement_required',
        messageKey: 'entitlement.missing.reporting_scheduled',
      });
      expect(
        (
          await post(`/dashboards/${dashboardId}/shares`, editor, {
            label: 'x',
            expiresOn: '2026-10-15',
            rights: { timeRange: false, comparison: false, detail: false, export: false },
          })
        ).json().error.category,
      ).toBe('entitlement_required');
      expect((await publicGet('/public/share', token)).json()).toEqual({ state: 'unavailable' });
      expect(
        (await get(`/theme/effective?projectId=${projectId}`, editor)).json().css,
      ).not.toContain('#0f6e6e');
      // The share list stays reachable, so links can still be revoked.
      const list = (await get(`/dashboards/${dashboardId}/shares`, editor)).json();
      expect(list.entitled).toBe(false);
      expect(list.shares[0]).toMatchObject({
        status: 'unavailable',
        unavailableReason: 'entitlement_missing',
      });

      // Nothing was deleted.
      expect(await ctx.handle.db.select().from(reportSchedules)).toHaveLength(1);
      expect(await ctx.handle.db.select().from(dashboardShares)).toHaveLength(1);
      expect(await ctx.handle.db.select().from(themeVersions)).toHaveLength(1);

      // A due report is skipped, not lost.
      ctx.clock.set(new Date('2026-09-19T05:00:30Z'));
      expect(await ctx.container.reportRunner.scheduleDue()).toEqual({ queued: 0, skipped: 1 });

      // Back on: everything works again, unchanged.
      platform = await signIn('platform@example.invalid');
      for (const entitlement of ['reporting.scheduled', 'sharing.external', 'theming.custom']) {
        const restored = await put(
          `/admin/platform/tenants/${tenantId}/entitlements/${entitlement}`,
          platform,
          {
            enabled: true,
          },
        );
        expect(restored.statusCode).toBe(200);
      }
      editor = await signIn('editor@example.invalid');
      const back = await get(`/projects/${projectId}/reports`, editor);
      expect(back.statusCode, back.body).toBe(200);
      expect(back.json().schedules).toHaveLength(1);
      expect((await publicGet('/public/share', token)).json().state).toBe('available');
      expect((await get(`/theme/effective?projectId=${projectId}`, editor)).json().css).toContain(
        '#0f6e6e',
      );
      ctx.clock.set(new Date('2026-09-20T05:00:30Z'));
      expect(await ctx.container.reportRunner.scheduleDue()).toEqual({ queued: 1, skipped: 0 });
      const worker = new JobRunner({
        queue: ctx.container.jobs,
        logger: ctx.logger,
        handlers: { 'report.deliver': ctx.container.reportRunner.asJobHandler() },
        workerId: 'test',
        pollMs: 1000,
      });
      await worker.drain();
      expect(mail.outbox).toHaveLength(1);
    }, 60_000);

    it('is decided by platform administrators only, and tells apart a feature flag', async () => {
      expect(
        (
          await put(
            `/admin/platform/tenants/${tenantId}/entitlements/sharing.external`,
            tenantAdmin,
            { enabled: false },
          )
        ).statusCode,
      ).toBe(403);
      const listing = (
        await get(`/admin/platform/tenants/${tenantId}/entitlements`, platform)
      ).json();
      expect(listing.entitlements.every((entry: { enabled: boolean }) => entry.enabled)).toBe(true);
      expect(listing.featureFlags).toEqual([
        { flag: 'reports.pptx', enabled: false, setting: 'REPORTS_PPTX_ENABLED' },
      ]);
    });
  });

  // --- diagnostics -------------------------------------------------------------------

  describe('diagnostics', () => {
    it('describes the release and the installation', async () => {
      const system = (await get('/admin/platform/system', platform)).json();
      expect(system.release).toMatchObject({ schemaVersion: '9', supportStatus: 'current' });
      expect(system.release.appliedMigrations).toBeGreaterThanOrEqual(9);
      expect(system.compatibility.matomoSupportModel).toBe('capability_based');
      expect(system.compatibility.matomoConnections).toHaveLength(1);
      expect((await get('/admin/platform/system', tenantAdmin)).statusCode).toBe(403);
    });

    it('generates a bundle without secrets, URLs, people or analytics values, for its creator only', async () => {
      const generated = await post('/admin/platform/diagnostics', platform);
      expect(generated.statusCode).toBe(201);
      const file = await get(`/admin/platform/diagnostics/${generated.json().id}`, platform);
      expect(file.statusCode).toBe(200);
      const text = file.body;
      const bundle = JSON.parse(text);
      expect(bundle).toMatchObject({
        kind: 'axp-diagnostic-bundle',
        release: { schemaVersion: '9' },
      });

      for (const secret of [
        ctx.config.secrets.sessionSecret,
        ctx.config.secrets.credentialEncryptionKey,
        'demo-token-not-a-real-credential',
        STRONG_TEST_PASSWORD,
      ]) {
        expect(text.includes(secret), 'secret').toBe(false);
      }
      expect(text).not.toMatch(/https?:\/\/|mock:\/\//);
      expect(text).not.toMatch(/@example\.invalid/);
      expect(text).not.toMatch(/nb_visits|Besuche|Seitenaufrufe/);

      // Someone else, even another platform admin, cannot fetch it.
      await user('platform2@example.invalid', 'platform_admin', 'platform');
      const other = await signIn('platform2@example.invalid');
      expect(
        (await get(`/admin/platform/diagnostics/${generated.json().id}`, other)).statusCode,
      ).toBe(404);

      // It expires and is deleted.
      ctx.clock.advance(ctx.config.diagnostics.bundleTtlMinutes * 60_000 + 1);
      expect(await ctx.container.diagnostics.purgeExpired()).toBe(1);
    });

    it('needs a fresh password confirmation to generate', async () => {
      ctx.clock.advance(ctx.config.session.reauthWindowMinutes * 60_000 + 1);
      platform = await signIn('platform@example.invalid');
      ctx.clock.advance(ctx.config.session.reauthWindowMinutes * 60_000 + 1);
      const refused = await post('/admin/platform/diagnostics', platform);
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error.code).toBe('reauthentication_required');
    });
  });

  // --- helpers --------------------------------------------------------------------------

  async function saveDraft(
    base: string,
    token: string,
    draft: { name: string; tokens: Record<string, string> },
  ) {
    const response = await put(`${base}/draft`, token, {
      name: draft.name,
      tokens: { ...draft.tokens },
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function user(
    email: string,
    role: 'viewer' | 'dashboard_editor' | 'tenant_admin' | 'platform_admin',
    scope: 'project' | 'tenant' | 'platform',
  ) {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: email.split('@')[0]!,
      lastName: 'Tester',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    if (scope !== 'platform') await ctx.container.tenants.addMembership(tenantId, userId);
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role,
      scopeType: scope,
      scopeId: scope === 'project' ? projectId : scope === 'tenant' ? tenantId : '',
    });
    return userId;
  }

  async function signIn(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: STRONG_TEST_PASSWORD },
    });
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

  function put(url: string, token: string, payload: unknown) {
    return app.inject({
      method: 'PUT',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as object,
    });
  }

  function publicGet(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { 'x-share-token': token } });
  }

  void eq;
});
