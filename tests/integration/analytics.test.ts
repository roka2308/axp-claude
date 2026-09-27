import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { sql } from 'drizzle-orm';
import {
  type DashboardPresentation,
  type DashboardSnapshot,
  hasNumericValue,
  type WidgetPresentation,
} from '@axp/contracts';
import { matomoConnections } from '@axp/db';
import { seedReferenceDashboard } from '@axp/fixtures';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  listTables,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  grantProjectAccess,
  type TestContext,
} from './harness';

/**
 * First Vertical Slice acceptance (Master Spec §27, Gate F1).
 *
 * Everything here runs through `app.inject()` against real MySQL, because the
 * properties being checked are properties of the whole path - authorization,
 * calendar, sealing, persistence - and none of them survives being mocked.
 *
 * The scenario is the canonical fixture twice over: two tenants, each with a
 * project and a published `Portal Overview`, so a cross-tenant attempt has a
 * real target on the other side rather than a missing row.
 */
describe('analytics slice', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  /** The Matomo token the test creates connections with. Must never come back. */
  const MATOMO_TOKEN = 'integration-test-matomo-token-8f2a41c7';

  interface Tenancy {
    readonly tenantId: string;
    readonly projectId: string;
    readonly dashboardId: string;
    readonly siteId: string;
    readonly connectionId: string;
  }

  let tenantA: Tenancy;
  let tenantB: Tenancy;
  let editorA: string;
  let viewerA: string;
  let editorB: string;
  let adminA: string;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();

    tenantA = await provisionTenant('a');
    tenantB = await provisionTenant('b');

    editorA = await signIn(
      await userWith('editor.a@example.invalid', 'dashboard_editor', 'project', tenantA.projectId),
    );
    viewerA = await signIn(
      await userWith('viewer.a@example.invalid', 'viewer', 'project', tenantA.projectId),
    );
    adminA = await signIn(
      await userWith('admin.a@example.invalid', 'tenant_admin', 'tenant', tenantA.tenantId),
    );
    editorB = await signIn(
      await userWith('editor.b@example.invalid', 'dashboard_editor', 'project', tenantB.projectId),
    );
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- scenario -----------------------------------------------------------

  async function provisionTenant(suffix: string): Promise<Tenancy> {
    const { tenantId } = await ctx.container.tenants.createTenant({
      portableId: `demo.tenant-${suffix}`,
      name: `Tenant ${suffix.toUpperCase()}`,
      slug: `tenant-${suffix}`,
    });
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');

    const { projectId } = await ctx.container.tenants.createProject({
      tenantId,
      portableId: `demo.project-${suffix}`,
      name: `Portal ${suffix.toUpperCase()}`,
      slug: `portal-${suffix}`,
    });

    const { userId } = await ctx.container.users.createLocalUser({
      email: `seeder.${suffix}@example.invalid`,
      firstName: 'Seed',
      lastName: 'User',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });

    const seeded = await seedReferenceDashboard(ctx.container, {
      tenantId,
      projectId,
      actorUserId: userId,
    });

    return { tenantId, projectId, ...seeded };
  }

  async function userWith(
    email: string,
    role: 'viewer' | 'dashboard_editor' | 'tenant_admin' | 'platform_admin',
    scopeType: 'platform' | 'tenant' | 'project',
    scopeId: string,
  ): Promise<string> {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: 'Test',
      lastName: 'User',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role,
      scopeType,
      scopeId,
    });
    // A role opens no data; the grant is what a group would give (ADR 0006).
    if (scopeType === 'project' && (role === 'viewer' || role === 'dashboard_editor')) {
      await grantProjectAccess(ctx, userId, scopeId, role === 'viewer' ? 'view' : 'edit');
    }
    return email;
  }

  async function signIn(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: STRONG_TEST_PASSWORD },
    });
    expect(response.statusCode, `sign-in for ${email}`).toBe(200);
    return response.json().token as string;
  }

  function as(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function presentation(
    token: string,
    dashboardId: string,
    query: Record<string, string> = {},
  ) {
    const search = new URLSearchParams(query).toString();
    return app.inject({
      method: 'GET',
      url: `/dashboards/${dashboardId}/presentation${search ? `?${search}` : ''}`,
      headers: as(token),
    });
  }

  // --- cross-tenant isolation ---------------------------------------------

  describe('cross-tenant isolation', () => {
    it('refuses a dashboard of another tenant even with a valid session and a real id', async () => {
      // The id exists and is correct - only the caller is wrong. This is the
      // case a client-side check would miss (Shared Contract §4).
      const response = await presentation(editorB, tenantA.dashboardId);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { category: 'permission_denied' } });
      // The refusal must not leak what is on the other side.
      expect(JSON.stringify(response.json())).not.toContain('Portal Overview');
    });

    it('refuses the draft of another tenant', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/dashboards/${tenantA.dashboardId}/draft`,
        headers: as(editorB),
      });
      expect(response.statusCode).toBe(403);
    });

    it('lists only the caller’s own dashboards', async () => {
      const own = await app.inject({
        method: 'GET',
        url: `/projects/${tenantB.projectId}/dashboards`,
        headers: as(editorB),
      });
      expect(own.statusCode).toBe(200);
      expect(own.json().dashboards).toHaveLength(1);
      expect(own.json().dashboards[0].id).toBe(tenantB.dashboardId);

      const foreign = await app.inject({
        method: 'GET',
        url: `/projects/${tenantA.projectId}/dashboards`,
        headers: as(editorB),
      });
      expect(foreign.statusCode).toBe(403);
    });

    it('does not let a site of one tenant be attached to a dashboard of another', async () => {
      // A cross-tenant site id in a draft is the subtle version of the same
      // attack: the dashboard is the caller’s, the data source is not.
      const draft = await app.inject({
        method: 'GET',
        url: `/dashboards/${tenantB.dashboardId}/draft`,
        headers: as(editorB),
      });
      const body = draft.json();

      const response = await app.inject({
        method: 'PUT',
        url: `/dashboards/${tenantB.dashboardId}/draft`,
        headers: as(editorB),
        payload: {
          expectedRevisionId: body.revisionId,
          snapshot: { ...body.snapshot, siteId: tenantA.siteId },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'site_not_assigned' } });
    });

    it('separates analytics answers per permission context', async () => {
      // Two callers with different effective access must not share a cache
      // entry, even though the query is byte-identical.
      const first = await presentation(editorA, tenantA.dashboardId);
      const second = await presentation(viewerA, tenantA.dashboardId);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // Same numbers - they are entitled to the same data...
      expect(numbersOf(first.json())).toEqual(numbersOf(second.json()));
      // ...but the viewer’s first request was a miss, not the editor’s hit.
      expect(cacheFlags(second.json()).every((fromCache) => fromCache === false)).toBe(true);
    });
  });

  // --- what the UI may offer ----------------------------------------------

  describe('granted capabilities', () => {
    it('tells each caller what they may do here, and nothing more', async () => {
      // The web app hides what it is not offered. It must never be offered an
      // action the server would then refuse (Shared Contract §4).
      const capabilitiesFor = async (token: string) => {
        const response = await app.inject({
          method: 'GET',
          url: `/projects/${tenantA.projectId}`,
          headers: as(token),
        });
        expect(response.statusCode).toBe(200);
        return response.json().capabilities as string[];
      };

      const viewer = await capabilitiesFor(viewerA);
      expect(viewer).toContain('dashboard.read_published');
      expect(viewer).not.toContain('dashboard.create');
      expect(viewer).not.toContain('dashboard.publish');
      expect(viewer).not.toContain('tenant.settings.update');

      const editor = await capabilitiesFor(editorA);
      expect(editor).toEqual(
        expect.arrayContaining(['dashboard.create', 'dashboard.edit_draft', 'dashboard.publish']),
      );
      expect(editor).not.toContain('tenant.settings.update');

      // A tenant admin administers; it does not read dashboards. Roles are
      // additive, not hierarchical (Master Spec §7).
      const admin = await capabilitiesFor(adminA);
      expect(admin).toContain('project.settings.update');
      expect(admin).toContain('tenant.settings.update');
      expect(admin).not.toContain('dashboard.read_published');
      expect(admin).not.toContain('dashboard.create');
    });

    it('matches what the write routes actually enforce', async () => {
      // The list is only trustworthy if it predicts the answer. A viewer is
      // offered no publish, and publishing is refused.
      const viewer = (
        await app.inject({
          method: 'GET',
          url: `/projects/${tenantA.projectId}`,
          headers: as(viewerA),
        })
      ).json().capabilities as string[];
      expect(viewer).not.toContain('dashboard.publish');

      const refused = await app.inject({
        method: 'POST',
        url: `/dashboards/${tenantA.dashboardId}/publish`,
        headers: as(viewerA),
      });
      expect(refused.statusCode).toBe(403);
    });
  });

  // --- credentials ---------------------------------------------------------

  describe('credentials', () => {
    it('never returns the Matomo token on any route that touches a connection', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/tenants/${tenantA.tenantId}/matomo-connections`,
        headers: as(adminA),
        payload: { name: 'Second Matomo', baseUrl: 'mock://default', token: MATOMO_TOKEN },
      });
      expect(created.statusCode).toBe(201);

      const connectionId = created.json().connection.id as string;
      const base = `/tenants/${tenantA.tenantId}/matomo-connections`;
      const responses: [string, { payload: string }][] = [
        ['create', created],
        ['list', await app.inject({ method: 'GET', url: base, headers: as(adminA) })],
        [
          'sites',
          await app.inject({
            method: 'GET',
            url: `${base}/${connectionId}/sites`,
            headers: as(adminA),
          }),
        ],
        [
          'refresh-capabilities',
          await app.inject({
            method: 'POST',
            url: `${base}/${connectionId}/refresh-capabilities`,
            headers: as(adminA),
          }),
        ],
        ['presentation', await presentation(editorA, tenantA.dashboardId)],
      ];

      for (const [label, response] of responses) {
        expect(response.payload, label).not.toContain(MATOMO_TOKEN);
        expect(response.payload, label).not.toMatch(/token_auth/i);
      }

      // The connection is still usable, so the absence is sealing and not loss.
      expect(created.json().connection).toMatchObject({ hasCredential: true });
      expect(created.json().connection.token).toBeUndefined();
    });

    it('stores the token only as ciphertext', async () => {
      await app.inject({
        method: 'POST',
        url: `/tenants/${tenantA.tenantId}/matomo-connections`,
        headers: as(adminA),
        payload: { name: 'Sealed Matomo', baseUrl: 'mock://default', token: MATOMO_TOKEN },
      });

      const rows = await ctx.container.db.select().from(matomoConnections);
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(MATOMO_TOKEN);

      // And it is genuinely encrypted, not merely encoded.
      const sealed = rows.find((row) => row.name === 'Sealed Matomo')!;
      expect(Buffer.from(sealed.credentialCiphertext, 'base64').toString('utf8')).not.toContain(
        MATOMO_TOKEN,
      );
      expect(sealed.credentialNonce).toBeTruthy();
    });

    it('offers no route that reads a credential back', async () => {
      // A "reveal" endpoint is the failure mode this guards against: the
      // product replaces a lost token, it never shows one (Master Spec §19).
      for (const url of [
        `/tenants/${tenantA.tenantId}/matomo-connections/${tenantA.connectionId}`,
        `/tenants/${tenantA.tenantId}/matomo-connections/${tenantA.connectionId}/credential`,
        `/tenants/${tenantA.tenantId}/matomo-connections/${tenantA.connectionId}/token`,
      ]) {
        const response = await app.inject({ method: 'GET', url, headers: as(adminA) });
        expect(response.statusCode, url).toBe(404);
      }
    });

    it('keeps the credential out of the audit trail', async () => {
      await app.inject({
        method: 'POST',
        url: `/tenants/${tenantA.tenantId}/matomo-connections`,
        headers: as(adminA),
        payload: { name: 'Audited Matomo', baseUrl: 'mock://default', token: MATOMO_TOKEN },
      });

      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>('SELECT * FROM audit_events');
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(MATOMO_TOKEN);
    });
  });

  // --- the persistence rule, behaviourally --------------------------------

  describe('analytics results never reach MySQL', () => {
    it('writes no row at all while rendering dashboards', async () => {
      const before = await rowCounts();

      for (const preset of ['last_7_days', 'last_30_days', 'previous_month']) {
        const response = await presentation(editorA, tenantA.dashboardId, { timeRange: preset });
        expect(response.statusCode).toBe(200);
      }

      // Reading analytics is a read everywhere: no cache table, no audit row,
      // no bookkeeping (Master Spec §4).
      expect(await rowCounts()).toEqual(before);
    });

    it('leaves no measured value anywhere in the product store', async () => {
      const response = await presentation(editorA, tenantA.dashboardId);
      const body = response.json() as DashboardPresentation;

      // Only values large enough that a coincidence with a configuration number
      // (a column width, a version, a row limit) would itself be suspicious.
      const measured = new Set(numbersOf(body).filter((value) => Math.abs(value) >= 100));
      expect(measured.size, 'the fixture must produce values worth searching for').toBeGreaterThan(
        3,
      );

      // Compared as numbers, not as substrings: `920` occurs inside plenty of
      // UUIDs, and a false positive here would make the rule unenforceable.
      const stored = await numbersInDatabase();
      for (const value of measured) {
        expect([...stored], `measured value ${value} stored in MySQL`).not.toContain(value);
      }

      // Dimension labels are analytics results too, and just as identifying.
      const labels = labelsOf(body);
      expect(labels.length).toBeGreaterThan(3);
      const dump = await dumpDatabase();
      for (const label of labels) {
        expect(dump, `dimension label ${label} found in MySQL`).not.toContain(label);
      }
    });
  });

  // --- the analytics calendar ---------------------------------------------

  describe('comparison', () => {
    it('resolves the range in the Matomo site time zone', async () => {
      const body = (await presentation(editorA, tenantA.dashboardId)).json();

      // The fixture site is Europe/Berlin; the clock is 2026-09-18T10:00Z.
      expect(body.dataScope.siteTimezone).toBe('Europe/Berlin');
      expect(body.timeRange).toMatchObject({
        preset: 'last_30_days',
        from: '2026-08-19',
        to: '2026-09-17',
      });
    });

    it('compares against an equally long period that ends the day before', async () => {
      const body = (
        await presentation(editorA, tenantA.dashboardId, {
          timeRange: 'last_30_days',
          comparison: 'previous_period',
        })
      ).json();

      expect(body.comparison).toMatchObject({
        mode: 'previous_period',
        from: '2026-07-20',
        to: '2026-08-18',
      });
      expect(days(body.comparison.from, body.comparison.to)).toBe(
        days(body.timeRange.from, body.timeRange.to),
      );
    });

    it('shifts by a calendar year for the prior-year comparison', async () => {
      const body = (
        await presentation(editorA, tenantA.dashboardId, {
          timeRange: 'last_30_days',
          comparison: 'prior_year',
        })
      ).json();

      expect(body.comparison).toMatchObject({ from: '2025-08-19', to: '2025-09-17' });
    });

    it('derives change and ratio from the two values it actually returned', async () => {
      const body = (await presentation(editorA, tenantA.dashboardId)).json();
      const card = widget(body, 'kpi-visits');

      expect(card.state).toBe('ready');
      const metric = cardOf(card).metrics[0]!;
      const comparison = metric.comparison!;

      // Both sides must be numbers before a ratio means anything at all.
      if (!hasNumericValue(metric.value)) throw new Error('KPI carried no number.');
      if (!hasNumericValue(comparison.value)) throw new Error('Baseline carried no number.');

      expect(comparison.change).toBeCloseTo(metric.value.value - comparison.value.value, 6);
      expect(comparison.changeRatio).toBeCloseTo(comparison.change! / comparison.value.value, 6);
      expect(comparison.baselineZero).toBeUndefined();
    });

    it('omits the comparison entirely when none was asked for', async () => {
      const body = (
        await presentation(editorA, tenantA.dashboardId, { comparison: 'none' })
      ).json();

      expect(body.comparison).toBeUndefined();
      expect(cardOf(widget(body, 'kpi-visits')).metrics[0]!.comparison).toBeUndefined();
    });

    it('aligns the comparison series with the primary one, point for point', async () => {
      const body = (await presentation(editorA, tenantA.dashboardId)).json();
      const series = seriesOf(widget(body, 'series-visits')).series[0]!;

      expect(series.points).toHaveLength(30);
      expect(series.comparisonPoints).toHaveLength(30);
      // Aligned by position: point n of the comparison is the day that
      // corresponds to point n of the range, not the same calendar date.
      expect(series.comparisonPoints![0]!.date).toBe(addDays(series.points[0]!.date, -30));
    });
  });

  // --- publishing ----------------------------------------------------------

  describe('published versions are immutable', () => {
    it('keeps the published dashboard unchanged while the draft is edited', async () => {
      const before = (await presentation(viewerA, tenantA.dashboardId)).json();
      expect(before.dashboard.publishedVersion).toBe(1);

      // Edit the draft: rename a widget and remove the ranking entirely.
      const draft = (
        await app.inject({
          method: 'GET',
          url: `/dashboards/${tenantA.dashboardId}/draft`,
          headers: as(editorA),
        })
      ).json();

      const edited: DashboardSnapshot = {
        ...draft.snapshot,
        name: 'Portal Overview (in Arbeit)',
        widgets: draft.snapshot.widgets
          .filter((w: { id: string }) => w.id !== 'table-top-pages')
          .map((w: { id: string; title: string }) =>
            w.id === 'kpi-visits' ? { ...w, title: 'Besuche NEU' } : w,
          ),
      };

      const saved = await app.inject({
        method: 'PUT',
        url: `/dashboards/${tenantA.dashboardId}/draft`,
        headers: as(editorA),
        payload: { expectedRevisionId: draft.revisionId, snapshot: edited },
      });
      expect(saved.statusCode).toBe(200);

      // The viewer still sees version 1, untouched.
      const after = (await presentation(viewerA, tenantA.dashboardId)).json();
      expect(after.dashboard.publishedVersion).toBe(1);
      expect(after.dashboard.name).toBe('Portal Overview');
      expect(after.widgets.map((w: WidgetPresentation) => w.widgetId)).toEqual(
        before.widgets.map((w: WidgetPresentation) => w.widgetId),
      );
      expect(widget(after, 'kpi-visits').title).toBe('Besuche');

      // The editor previewing the draft sees the change, through the same builder.
      const preview = (
        await presentation(editorA, tenantA.dashboardId, { source: 'draft' })
      ).json();
      expect(preview.dashboard.isDraftPreview).toBe(true);
      expect(preview.dashboard.publishedVersion).toBeNull();
      expect(widget(preview, 'kpi-visits').title).toBe('Besuche NEU');
      expect(preview.widgets).toHaveLength(3);
    });

    it('rejects a stale draft write instead of overwriting it', async () => {
      const draft = (
        await app.inject({
          method: 'GET',
          url: `/dashboards/${tenantA.dashboardId}/draft`,
          headers: as(editorA),
        })
      ).json();

      const write = () =>
        app.inject({
          method: 'PUT',
          url: `/dashboards/${tenantA.dashboardId}/draft`,
          headers: as(editorA),
          payload: { expectedRevisionId: draft.revisionId, snapshot: draft.snapshot },
        });

      expect((await write()).statusCode).toBe(200);
      // The second write still presents the revision it read first.
      const stale = await write();
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { category: 'conflict' } });
    });

    it('creates a new version on publish and leaves the old one intact', async () => {
      const draft = (
        await app.inject({
          method: 'GET',
          url: `/dashboards/${tenantA.dashboardId}/draft`,
          headers: as(editorA),
        })
      ).json();

      await app.inject({
        method: 'PUT',
        url: `/dashboards/${tenantA.dashboardId}/draft`,
        headers: as(editorA),
        payload: {
          expectedRevisionId: draft.revisionId,
          snapshot: { ...draft.snapshot, name: 'Portal Overview v2' },
        },
      });

      const published = await app.inject({
        method: 'POST',
        url: `/dashboards/${tenantA.dashboardId}/publish`,
        headers: as(editorA),
      });
      expect(published.statusCode).toBe(200);
      expect(published.json().version).toBe(2);

      const [versions] = await ctx.handle.pool.query<RowDataPacket[]>(
        'SELECT version, snapshot FROM dashboard_versions WHERE dashboard_id = ? ORDER BY version',
        [tenantA.dashboardId],
      );
      expect(versions.map((row) => row.version)).toEqual([1, 2]);
      // Version 1 still carries the name it was published with.
      expect(asSnapshot(versions[0]!.snapshot).name).toBe('Portal Overview');
      expect(asSnapshot(versions[1]!.snapshot).name).toBe('Portal Overview v2');
    });

    it('pins the semantic versions a published snapshot was built on', async () => {
      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(
        'SELECT pinned_semantic_version_ids FROM dashboard_versions WHERE dashboard_id = ?',
        [tenantA.dashboardId],
      );
      const pinned = asIds(rows[0]!.pinned_semantic_version_ids);
      expect(pinned.length).toBeGreaterThan(0);
      for (const id of pinned) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses to publish for a caller who may only view', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/dashboards/${tenantA.dashboardId}/publish`,
        headers: as(viewerA),
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // --- capability-driven status -------------------------------------------

  describe('capability-driven status', () => {
    it('records what an installation can do, derived from probes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/tenants/${tenantA.tenantId}/matomo-connections`,
        headers: as(adminA),
      });

      const connection = response.json().connections[0];
      expect(connection.capabilities.compatibility).toBe('supported');
      expect(connection.capabilities.probes.length).toBeGreaterThan(0);
      // Compatibility is a conclusion about capabilities, not about a version
      // string - the version travels alongside it, not instead of it (G3).
      expect(connection.capabilities.matomoVersion).toBeTruthy();
    });

    it('reports a limitation rather than failing the whole connection', async () => {
      const limited = await connectionWith('mock://limited', 'Limited Matomo');
      expect(limited.compatibility).toBe('supported_with_limitations');
      expect(limited.limitationKeys.length).toBeGreaterThan(0);
    });

    it('fails only the widget a missing capability affects', async () => {
      const dashboardId = await dashboardOn('mock://limited', 'Limited Portal');
      const body = (await presentation(editorA, dashboardId, {})).json();

      // The ranking needs the capability that is missing. `missing` rather than
      // `unavailable`: the source is up, it simply cannot answer this question,
      // and the cause state is what keeps the two apart (D10).
      const table = widget(body, 'table-top-pages');
      expect(table.state).toBe('missing');
      expect(table.unavailable.causeState).toBe('capability_unsupported');
      expect(table.unavailable.actionKey).toBeTruthy();

      // ...the scalar and series widgets on the same connection still render.
      for (const id of ['kpi-visits', 'kpi-pageviews', 'series-visits']) {
        expect(widget(body, id).state, id).toBe('ready');
      }
    });

    it('renders the dashboard even when every widget fails', async () => {
      const dashboardId = await dashboardOn('mock://default', 'Offline Portal');
      // The installation was reachable at setup time and has gone down since.
      await ctx.container.db.execute(
        sql`UPDATE matomo_connections SET base_url = 'mock://unavailable' WHERE name = 'Offline Portal'`,
      );
      ctx.container.analyticsCache.clear();

      const response = await presentation(editorA, dashboardId);
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.widgets).toHaveLength(4);
      for (const w of body.widgets as WidgetPresentation[]) {
        expect(w.state, w.widgetId).toBe('unavailable');
        expect(w.unavailable!.causeState, w.widgetId).toBe('temporarily_unavailable');
      }
      // The frame is intact: a failed source is not a broken dashboard (§11).
      expect(body.dashboard.name).toBe('Offline Portal');
      expect(body.dataScope.siteName).toBeTruthy();
    });

    it('distinguishes a measured zero from an empty result', async () => {
      const zero = (
        await presentation(editorA, await dashboardOn('mock://zero', 'Zero Portal'))
      ).json();
      const empty = (
        await presentation(editorA, await dashboardOn('mock://empty', 'Empty Portal'))
      ).json();

      // A measured zero is a value, and it is rendered as one.
      const zeroMetric = metricOf(widget(zero, 'kpi-visits'));
      expect(zeroMetric.value.state).toBe('zero');
      expect(zeroMetric.formatted).toMatch(/0/);

      // An empty result is not zero and must not be formatted as a number.
      const emptyMetric = metricOf(widget(empty, 'kpi-visits'));
      expect(emptyMetric.value.state).toBe('empty');
      expect(emptyMetric.formatted).not.toMatch(/\d/);
    });
  });

  // --- helpers -------------------------------------------------------------

  /** Creates a connection on a mock scenario and returns its capabilities. */
  async function connectionWith(baseUrl: string, name: string) {
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantA.tenantId}/matomo-connections`,
      headers: as(adminA),
      payload: { name, baseUrl, token: MATOMO_TOKEN },
    });
    expect(created.statusCode, `creating ${name}`).toBe(201);
    return created.json().capabilities;
  }

  /**
   * A second published dashboard of tenant A, reading from its own connection.
   *
   * Goes through the services rather than the API because the point of these
   * cases is the scenario behind the connection, not the authoring routes.
   */
  async function dashboardOn(baseUrl: string, name: string): Promise<string> {
    const [seeders] = await ctx.handle.pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE email = ?',
      ['seeder.a@example.invalid'],
    );
    const actorUserId = String(seeders[0]!.id);

    const connection = await ctx.container.matomo.createConnection({
      tenantId: tenantA.tenantId,
      name,
      baseUrl,
      token: MATOMO_TOKEN,
      actorUserId,
    });
    await ctx.container.matomo.refreshCapabilities(tenantA.tenantId, connection.id, actorUserId);

    const { siteId } = await ctx.container.matomo.importSite(
      tenantA.tenantId,
      connection.id,
      1,
      actorUserId,
    );
    await ctx.container.matomo.assignSiteToProject(
      tenantA.tenantId,
      tenantA.projectId,
      siteId,
      actorUserId,
    );

    const template = await ctx.container.dashboards.getDraft(tenantA.tenantId, tenantA.dashboardId);
    const draft = await ctx.container.dashboards.createDashboard({
      tenantId: tenantA.tenantId,
      projectId: tenantA.projectId,
      siteId,
      name,
      actorUserId,
    });

    await ctx.container.dashboards.saveDraft({
      tenantId: tenantA.tenantId,
      dashboardId: draft.dashboardId,
      expectedRevisionId: draft.revisionId,
      snapshot: { ...template.snapshot, name, siteId },
      actorUserId,
    });
    const published = await ctx.container.dashboards.publish({
      tenantId: tenantA.tenantId,
      dashboardId: draft.dashboardId,
      actorUserId,
    });

    return published.dashboardId;
  }

  /** Every row of every table, as one searchable string. */
  async function dumpDatabase(): Promise<string> {
    const parts: string[] = [];
    for (const table of await listTables()) {
      if (table === '__drizzle_migrations') continue;
      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      parts.push(JSON.stringify(rows));
    }
    return parts.join('\n');
  }

  /** Every number stored anywhere in the product store, JSON columns included. */
  async function numbersInDatabase(): Promise<Set<number>> {
    const found = new Set<number>();
    for (const table of await listTables()) {
      if (table === '__drizzle_migrations') continue;
      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(`SELECT * FROM \`${table}\``);
      walk(rows, (node) => {
        if (typeof node === 'number' && Number.isFinite(node)) found.add(node);
        else if (typeof node === 'string' && /^-?\d+(\.\d+)?$/.test(node)) found.add(Number(node));
      });
    }
    return found;
  }

  async function rowCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of await listTables()) {
      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM \`${table}\``,
      );
      counts[table] = Number(rows[0]!.n);
    }
    return counts;
  }
});

