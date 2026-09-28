import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PackageAnalysis, SolutionPackage, WidgetPresentation } from '@axp/contracts';
import { MOCK_PULSE_METRICS, PULSE_PACKAGE } from '@axp/core';
import { semanticDefinitions } from '@axp/db';
import { seedReferenceDashboard } from '@axp/fixtures';
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
 * Project setup, solution packages and templates (D6, D7, Gate F6).
 *
 * The Pulse reference solution goes the whole way through the real stack:
 * analysed, mapped onto what the site offers, installed, turned into a
 * dashboard from its template, and read back with the canonical values. Then
 * the package is updated, and the published dashboard is shown not to move.
 */
describe('solutions, templates and project setup', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  let tenantId: string;
  let projectId: string;
  let semanticId: string;

  let semantic: string;
  let editor: string;
  let viewer: string;
  let admin: string;

  const CATALOG = { catalog: { packageId: PULSE_PACKAGE.manifest.packageId } };
  const PULSE_MAPPINGS = {
    'pulse.active_users': MOCK_PULSE_METRICS.activeUsers,
    'pulse.engaged_users': MOCK_PULSE_METRICS.engagedUsers,
    'pulse.content_creators': MOCK_PULSE_METRICS.contentCreators,
    'pulse.registered_users': MOCK_PULSE_METRICS.registeredUsers,
  };
  const VIEW = 'timeRange=last_7_days&comparison=previous_period&breakpoint=desktop';

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();

    const created = await ctx.container.tenants.createTenant({
      portableId: 'demo.tenant',
      name: 'Tenant',
      slug: 'tenant',
    });
    tenantId = created.tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');
    projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: 'demo.project',
        name: 'Portal',
        slug: 'portal',
      })
    ).projectId;

    const editorId = await user('editor@example.invalid', 'dashboard_editor', 'project', projectId);
    await grantProjectAccess(ctx, editorId, projectId, 'edit');
    semanticId = await user(
      'semantic@example.invalid',
      'semantic_catalog_manager',
      'tenant',
      tenantId,
    );
    await grantProjectAccess(ctx, semanticId, projectId, 'view');
    const viewerId = await user('viewer@example.invalid', 'viewer', 'project', projectId);
    await grantProjectAccess(ctx, viewerId, projectId, 'view');
    await user('admin@example.invalid', 'tenant_admin', 'tenant', tenantId);

    // A connection, a site and its capability snapshot - an eligible project.
    await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId: editorId });

    semantic = await signIn('semantic@example.invalid');
    editor = await signIn('editor@example.invalid');
    viewer = await signIn('viewer@example.invalid');
    admin = await signIn('admin@example.invalid');
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- Pulse, end to end --------------------------------------------------------

  describe('installing the Pulse reference solution', () => {
    it('analyses before writing: compatible, nine new definitions, four things to map', async () => {
      const analysis = await analyze(CATALOG);
      expect(analysis.installable).toBe(true);
      expect(analysis.compatibility).toBe('supported');
      expect(analysis.preview).toMatchObject({ definitionsNew: 9, dashboardTemplates: 2 });
      expect(analysis.mappings.map((mapping) => mapping.requirement.key)).toEqual(
        Object.keys(PULSE_MAPPINGS),
      );
      // The candidates are what the site offers - nothing the package named.
      expect(analysis.mappings[0]!.candidates.map((candidate) => candidate.sourceMetric)).toContain(
        MOCK_PULSE_METRICS.activeUsers,
      );
      expect(await definitionCount()).toBe(2); // only the core metrics so far
    });

    it('never names a source: the package carries no source ids of any kind', () => {
      const text = JSON.stringify(PULSE_PACKAGE);
      expect(text).not.toContain('mock_');
      expect(text).not.toMatch(/dimension\d|"index"|goalId|siteId|connectionId/);
    });

    it('installs, then a dashboard from its template shows the canonical values', async () => {
      const installed = await install(CATALOG);
      expect(installed.statusCode).toBe(201);
      expect(installed.json()).toMatchObject({ definitionsCreated: 9, templates: 6 });

      const templates = await listTemplates('dashboard');
      const executive = templates.find(
        (template: { name: string }) => template.name === 'Executive Health Overview',
      );
      expect(executive.readiness).toBe('ready');

      const dashboardId = await dashboardFrom(executive.id);
      await ctx.container.dashboards.publish({
        tenantId,
        dashboardId,
        actorUserId: await userIdOf('editor@example.invalid'),
      });

      const values = await cardValues(dashboardId, viewer);
      expect(values).toMatchObject({
        'pulse-score': 40.32,
        'interaction-index': 15.4,
        'adoption-rate': 51,
        'engagement-rate': 18,
        'creation-rate': 5,
      });
    });

    it('marks the mapping step done and fills an empty context profile', async () => {
      await install(CATALOG);
      const detail = (await get(`/projects/${projectId}`, admin)).json();
      const mapping = detail.setup.steps.find((step: { step: string }) => step.step === 'mapping');
      expect(mapping).toMatchObject({ state: 'done', detail: '4/4' });
      expect(detail.project.contextProfile.useCase).toContain('Mitarbeiterportal');
    });

    it('refuses an install whose mapping is incomplete or not offered by the site', async () => {
      const incomplete = await install(CATALOG, {
        mappings: { 'pulse.active_users': MOCK_PULSE_METRICS.activeUsers },
      });
      expect(incomplete.statusCode).toBe(422);
      expect(incomplete.json().error.code).toBe('mapping_incomplete');

      const invented = await install(CATALOG, {
        mappings: { ...PULSE_MAPPINGS, 'pulse.active_users': 'custom_dimension_7' },
      });
      expect(invented.json().error.code).toBe('mapping_not_offered');
      expect(await definitionCount()).toBe(2);
    });

    it('shows a candidate value before it is chosen, only with a data grant', async () => {
      const preview = await post(`/projects/${projectId}/solutions/mapping-preview`, semantic, {
        sourceMetric: MOCK_PULSE_METRICS.activeUsers,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().value).toEqual({ state: 'ready', value: 5000 });

      const withoutGrant = await post(`/projects/${projectId}/solutions/mapping-preview`, admin, {
        sourceMetric: MOCK_PULSE_METRICS.activeUsers,
      });
      expect(withoutGrant.statusCode).toBe(403);
    });

    it('installs again as a no-op: everything identical is reused', async () => {
      await install(CATALOG);
      const again = await analyze(CATALOG);
      expect(again.conflicts).toEqual([]);
      expect(again.installedVersion).toBe('1.0.0');
      expect(again.mappings.every((mapping) => mapping.existing)).toBe(true);

      const reinstalled = await install(CATALOG, { mappings: {} });
      expect(reinstalled.json()).toMatchObject({ definitionsCreated: 0, definitionsReused: 9 });
    });
  });

  // --- updates -----------------------------------------------------------------------

  describe('updating a package', () => {
    it('does not silently change a published dashboard', async () => {
      await install(CATALOG);
      const executive = (await listTemplates('dashboard')).find(
        (template: { name: string }) => template.name === 'Executive Health Overview',
      );
      const published = await dashboardFrom(executive.id);
      const editorId = await userIdOf('editor@example.invalid');
      await ctx.container.dashboards.publish({
        tenantId,
        dashboardId: published,
        actorUserId: editorId,
      });
      const before = await ctx.container.dashboards.getPublished(tenantId, published);

      const update = pulseUpdate();
      const analysis = await analyze({ upload: update });
      expect(analysis.installable).toBe(true);
      expect(analysis.installedVersion).toBe('1.0.0');
      expect(analysis.conflicts.map((conflict) => [conflict.portableId, conflict.kind])).toEqual(
        expect.arrayContaining([
          ['pulse.health_index', 'changed'],
          ['pulse.dashboard.executive_health', 'changed'],
        ]),
      );

      // Nothing happens to a changed definition until someone decides.
      const undecided = await install({ upload: update }, { mappings: {} });
      expect(undecided.statusCode).toBe(422);
      expect(undecided.json().error.code).toBe('conflicts_unresolved');

      const updated = await install(
        { upload: update },
        {
          mappings: {},
          resolutions: {
            'pulse.health_index': 'new_version',
            'pulse.dashboard.executive_health': 'new_version',
          },
        },
      );
      expect(updated.statusCode).toBe(201);
      expect(updated.json()).toMatchObject({ versionsAdded: 1, definitionsCreated: 0 });

      // The published dashboard: same snapshot, same number.
      const after = await ctx.container.dashboards.getPublished(tenantId, published);
      expect(after).toEqual(before);
      expect((await cardValues(published, viewer))['pulse-score']).toBe(40.32);

      // A dashboard created now uses the new definition: 15.4 × 0.5 + 51 × 0.5.
      const fresh = await dashboardFrom(executive.id);
      await ctx.container.dashboards.publish({
        tenantId,
        dashboardId: fresh,
        actorUserId: editorId,
      });
      expect((await cardValues(fresh, viewer))['pulse-score']).toBe(33.2);

      const installations = (await get(`/projects/${projectId}/solutions`, semantic)).json()
        .installations as { packageVersion: string; current: boolean }[];
      expect(installations.map((entry) => [entry.packageVersion, entry.current])).toEqual([
        ['1.1.0', true],
        ['1.0.0', false],
      ]);
    });

    it('keeps the existing definition when the installer says so', async () => {
      await install(CATALOG);
      const kept = await install(
        { upload: pulseUpdate() },
        {
          mappings: {},
          resolutions: {
            'pulse.health_index': 'keep_existing',
            'pulse.dashboard.executive_health': 'keep_existing',
          },
        },
      );
      expect(kept.json()).toMatchObject({ versionsAdded: 0, definitionsReused: 8 });
    });
  });

  // --- untrusted input ------------------------------------------------------------------

  describe('malicious and invalid packages', () => {
    it('are rejected before anything is written, with the reasons listed', async () => {
      const payloads: unknown[] = [
        { ...PULSE_PACKAGE, script: 'require("child_process")' },
        withDefinitionBody({ kind: 'formula', ast: { type: 'sql', query: 'DROP TABLE users' } }),
        { ...PULSE_PACKAGE, manifest: { ...PULSE_PACKAGE.manifest, token: 'secret' } },
        { ...PULSE_PACKAGE, manifest: { ...PULSE_PACKAGE.manifest, packageSchemaVersion: '99' } },
        'x'.repeat(600 * 1024),
      ];

      for (const payload of payloads) {
        const analysis = await analyze({ upload: payload });
        expect(analysis.installable).toBe(false);
        expect(analysis.issues.length).toBeGreaterThan(0);

        const attempt = await install({ upload: payload });
        expect(attempt.statusCode).toBe(422);
      }
      expect(await definitionCount()).toBe(2);
    });
  });

  // --- permissions -----------------------------------------------------------------------

  describe('who may do what', () => {
    it('lets only a catalog manager analyse and install, and an editor create from templates', async () => {
      expect(
        (await post(`/projects/${projectId}/solutions/analyze`, viewer, { source: CATALOG }))
          .statusCode,
      ).toBe(403);
      expect(
        (await post(`/projects/${projectId}/solutions/analyze`, editor, { source: CATALOG }))
          .statusCode,
      ).toBe(403);

      await install(CATALOG);
      const template = (await listTemplates('dashboard'))[0];
      const bySemantic = await post(
        `/projects/${projectId}/templates/${template.id}/dashboards`,
        semantic,
        {},
      );
      expect(bySemantic.statusCode).toBe(403);
      const byEditor = await post(
        `/projects/${projectId}/templates/${template.id}/dashboards`,
        editor,
        {},
      );
      expect(byEditor.statusCode).toBe(201);
    });
  });

  // --- export ---------------------------------------------------------------------------------

  describe('exporting', () => {
    it('packages a dashboard with its definitions, and the result installs elsewhere', async () => {
      await install(CATALOG);
      const executive = (await listTemplates('dashboard')).find(
        (template: { name: string }) => template.name === 'Executive Health Overview',
      );
      const dashboardId = await dashboardFrom(executive.id);
      await ctx.container.dashboards.publish({
        tenantId,
        dashboardId,
        actorUserId: await userIdOf('editor@example.invalid'),
      });
      // An author: manages the catalog and may edit the dashboards exported.
      await ctx.container.users.assignRole({
        subjectType: 'user',
        subjectId: semanticId,
        role: 'dashboard_editor',
        scopeType: 'project',
        scopeId: projectId,
      });
      await grantProjectAccess(ctx, semanticId, projectId, 'edit');
      semantic = await signIn('semantic@example.invalid');

      const response = await post(`/projects/${projectId}/solutions/export`, semantic, {
        dashboardIds: [dashboardId],
        packageId: 'com.example.portal-export',
        packageVersion: '1.0.0',
        name: 'Portal-Export',
        publisher: 'Test',
      });
      expect(response.statusCode).toBe(200);
      const exported = response.json().package as SolutionPackage;
      expect(exported.manifest.origin.kind).toBe('export');
      expect(exported.definitions.map((definition) => definition.portableId)).toContain(
        'pulse.health_index',
      );

      const [site] = await ctx.container.matomo.listProjectSites(projectId);
      const text = JSON.stringify(exported);
      expect(text).not.toContain(site!.id);
      expect(text).not.toContain(site!.connectionId);
      expect(text).not.toContain(tenantId);

      // Into a second, clean project of the same tenant.
      const second = (
        await ctx.container.tenants.createProject({
          tenantId,
          portableId: 'demo.second',
          name: 'Zwei',
          slug: 'zwei',
        })
      ).projectId;
      await ctx.container.matomo.assignSiteToProject(tenantId, second, site!.id);
      const analysis = (
        await post(`/projects/${second}/solutions/analyze`, semantic, {
          source: { upload: exported },
        })
      ).json() as PackageAnalysis;
      expect(analysis.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    });
  });

  // --- project creation and the checklist ------------------------------------------------

  describe('project creation and the setup checklist', () => {
    it('creates a project in the small flow, reusing a site the tenant already has', async () => {
      const options = (await get('/projects/creation-options', admin)).json();
      expect(options.tenants).toHaveLength(1);
      const site = options.tenants[0].sites[0];
      expect(site.usedByProjects).toBe(1);

      const response = await post('/projects', admin, {
        tenantId,
        name: 'Intranet Süd',
        slug: 'intranet-sued',
        timezone: 'Europe/Berlin',
        defaultLocale: 'de',
        contextProfile: { useCase: 'Standort Süd beobachten', audience: 'Standortleitung' },
        source: { kind: 'existing_site', siteId: site.id },
      });
      expect(response.statusCode).toBe(201);
      const created = (await get(`/projects/${response.json().projectId}`, admin)).json();
      const state = (key: string) =>
        created.setup.steps.find((entry: { step: string }) => entry.step === key).state;
      expect(state('site_assignment')).toBe('done');
      expect(state('context_profile')).toBe('done');
      expect(state('mapping')).toBe('not_relevant');
      expect(state('first_dashboard')).toBe('open');
      expect(created.setup.readiness).toBe('setup_required');
    });

    it('refuses a taken slug, and creation by someone without the right', async () => {
      const body = {
        tenantId,
        name: 'Portal',
        slug: 'portal',
        contextProfile: {},
        source: { kind: 'later' },
      };
      const taken = await post('/projects', admin, body);
      expect(taken.statusCode).toBe(409);
      expect(taken.json().error.fieldErrors.slug).toBeTruthy();

      expect((await post('/projects', editor, { ...body, slug: 'neu' })).statusCode).toBe(403);
      expect((await get('/projects/creation-options', editor)).json().tenants).toEqual([]);
    });

    it('lets an optional step be marked not relevant, but never a core one', async () => {
      const marked = await put(`/projects/${projectId}/setup-steps/reporting`, admin, {
        notRelevant: true,
      });
      expect(marked.statusCode).toBe(200);
      const reporting = marked
        .json()
        .setup.steps.find((entry: { step: string }) => entry.step === 'reporting');
      expect(reporting).toMatchObject({ state: 'not_relevant', markedNotRelevant: true });

      const core = await put(`/projects/${projectId}/setup-steps/site_assignment`, admin, {
        notRelevant: true,
      });
      expect(core.statusCode).toBe(422);
    });

    it('saves the context profile and records only which fields changed', async () => {
      const saved = await put(`/projects/${projectId}/context-profile`, admin, {
        useCase: 'Portal verstehen',
        audience: 'Kommunikation',
        limits: 'Nur Desktop-Tracking',
      });
      expect(saved.statusCode).toBe(200);
      const events = (await get(`/admin/tenants/${tenantId}/audit`, admin)).json().events;
      const event = events.find(
        (entry: { action: string }) => entry.action === 'project.context_updated',
      );
      expect(event).toBeTruthy();
      expect(JSON.stringify(event)).not.toContain('Nur Desktop-Tracking');
    });
  });

  // --- helpers --------------------------------------------------------------------------------

  async function user(
    email: string,
    role: 'viewer' | 'dashboard_editor' | 'semantic_catalog_manager' | 'tenant_admin',
    scopeType: 'project' | 'tenant',
    scopeId: string,
  ) {
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
      scopeType,
      scopeId,
    });
    return userId;
  }

  async function userIdOf(email: string) {
    return (await ctx.container.users.findByEmail(email))!.id;
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

  function put(url: string, token: string, payload: unknown) {
    return app.inject({
      method: 'PUT',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as object,
    });
  }

  async function analyze(source: unknown): Promise<PackageAnalysis> {
    const response = await post(`/projects/${projectId}/solutions/analyze`, semantic, { source });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  function install(
    source: unknown,
    request: { mappings?: Record<string, string>; resolutions?: Record<string, string> } = {},
  ) {
    return post(`/projects/${projectId}/solutions/install`, semantic, {
      source,
      request: {
        mappings: request.mappings ?? PULSE_MAPPINGS,
        resolutions: request.resolutions ?? {},
        acceptWarnings: false,
      },
    });
  }

  async function listTemplates(kind: 'widget' | 'dashboard') {
    const response = await get(`/projects/${projectId}/templates?kind=${kind}`, editor);
    expect(response.statusCode).toBe(200);
    return response.json().templates;
  }

  async function dashboardFrom(templateId: string): Promise<string> {
    const response = await post(
      `/projects/${projectId}/templates/${templateId}/dashboards`,
      editor,
      {},
    );
    expect(response.statusCode).toBe(201);
    return response.json().dashboardId;
  }

  async function cardValues(dashboardId: string, token: string) {
    const response = await get(`/dashboards/${dashboardId}/presentation?${VIEW}`, token);
    expect(response.statusCode).toBe(200);
    const values: Record<string, number | string> = {};
    for (const widget of response.json().widgets as WidgetPresentation[]) {
      if (widget.content?.kind !== 'card') continue;
      const value = widget.content.metrics[0]?.value;
      values[widget.widgetId] = value && 'value' in value ? value.value : (value?.state ?? 'none');
    }
    return values;
  }

  async function definitionCount() {
    return (await ctx.container.db.select({ id: semanticDefinitions.id }).from(semanticDefinitions))
      .length;
  }

  /** Version 1.1.0: PULSE reweighted to 0.5 / 0.5, the executive template renamed. */
  function pulseUpdate(): SolutionPackage {
    const pkg = JSON.parse(JSON.stringify(PULSE_PACKAGE)) as SolutionPackage;
    return {
      ...pkg,
      manifest: { ...pkg.manifest, packageVersion: '1.1.0' },
      definitions: pkg.definitions.map((definition) =>
        definition.portableId === 'pulse.health_index' && definition.body.kind === 'score'
          ? {
              ...definition,
              body: {
                ...definition.body,
                components: definition.body.components.map((component) => ({
                  ...component,
                  weight: 0.5,
                })),
              },
            }
          : definition,
      ),
      dashboardTemplates: pkg.dashboardTemplates.map((template) =>
        template.portableId === 'pulse.dashboard.executive_health'
          ? { ...template, name: 'Executive Health Overview (2)' }
          : template,
      ),
    };
  }

  function withDefinitionBody(body: unknown) {
    const pkg = JSON.parse(JSON.stringify(PULSE_PACKAGE)) as { definitions: { body: unknown }[] };
    pkg.definitions[4]!.body = body;
    return pkg;
  }
});
