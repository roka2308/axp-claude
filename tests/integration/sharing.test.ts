import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { DashboardSnapshot, ShareCreated, WidgetPresentation } from '@axp/contracts';
import { auditEvents, dashboardShares, exportArtifacts, shareSessions } from '@axp/db';
import { seedReferenceDashboard } from '@axp/fixtures';
import { minutes } from '@axp/core';
import { buildServer } from '../../apps/api/src/server';
import {
  csvRows,
  pdfText,
  pptxSlides,
  xlsxSheets,
} from '../../packages/core/src/export/readers.test-helper';
import {
  closeDatabase,
  createTestContext,
  grantProjectAccess,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * Sharing and exports (D8, Gate F7).
 *
 * The recipient side is exercised the way a browser reaches it: through the
 * public routes, with nothing but the link token. Every response and every
 * exported file is searched for the draft's and the internal notes' marker
 * texts - "never exposed" is checked on the bytes, not assumed.
 */
describe('sharing and exports', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  let tenantId: string;
  let projectId: string;
  let dashboardId: string;
  let editorId: string;

  let editor: string;
  let viewer: string;
  let outsider: string;

  const NOTE = 'INTERNE-NOTIZ-7f3a';
  const WIDGET_NOTE = 'WIDGET-NOTIZ-19be';
  const DRAFT_NAME = 'ENTWURF-GEHEIM-55c1';
  const DRAFT_WIDGET = 'ENTWURF-WIDGET-02d4';
  const MARKERS = [NOTE, WIDGET_NOTE, DRAFT_NAME, DRAFT_WIDGET];

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
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

    editorId = await user('editor@example.invalid', 'dashboard_editor');
    await grantProjectAccess(ctx, editorId, projectId, 'edit');
    const viewerId = await user('viewer@example.invalid', 'viewer');
    await grantProjectAccess(ctx, viewerId, projectId, 'view');
    // An editor without any grant: the role alone opens nothing (ADR 0006).
    await user('outsider@example.invalid', 'dashboard_editor');

    dashboardId = (
      await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId: editorId })
    ).dashboardId;

    // Version 2 carries internal notes; the draft after it has unpublished changes.
    await editDraft((snapshot) => ({
      ...snapshot,
      internalNote: NOTE,
      widgets: snapshot.widgets.map((widget, index) =>
        index === 0
          ? { ...widget, context: { ...widget.context, internalNote: WIDGET_NOTE } }
          : widget,
      ),
    }));
    await ctx.container.dashboards.publish({ tenantId, dashboardId, actorUserId: editorId });
    await editDraft((snapshot) => ({
      ...snapshot,
      name: DRAFT_NAME,
      widgets: [
        ...snapshot.widgets,
        {
          ...snapshot.widgets[0]!,
          id: 'draft-only',
          title: DRAFT_WIDGET,
          placement: { desktop: { x: 0, y: 20, w: 3, h: 3 } },
        },
      ],
    }));

    editor = await signIn('editor@example.invalid');
    viewer = await signIn('viewer@example.invalid');
    outsider = await signIn('outsider@example.invalid');
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- internal notes stay inside ----------------------------------------------

  it('shows internal notes to the signed-in product', async () => {
    const layout = (await get(`/dashboards/${dashboardId}/layout`, viewer)).json();
    expect(layout.dashboard.internalNote).toBe(NOTE);
    const tile = (await get(`/dashboards/${dashboardId}/widgets/kpi-visits`, viewer)).json();
    expect(tile.internalNote).toBe(WIDGET_NOTE);
  });

  // --- creating and managing shares --------------------------------------------

  describe('creating a share', () => {
    it('returns the link once and stores only its hash', async () => {
      const created = await createShare();
      expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(created.share).toMatchObject({
        status: 'active',
        passwordProtected: false,
        accessCount: 0,
      });

      const [row] = await ctx.handle.db.select().from(dashboardShares);
      expect(JSON.stringify(row)).not.toContain(created.token);

      const audit = await ctx.handle.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'share.created'));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toContain(created.token);
    });

    it('requires an expiry within 90 days, and not in the past', async () => {
      expect(
        (
          await post(
            `/dashboards/${dashboardId}/shares`,
            editor,
            shareBody({ expiresOn: '2026-09-17' }),
          )
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await post(
            `/dashboards/${dashboardId}/shares`,
            editor,
            shareBody({ expiresOn: '2026-12-18' }),
          )
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await post(`/dashboards/${dashboardId}/shares`, editor, {
            label: 'x',
            rights: RIGHTS_NONE,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await post(
            `/dashboards/${dashboardId}/shares`,
            editor,
            shareBody({ expiresOn: '2026-12-17' }),
          )
        ).statusCode,
      ).toBe(201);
    });

    it('lets the link end with the chosen day, in the project time zone', async () => {
      const created = await createShare({ expiresOn: '2026-10-15' });
      // Europe/Berlin is UTC+2 in October: the day ends at 21:59:59.999 UTC.
      expect(created.share.expiresAt).toBe('2026-10-15T21:59:59.999Z');
    });

    it('needs the share right and a grant on the dashboard', async () => {
      expect(
        (await post(`/dashboards/${dashboardId}/shares`, viewer, shareBody())).statusCode,
      ).toBe(403);
      expect(
        (await post(`/dashboards/${dashboardId}/shares`, outsider, shareBody())).statusCode,
      ).toBe(403);
      expect((await get(`/dashboards/${dashboardId}/shares`, viewer)).statusCode).toBe(403);
    });

    it('hands internal distribution to permissions instead of a link', async () => {
      const access = (await get(`/dashboards/${dashboardId}/internal-access`, editor)).json();
      expect(access.canManage).toBe(false);
      expect(access.manageHref).toBeUndefined();
      expect(access.grants.map((grant: { subjectName: string }) => grant.subjectName)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('editor'),
          expect.stringContaining('viewer'),
        ]),
      );
    });
  });

  // --- the recipient's side ------------------------------------------------------

  describe('what a recipient sees', () => {
    it('never the draft, never an internal note - not in any response', async () => {
      const { token } = await createShare({ rights: RIGHTS_ALL });

      const access = await publicGet('/public/share', token);
      expect(access.json()).toMatchObject({
        state: 'available',
        meta: { dashboardName: 'Portal Overview' },
      });

      const layout = await publicGet('/public/share/layout', token);
      expect(layout.statusCode).toBe(200);
      const widgetIds = layout
        .json()
        .widgets.map((widget: { widgetId: string }) => widget.widgetId);
      expect(widgetIds).not.toContain('draft-only');

      const bodies = [access.body, layout.body];
      for (const widgetId of widgetIds) {
        const tile = await publicGet(`/public/share/widgets/${widgetId}`, token);
        expect(tile.statusCode).toBe(200);
        const detail = await publicGet(`/public/share/widgets/${widgetId}/detail`, token);
        expect(detail.statusCode).toBe(200);
        bodies.push(tile.body, detail.body);
      }
      // The draft-only widget is not reachable by guessing its id either.
      expect((await publicGet('/public/share/widgets/draft-only', token)).statusCode).toBe(404);

      for (const body of bodies) {
        for (const marker of MARKERS) expect(body).not.toContain(marker);
        expect(body).not.toContain(dashboardId);
        expect(body).not.toContain('internalNote');
      }
    });

    it('never in an exported file either', async () => {
      const { token } = await createShare({ rights: RIGHTS_ALL });
      for (const format of ['pdf', 'xlsx', 'pptx'] as const) {
        const file = await publicExport(token, { format });
        const text = await readableText(format, file);
        for (const marker of MARKERS) expect(text, format).not.toContain(marker);
        expect(text, format).toContain('Portal Overview');
      }
    }, 60_000);

    it('shows the dashboard defaults, and changes only what the share allows', async () => {
      const { token } = await createShare({ rights: RIGHTS_NONE });

      const layout = (await publicGet('/public/share/layout', token)).json();
      expect(layout.share.rights).toEqual(RIGHTS_NONE);
      expect(layout.timeRange.preset).toBe('last_30_days');

      // Asking for the default is fine; anything else is refused.
      expect(
        (await publicGet('/public/share/layout?timeRange=last_30_days', token)).statusCode,
      ).toBe(200);
      const refused = await publicGet('/public/share/layout?timeRange=last_7_days', token);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.messageKey).toBe('share.right_missing.timeRange');
      expect(
        (await publicGet('/public/share/layout?comparison=prior_year', token)).statusCode,
      ).toBe(403);
      expect((await publicGet('/public/share/widgets/kpi-visits/detail', token)).statusCode).toBe(
        403,
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/public/share/exports',
            headers: { 'x-share-token': token },
            payload: { format: 'pdf' },
          })
        ).statusCode,
      ).toBe(403);

      const allowed = await createShare({ rights: RIGHTS_ALL });
      const changed = (
        await publicGet(
          '/public/share/layout?timeRange=last_7_days&comparison=prior_year',
          allowed.token,
        )
      ).json();
      expect(changed.timeRange.preset).toBe('last_7_days');
      expect(changed.comparison.mode).toBe('prior_year');
    });

    it('turns every broken link into the same neutral answer', async () => {
      const unknown = await publicGet(
        '/public/share',
        'no-such-token-at-all-000000000000000000000',
      );
      expect(unknown.json()).toEqual({ state: 'unavailable' });
      const unknownLayout = await publicGet(
        '/public/share/layout',
        'no-such-token-at-all-000000000000000000000',
      );

      const revoked = await createShare();
      await post(`/dashboards/${dashboardId}/shares/${revoked.share.id}/revoke`, editor, {});
      const revokedAccess = await publicGet('/public/share', revoked.token);
      const revokedLayout = await publicGet('/public/share/layout', revoked.token);

      expect(revokedAccess.json()).toEqual(unknown.json());
      expect(revokedLayout.statusCode).toBe(unknownLayout.statusCode);
      expect(revokedLayout.json().error.messageKey).toBe(unknownLayout.json().error.messageKey);
    });

    it('stops at expiry', async () => {
      const { token, share } = await createShare({ expiresOn: '2026-09-20' });
      expect((await publicGet('/public/share', token)).json().state).toBe('available');

      ctx.clock.set(new Date(new Date(share.expiresAt).getTime() + 1));
      expect((await publicGet('/public/share', token)).json()).toEqual({ state: 'unavailable' });
      const [listed] = await ctx.container.shares.list(tenantId, dashboardId);
      expect(listed!.status).toBe('expired');
    });

    it('stops on revoke, and its export files go with it', async () => {
      const { token, share } = await createShare({ rights: RIGHTS_ALL });
      await publicExport(token, { format: 'xlsx' });
      expect(await ctx.handle.db.select().from(exportArtifacts)).toHaveLength(1);

      const revoked = await post(
        `/dashboards/${dashboardId}/shares/${share.id}/revoke`,
        editor,
        {},
      );
      expect(revoked.json().status).toBe('revoked');
      expect((await publicGet('/public/share', token)).json().state).toBe('unavailable');
      expect(await ctx.handle.db.select().from(exportArtifacts)).toHaveLength(0);
    });

    it('stops while the dashboard is archived or trashed, and resumes on restore', async () => {
      const { token } = await createShare();
      for (const to of ['archived', 'trash'] as const) {
        await ctx.container.dashboards.changeLifecycle({
          tenantId,
          dashboardId,
          to,
          actorUserId: editorId,
        });
        expect((await publicGet('/public/share', token)).json().state, to).toBe('unavailable');
        await ctx.container.dashboards.changeLifecycle({
          tenantId,
          dashboardId,
          to: 'restore',
          actorUserId: editorId,
        });
      }
      expect((await publicGet('/public/share', token)).json().state).toBe('available');
    });

    it('stops while the tenant is suspended', async () => {
      const { token } = await createShare();
      await ctx.container.tenants.changeLifecycle(tenantId, 'suspended');
      expect((await publicGet('/public/share', token)).json().state).toBe('unavailable');
      await ctx.container.tenants.changeLifecycle(tenantId, 'active');
      expect((await publicGet('/public/share', token)).json().state).toBe('available');
    });

    it('never outlives its creator’s access', async () => {
      const { token } = await createShare();
      await ctx.container.users.deactivate(editorId);
      expect((await publicGet('/public/share', token)).json().state).toBe('unavailable');
      const [listed] = await ctx.container.shares.list(tenantId, dashboardId);
      expect(listed).toMatchObject({
        status: 'unavailable',
        unavailableReason: 'creator_lost_access',
      });
    });

    it('asks for a password, pauses after repeated wrong ones, and opens with the right one', async () => {
      const password = 'Sommerfest-Lageplan-2026';
      const { token } = await createShare({ password });

      expect((await publicGet('/public/share', token)).json()).toEqual({
        state: 'password_required',
      });
      expect((await publicGet('/public/share/layout', token)).statusCode).toBe(401);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await unlock(token, 'falsch-falsch-falsch')).statusCode).toBe(422);
      }
      // Paused now - even the right password waits.
      expect((await unlock(token, password)).statusCode).toBe(429);

      ctx.clock.advance(minutes(16));
      const unlocked = await unlock(token, password);
      expect(unlocked.statusCode).toBe(200);
      const session = unlocked.json().sessionToken as string;

      const layout = await app.inject({
        method: 'GET',
        url: '/public/share/layout',
        headers: { 'x-share-token': token, 'x-share-session': session },
      });
      expect(layout.statusCode).toBe(200);

      const [row] = await ctx.handle.db.select().from(shareSessions);
      expect(JSON.stringify(row)).not.toContain(session);
      const [shareRow] = await ctx.handle.db.select().from(dashboardShares);
      expect(shareRow!.passwordHash).toMatch(/^\$argon2id\$/);
    });
  });

  // --- manual exports --------------------------------------------------------------

  describe('exports', () => {
    it('reproduce the current viewer state, with its scope and period in the file', async () => {
      const state = 'timeRange=last_7_days&comparison=prior_year';
      const tile = (
        await get(`/dashboards/${dashboardId}/widgets/kpi-visits?${state}`, viewer)
      ).json() as WidgetPresentation;
      const onScreen = tile.content?.kind === 'card' ? tile.content.metrics[0]! : undefined;

      const created = await post(`/dashboards/${dashboardId}/exports`, viewer, {
        format: 'xlsx',
        timeRange: 'last_7_days',
        comparison: 'prior_year',
      });
      expect(created.statusCode).toBe(201);
      const artifact = created.json();
      expect(artifact.fileName).toMatch(/\.xlsx$/);

      const file = await get(`/exports/${artifact.id}`, viewer);
      expect(file.statusCode).toBe(200);
      expect(file.headers['cache-control']).toBe('no-store');
      expect(file.headers['content-disposition']).toContain('attachment');

      const sheets = await xlsxSheets(file.rawPayload);
      const overview = sheets.get('Übersicht')!;
      const period = overview.find((row) => row[0] === 'Zeitraum')![1] as string;
      const comparison = overview.find((row) => row[0] === 'Vergleich')![1] as string;
      expect(period).toMatch(/^Letzte 7 Tage \(11\.09\.2026 – 17\.09\.2026\)$/);
      expect(comparison).toMatch(/^Vorjahreszeitraum \(11\.09\.2025 – 17\.09\.2025\)$/);
      expect(overview.find((row) => row[0] === 'Site')![1]).toBe(
        tile.freshness ? 'Employee Portal Demo Site' : expect.any(String),
      );
      expect(overview.find((row) => row[0] === 'Version')![1]).toBe('Veröffentlichte Version 2');

      // The same number the screen showed for the same state.
      const metrics = sheets.get('Kennzahlen')!;
      const visits = metrics.find((row) => row[0] === 'Besuche')!;
      expect(visits[2]).toBe(
        onScreen!.value.state === 'ready' ? onScreen!.value.value : expect.anything(),
      );

      // And the internal notes stayed inside the product.
      const text = JSON.stringify([...sheets.values()]);
      for (const marker of MARKERS) expect(text).not.toContain(marker);
    });

    it('write one widget as CSV, and refuse CSV without a widget', async () => {
      expect(
        (await post(`/dashboards/${dashboardId}/exports`, viewer, { format: 'csv' })).statusCode,
      ).toBe(422);
      const created = await post(`/dashboards/${dashboardId}/exports`, viewer, {
        format: 'csv',
        widgetId: 'kpi-pageviews',
      });
      expect(created.statusCode).toBe(201);
      const file = await get(`/exports/${created.json().id}`, viewer);
      const rows = csvRows(file.rawPayload, ';');
      expect(rows).toContainEqual(['Widget', 'Seitenaufrufe']);
      expect(rows.find((row) => row[0] === 'Zeitraum')?.[1]).toMatch(/^Letzte 30 Tage/);
    });

    it('produce all dashboard formats, readable', async () => {
      for (const format of ['pdf', 'pptx'] as const) {
        const created = await post(`/dashboards/${dashboardId}/exports`, viewer, { format });
        expect(created.statusCode, format).toBe(201);
        const file = await get(`/exports/${created.json().id}`, viewer);
        const text = await readableText(format, file.rawPayload);
        expect(text, format).toContain('Letzte 30 Tage');
        expect(text, format).toContain('Besuche');
      }
    }, 60_000);

    it('are readable only by whoever asked for them', async () => {
      const artifact = (
        await post(`/dashboards/${dashboardId}/exports`, viewer, { format: 'pdf' })
      ).json();
      expect((await get(`/exports/${artifact.id}`, editor)).statusCode).toBe(404);
      expect((await get(`/exports/${artifact.id}`, outsider)).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/exports/${artifact.id}` })).statusCode).toBe(
        401,
      );
      expect((await get(`/exports/${artifact.id}`, viewer)).statusCode).toBe(200);
    });

    it('need the export right and a grant on the dashboard', async () => {
      expect(
        (await post(`/dashboards/${dashboardId}/exports`, outsider, { format: 'pdf' })).statusCode,
      ).toBe(403);
    });

    it('are short-lived: gone after expiry, file and record', async () => {
      const artifact = (
        await post(`/dashboards/${dashboardId}/exports`, viewer, { format: 'pdf' })
      ).json();
      const [row] = await ctx.handle.db.select().from(exportArtifacts);
      const file = path.join(ctx.config.exports.artifactDir, row!.storageKey);
      expect(await readdir(ctx.config.exports.artifactDir)).toContain(row!.storageKey);

      ctx.clock.advance(minutes(ctx.config.exports.artifactTtlMinutes) + 1);
      expect((await get(`/exports/${artifact.id}`, viewer)).statusCode).toBe(404);

      await ctx.container.exports.purgeExpired();
      expect(await ctx.handle.db.select().from(exportArtifacts)).toHaveLength(0);
      await expect(readFile(file)).rejects.toThrow();
    });

    it('keep no analytics values in the database, and only ciphertext on disk', async () => {
      const artifact = (
        await post(`/dashboards/${dashboardId}/exports`, viewer, {
          format: 'csv',
          widgetId: 'kpi-visits',
        })
      ).json();
      const plain = (await get(`/exports/${artifact.id}`, viewer)).rawPayload;
      const [row] = await ctx.handle.db.select().from(exportArtifacts);
      expect(Object.keys(row!).sort()).toEqual(
        [
          'byteSize',
          'createdAt',
          'dashboardId',
          'downloadCount',
          'expiresAt',
          'fileName',
          'format',
          'id',
          'requestedByUserId',
          'shareId',
          'storageKey',
          'tenantId',
        ].sort(),
      );
      const onDisk = await readFile(path.join(ctx.config.exports.artifactDir, row!.storageKey));
      expect(onDisk.includes(Buffer.from('Zeitraum'))).toBe(false);
      expect(onDisk.includes(plain.subarray(3, 40))).toBe(false);
    });

    it('are audited without their content', async () => {
      await post(`/dashboards/${dashboardId}/exports`, viewer, {
        format: 'pdf',
        timeRange: 'last_7_days',
      });
      const [event] = await ctx.handle.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, 'export.created'));
      expect(event!.metadata).toMatchObject({
        format: 'pdf',
        timeRange: 'last_7_days',
        via: 'user',
      });
    });
  });

  // --- helpers ---------------------------------------------------------------------

  const RIGHTS_NONE = { timeRange: false, comparison: false, detail: false, export: false };
  const RIGHTS_ALL = { timeRange: true, comparison: true, detail: true, export: true };

  function shareBody(overrides: Record<string, unknown> = {}) {
    return { label: 'Vorstand', expiresOn: '2026-10-15', rights: RIGHTS_NONE, ...overrides };
  }

  async function createShare(overrides: Record<string, unknown> = {}): Promise<ShareCreated> {
    const response = await post(`/dashboards/${dashboardId}/shares`, editor, shareBody(overrides));
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }

  function publicGet(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { 'x-share-token': token } });
  }

  function unlock(token: string, password: string) {
    return app.inject({
      method: 'POST',
      url: '/public/share/unlock',
      headers: { 'x-share-token': token },
      payload: { password },
    });
  }

  async function publicExport(token: string, body: Record<string, unknown>): Promise<Buffer> {
    const created = await app.inject({
      method: 'POST',
      url: '/public/share/exports',
      headers: { 'x-share-token': token },
      payload: body,
    });
    expect(created.statusCode, created.body).toBe(201);
    const file = await publicGet(`/public/share/exports/${created.json().id}`, token);
    expect(file.statusCode).toBe(200);
    return file.rawPayload;
  }

  async function readableText(format: 'pdf' | 'xlsx' | 'pptx', file: Buffer): Promise<string> {
    if (format === 'pdf') return (await pdfText(file)).join('\n');
    if (format === 'xlsx') return JSON.stringify([...(await xlsxSheets(file)).values()]);
    return (await pptxSlides(file))
      .map((slide) => [...slide.texts, ...slide.altTexts, slide.notes].join(' '))
      .join('\n');
  }

  async function editDraft(change: (snapshot: DashboardSnapshot) => DashboardSnapshot) {
    const draft = await ctx.container.dashboards.getDraft(tenantId, dashboardId, editorId);
    await ctx.container.dashboards.saveDraft({
      tenantId,
      dashboardId,
      expectedRevisionId: draft.revisionId,
      snapshot: change(draft.snapshot),
      actorUserId: editorId,
    });
  }

  async function user(email: string, role: 'viewer' | 'dashboard_editor') {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: email.split('@')[0]!,
      lastName: 'Tester',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role,
      scopeType: 'project',
      scopeId: projectId,
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

  function post(url: string, token: string, payload: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as object,
    });
  }
});