// --- assertions on the presentation model ---------------------------------

function widget(body: { widgets: WidgetPresentation[] }, id: string) {
  const found = body.widgets.find((candidate) => candidate.widgetId === id);
  if (!found) throw new Error(`Widget ${id} missing from the presentation.`);
  return found as WidgetPresentation & { unavailable: { causeState: string; actionKey?: string } };
}

function cardOf(w: WidgetPresentation) {
  if (w.content?.kind !== 'card') throw new Error(`Widget ${w.widgetId} is not a card.`);
  return w.content;
}

function seriesOf(w: WidgetPresentation) {
  if (w.content?.kind !== 'time_series') {
    throw new Error(`Widget ${w.widgetId} is not a time series.`);
  }
  return w.content;
}

function metricOf(w: WidgetPresentation) {
  const metric = cardOf(w).metrics[0];
  if (!metric) throw new Error(`Widget ${w.widgetId} carries no metric.`);
  return metric;
}

/** Calendar-day arithmetic for the alignment assertion. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every measured number in a presentation, wherever it sits. */
function numbersOf(body: unknown): number[] {
  const found: number[] = [];
  walk(body, (node) => {
    if (
      typeof node === 'object' &&
      node !== null &&
      'state' in node &&
      'value' in node &&
      typeof (node as { value: unknown }).value === 'number'
    ) {
      found.push((node as { value: number }).value);
    }
  });
  return found;
}

/** Dimension labels - analytics results just as much as the numbers are. */
function labelsOf(body: unknown): string[] {
  const found: string[] = [];
  walk(body, (node) => {
    if (typeof node === 'object' && node !== null && 'key' in node && 'metrics' in node) {
      const label = (node as { label?: unknown }).label;
      if (typeof label === 'string' && label.length > 2) found.push(label);
    }
  });
  return found;
}

function cacheFlags(body: unknown): boolean[] {
  const found: boolean[] = [];
  walk(body, (node) => {
    if (typeof node === 'object' && node !== null && 'fromCache' in node) {
      found.push(Boolean((node as { fromCache: unknown }).fromCache));
    }
  });
  return found;
}

function walk(node: unknown, visit: (node: unknown) => void): void {
  visit(node);
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (typeof node === 'object' && node !== null) {
    for (const child of Object.values(node)) walk(child, visit);
  }
}

function days(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

function asSnapshot(value: unknown): { name: string } {
  return (typeof value === 'string' ? JSON.parse(value) : value) as { name: string };
}

function asIds(value: unknown): string[] {
  return (typeof value === 'string' ? JSON.parse(value) : value) as string[];
}
