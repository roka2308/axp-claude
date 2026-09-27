import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CORE_NATIVE_METRICS,
  type DashboardSnapshot,
  type WidgetConfig,
  type WidgetDetailPresentation,
  type WidgetPresentation,
} from '@axp/contracts';
import { seedReferenceDashboard, seedStateModelDashboard } from '@axp/fixtures';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  grantProjectAccess,
  type TestContext,
} from './harness';

/**
 * The viewer, the detail view and the state model (D4, D10, Gate F4).
 *
 * What only a real stack can show: that the layout, a tile and a detail view
 * are authorized exactly like the dashboard, that every state of the state
 * model reaches the presentation with its reason intact, and that search and
 * the library never list something the caller could not open.
 */
describe('viewer, detail view and state model', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  let tenantId: string;
  let projectId: string;
  let siteId: string;
  let dashboardId: string;
  let editorId: string;

  let viewer: string;
  let editor: string;
  let outsider: string;

  const VIEW = 'timeRange=last_30_days&comparison=previous_period&breakpoint=desktop';

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();

    tenantId = await tenant('demo.tenant', 'Tenant', 'tenant');
    projectId = await project(tenantId, 'demo.project', 'Portal', 'portal');

    editorId = (await user('editor@example.invalid', 'dashboard_editor', projectId)).userId;
    await user('viewer@example.invalid', 'viewer', projectId);

    const seeded = await seedReferenceDashboard(ctx.container, {
      tenantId,
      projectId,
      actorUserId: editorId,
    });
    dashboardId = seeded.dashboardId;
    siteId = seeded.siteId;

    // A second tenant, with a dashboard whose name nobody in the first may learn.
    const otherTenant = await tenant('other.tenant', 'Other', 'other');
    const otherProject = await project(otherTenant, 'other.project', 'Geheimprojekt', 'geheim');
    const otherEditor = await user('other@example.invalid', 'dashboard_editor', otherProject);
    await seedReferenceDashboard(ctx.container, {
      tenantId: otherTenant,
      projectId: otherProject,
      actorUserId: otherEditor.userId,
    });

    viewer = await signIn('viewer@example.invalid');
    editor = await signIn('editor@example.invalid');
    outsider = await signIn('other@example.invalid');
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- per-widget lifecycle ------------------------------------------------

  describe('widgets load independently', () => {
    it('draws the layout without asking Matomo anything', async () => {
      const response = await get(`/dashboards/${dashboardId}/layout?${VIEW}`, viewer);
      expect(response.statusCode).toBe(200);

      const layout = response.json();
      expect(layout.widgets.map((widget: { widgetId: string }) => widget.widgetId)).toEqual([
        'kpi-visits',
        'kpi-pageviews',
        'series-visits',
        'table-top-pages',
      ]);
      // Shells only: no values, no state. Those belong to each tile.
      expect(layout.widgets[0]).not.toHaveProperty('state');
      expect(layout.widgets[0]).not.toHaveProperty('content');
    });

    it('answers one tile with the same values the whole dashboard shows', async () => {
      const whole = (await get(`/dashboards/${dashboardId}/presentation?${VIEW}`, viewer)).json();
      const tile = (
        await get(`/dashboards/${dashboardId}/widgets/kpi-visits?${VIEW}`, viewer)
      ).json();

      const fromWhole = whole.widgets.find(
        (widget: WidgetPresentation) => widget.widgetId === 'kpi-visits',
      );
      expect(tile.state).toBe('ready');
      expect(tile.content).toEqual(fromWhole.content);
    });

    it('guards a tile and a detail view exactly like the dashboard', async () => {
      for (const path of [
        `/dashboards/${dashboardId}/layout?${VIEW}`,
        `/dashboards/${dashboardId}/widgets/kpi-visits?${VIEW}`,
        `/dashboards/${dashboardId}/widgets/kpi-visits/detail?${VIEW}`,
      ]) {
        const response = await get(path, outsider);
        // Existence is information: another tenant's caller learns nothing.
        expect([403, 404], path).toContain(response.statusCode);
      }
    });

    it('refuses a widget that is not part of the dashboard', async () => {
      const response = await get(`/dashboards/${dashboardId}/widgets/nope?${VIEW}`, viewer);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.messageKey).toBe('widget.not_found');
    });
  });

  // --- the detail view -----------------------------------------------------

  describe('the detail view', () => {
    it('turns a card into a time series and keeps the tile unchanged', async () => {
      const detail = await detailOf('kpi-visits', viewer);
      const tile = (
        await get(`/dashboards/${dashboardId}/widgets/kpi-visits?${VIEW}`, viewer)
      ).json();

      expect(detail.widget.content).toEqual(tile.content);
      expect(detail.visualisation?.kind).toBe('time_series');
      expect(detail.widget.definition?.name).toBe('Besuche');
    });

    it('inherits the time range and comparison of the dashboard', async () => {
      const detail = await detailOf('kpi-visits', viewer, 'last_7_days', 'none');
      const layout = (
        await get(
          `/dashboards/${dashboardId}/layout?timeRange=last_7_days&comparison=none&breakpoint=desktop`,
          viewer,
        )
      ).json();

      expect(detail.timeRange).toEqual(layout.timeRange);
      expect(detail.comparison).toBeUndefined();
    });

    it('offers the breakdown of a table widget', async () => {
      const detail = await detailOf('table-top-pages', viewer);
      expect(detail.breakdown?.dimension).toBe('page_url');
      expect(detail.breakdown?.content.rows.length).toBeGreaterThan(0);
    });

    it('states which actions are possible, rather than offering dead ones', async () => {
      const detail = await detailOf('kpi-visits', viewer);
      const byKind = Object.fromEntries(detail.actions.map((action) => [action.kind, action]));

      expect(byKind.copy_link?.available).toBe(true);
      // A viewer has no catalog access; the reason is stated.
      expect(byKind.open_definition).toMatchObject({
        available: false,
        unavailableKey: 'detail.action.openDefinitionNoAccess',
      });
      expect(byKind.export).toMatchObject({
        available: false,
        unavailableKey: 'detail.action.exportLaterMilestone',
      });
    });

    it('explains how a formula arrived at its value', async () => {
      const visits = await ctx.container.semantics.getActiveVersionByPortableId(
        CORE_NATIVE_METRICS.visits,
      );
      const pageviews = await ctx.container.semantics.getActiveVersionByPortableId(
        CORE_NATIVE_METRICS.pageviews,
      );
      const formula = await ctx.container.semantics.createDefinition({
        tenantId,
        projectId,
        portableId: 'demo.pages-per-visit',
        type: 'formula',
        name: 'Seiten pro Besuch',
        body: {
          kind: 'formula',
          ast: {
            type: 'binary',
            op: '/',
            left: { type: 'reference', semanticVersionId: pageviews!.version.id },
            right: { type: 'reference', semanticVersionId: visits!.version.id },
          },
          unit: 'ratio',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 2,
        },
        actorUserId: editorId,
      });
      await ctx.container.semantics.changeVersionStatus({
        tenantId,
        definitionId: formula.definition.id,
        versionId: formula.version.id,
        to: 'active',
        actorUserId: editorId,
      });

      await addWidget({
        id: 'kpi-ratio',
        family: 'card',
        title: 'Seiten pro Besuch',
        placement: { desktop: { x: 0, y: 8, w: 3, h: 3 } },
        data: { semanticVersionIds: [formula.version.id], fixedFilters: [] },
        presentation: { variant: 'kpi', showComparison: false, decimals: 2 },
        context: { showDefinition: true },
      });

      const detail = await detailOf('kpi-ratio', viewer);
      const labels = (detail.explanation ?? []).map((step) => step.label);

      expect(labels).toEqual(expect.arrayContaining(['Seitenaufrufe', 'Besuche']));
      const result = detail.explanation?.find((step) => step.isResult);
      expect(result?.value.state).toBe('ready');
      expect(result?.formatted).toBe(
        detail.widget.content?.kind === 'card'
          ? detail.widget.content.metrics[0]!.formatted
          : undefined,
      );
    });
  });

  // --- the state model -----------------------------------------------------

  describe('every D10 state reaches the presentation, with its reason', () => {
    it('produces each value state from the fixture', async () => {
      const seeded = await seedStateModelDashboard(ctx.container, {
        tenantId,
        projectId,
        siteId,
        actorUserId: editorId,
      });

      const expected: Record<string, { state: string; reason?: string }> = {
        ready: { state: 'ready' },
        zero: { state: 'zero' },
        empty: { state: 'empty' },
        missing: { state: 'missing', reason: 'widget.missing.no_mapping' },
        unknown: { state: 'unknown', reason: 'matomo.value_unreadable' },
        notTracked: { state: 'not_tracked', reason: 'matomo.not_tracked_here' },
        notApplicable: { state: 'not_applicable', reason: 'matomo.not_applicable_here' },
        unavailable: { state: 'unavailable', reason: 'widget.source_unavailable' },
        warning: { state: 'warning' },
      };

      for (const [name, expectation] of Object.entries(expected)) {
        const tile = (
          await get(`/dashboards/${seeded.dashboardId}/widgets/state-${name}?${VIEW}`, viewer)
        ).json() as WidgetPresentation;

        expect(tile.state, name).toBe(expectation.state);
        if (expectation.reason) {
          expect(tile.stateMessage?.messageKey ?? tile.unavailable?.messageKey, name).toBe(
            expectation.reason,
          );
        }
      }
    });

    it('never renders an absence as a zero', async () => {
      const seeded = await seedStateModelDashboard(ctx.container, {
        tenantId,
        projectId,
        siteId,
        actorUserId: editorId,
      });

      for (const name of ['missing', 'unknown', 'notTracked', 'notApplicable', 'empty']) {
        const tile = (
          await get(`/dashboards/${seeded.dashboardId}/widgets/state-${name}?${VIEW}`, viewer)
        ).json() as WidgetPresentation;

        const formatted =
          tile.content?.kind === 'card'
            ? tile.content.metrics.map((metric) => metric.formatted)
            : [];
        expect(
          formatted.filter((text) => text === '0'),
          name,
        ).toEqual([]);
      }
    });

    it('carries the quality note that makes a warning a warning', async () => {
      const seeded = await seedStateModelDashboard(ctx.container, {
        tenantId,
        projectId,
        siteId,
        actorUserId: editorId,
      });

      const tile = (
        await get(`/dashboards/${seeded.dashboardId}/widgets/state-warning?${VIEW}`, viewer)
      ).json() as WidgetPresentation;

      expect(tile.dataQuality).toEqual([
        { severity: 'warning', messageKey: 'quality.period_partially_processed' },
      ]);
    });

    it('keeps one failing report from affecting its neighbours', async () => {
      const seeded = await seedStateModelDashboard(ctx.container, {
        tenantId,
        projectId,
        siteId,
        actorUserId: editorId,
      });

      // The whole dashboard in one request still answers, with one widget
      // unavailable and the rest intact (Master Spec §11).
      const whole = (
        await get(`/dashboards/${seeded.dashboardId}/presentation?${VIEW}`, viewer)
      ).json();
      const states = Object.fromEntries(
        whole.widgets.map((widget: WidgetPresentation) => [widget.widgetId, widget.state]),
      );
      expect(states['state-unavailable']).toBe('unavailable');
      expect(states['state-ready']).toBe('ready');
    });
  });

  // --- search and library --------------------------------------------------

  describe('product search and the library', () => {
    it('finds projects and dashboards by name, accents folded', async () => {
      const response = await get('/search?q=portal', viewer);
      const titles = response.json().hits.map((hit: { title: string }) => hit.title);
      expect(titles).toEqual(expect.arrayContaining(['Portal', 'Portal Overview']));
    });

    it('never lists another tenant’s objects', async () => {
      const hits = (await get('/search?q=geheim', viewer)).json().hits;
      expect(hits).toEqual([]);
    });

    it('does not show a viewer a dashboard that was never published', async () => {
      await createDraftDashboard('Nur ein Entwurf');

      const forViewer = (await get('/search?q=entwurf', viewer)).json().hits;
      const forEditor = (await get('/search?q=entwurf', editor)).json().hits;
      expect(forViewer).toEqual([]);
      expect(forEditor.map((hit: { title: string }) => hit.title)).toEqual(['Nur ein Entwurf']);

      const library = (await get('/dashboards', viewer)).json().dashboards;
      expect(library.map((entry: { name: string }) => entry.name)).not.toContain('Nur ein Entwurf');
    });

    it('offers definitions only to someone who may read the catalog', async () => {
      const forViewer = (await get('/search?q=besuche', viewer)).json().hits;
      expect(forViewer.some((hit: { kind: string }) => hit.kind === 'definition')).toBe(false);
    });

    it('never returns a measurement', async () => {
      const hits = (await get('/search?q=portal', viewer)).json().hits;
      for (const hit of hits) {
        expect(Object.keys(hit).sort()).toEqual(['context', 'href', 'id', 'kind', 'title']);
      }
    });

    it('lists the library across projects, named by project', async () => {
      const library = (await get('/dashboards', viewer)).json().dashboards;
      expect(library).toEqual([
        expect.objectContaining({ name: 'Portal Overview', projectName: 'Portal' }),
      ]);
    });
  });

  // --- helpers -------------------------------------------------------------

  async function tenant(portableId: string, name: string, slug: string) {
    const { tenantId: id } = await ctx.container.tenants.createTenant({ portableId, name, slug });
    await ctx.container.tenants.changeLifecycle(id, 'active');
    return id;
  }

  async function project(owner: string, portableId: string, name: string, slug: string) {
    return (await ctx.container.tenants.createProject({ tenantId: owner, portableId, name, slug }))
      .projectId;
  }

  async function user(email: string, role: 'viewer' | 'dashboard_editor', scopeId: string) {
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
      scopeId,
    });
    await grantProjectAccess(ctx, userId, scopeId, role === 'viewer' ? 'view' : 'edit');
    return { userId, email };
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

  async function detailOf(
    widgetId: string,
    token: string,
    timeRange = 'last_30_days',
    comparison = 'previous_period',
  ): Promise<WidgetDetailPresentation> {
    const response = await get(
      `/dashboards/${dashboardId}/widgets/${widgetId}/detail?timeRange=${timeRange}&comparison=${comparison}&breakpoint=desktop`,
      token,
    );
    expect(response.statusCode, widgetId).toBe(200);
    return response.json();
  }

  async function addWidget(widget: WidgetConfig) {
    const draft = await ctx.container.dashboards.getDraft(tenantId, dashboardId);
    const saved = await ctx.container.dashboards.saveDraft({
      tenantId,
      dashboardId,
      expectedRevisionId: draft.revisionId,
      snapshot: {
        ...draft.snapshot,
        widgets: [...draft.snapshot.widgets, widget],
      } as DashboardSnapshot,
      actorUserId: editorId,
    });
    await ctx.container.dashboards.publish({
      tenantId,
      dashboardId: saved.dashboardId,
      actorUserId: editorId,
    });
  }

  async function createDraftDashboard(name: string) {
    await ctx.container.dashboards.createDashboard({
      tenantId,
      projectId,
      siteId,
      name,
      actorUserId: editorId,
    });
  }
});
