import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { and, eq, or } from 'drizzle-orm';
import {
  groups,
  projectSites,
  matomoConnections,
  objectGrants,
  roleAssignments,
  semanticDefinitions,
  semanticVersions,
  sourceBindings,
  templates,
} from '@axp/db';
import { seedReferenceDashboard } from '@axp/fixtures';
import { MemoryMailTransport } from '@axp/core';
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
 * Tenant isolation regression (Phase 10; acceptance D "cross-tenant negative
 * test suite").
 *
 * Two customers, each with people in every tenant role, a project, a
 * published dashboard, a connection, semantic definitions, a group, grants, a
 * share, an export and a schedule. Every route the API registers - found as
 * it is registered, so a new route is covered without anyone adding it here -
 * is called by each person of customer A with customer B's ids. None may
 * succeed and none may fail with a server error. A parameter this suite does
 * not know fails it, so a new kind of id gets an entry here.
 *
 * Then the requests that carry the other tenant's ids in their body or query,
 * which a path sweep cannot see.
 */

interface World {
  tenantId: string;
  projectId: string;
  dashboardId: string;
  users: Record<'tenantAdmin' | 'editor' | 'viewer' | 'semantic', string>;
  sessions: Record<'tenantAdmin' | 'editor' | 'viewer' | 'semantic', string>;
  groupId: string;
  grantId: string;
  assignmentId: string;
  connectionId: string;
  definitionId: string;
  versionId: string;
  requirementKey: string;
  templateId: string | null;
  shareId: string;
  artifactId: string;
  scheduleId: string;
  attentionItemId: string;
  siteId: string;
  draft: { revisionId: string; snapshot: unknown };
}

const PULSE = 'com.axp.employee-portal-health';
const CUSTOM_BODY = {
  kind: 'custom',
  requirementKey: 'isolation_metric',
  unit: 'count',
  scope: 'visit',
  direction: 'higher_is_better',
  decimals: 0,
};
const CONNECTION = {
  name: 'Fremd',
  baseUrl: 'https://matomo.example.invalid',
  token: 'abcdefgh12345',
};
const NO_RIGHTS = { timeRange: false, comparison: false, detail: false, export: false };

/**
 * Valid requests for the routes that check their input before who is asking.
 * Without them those routes would answer 422 and the sweep would prove
 * nothing about them; with them the request reaches the authorization check.
 */
const VALID_REQUESTS: Record<string, (b: World) => { body?: unknown; query?: string }> = {
  'PUT /projects/:projectId/setup-steps/:step': () => ({ body: { notRelevant: true } }),
  'POST /tenants/:tenantId/matomo-connections/test': () => ({ body: CONNECTION }),
  'POST /tenants/:tenantId/matomo-connections': () => ({ body: CONNECTION }),
  'POST /projects/:projectId/sites': (b) => ({
    body: { connectionId: b.connectionId, matomoSiteId: 1 },
  }),
  'POST /projects/:projectId/semantic-definitions': () => ({
    body: { portableId: 'iso.metric', type: 'custom_metric', name: 'Iso', body: CUSTOM_BODY },
  }),
  'POST /projects/:projectId/semantic-definitions/:definitionId/versions': () => ({
    body: { body: CUSTOM_BODY },
  }),
  'POST /projects/:projectId/semantic-definitions/:definitionId/versions/:versionId/status':
    () => ({
      body: { to: 'deprecated' },
    }),
  'POST /projects/:projectId/semantic-definitions/preview': (b) => ({
    body: { body: CUSTOM_BODY, siteId: b.siteId },
  }),
  'PUT /projects/:projectId/source-bindings': (b) => ({
    body: {
      requirementKey: b.requirementKey,
      siteId: null,
      binding: { kind: 'native_metric', sourceMetric: 'nb_visits' },
    },
  }),
  'POST /admin/tenants/:tenantId/users': () => ({
    body: { email: 'eindringling@example.invalid', firstName: 'Ein', lastName: 'Dringling' },
  }),
  'POST /admin/tenants/:tenantId/groups': () => ({ body: { name: 'Fremd' } }),
  'PATCH /admin/tenants/:tenantId/groups/:groupId': () => ({ body: { name: 'Fremd' } }),
  'POST /admin/tenants/:tenantId/groups/:groupId/members': (b) => ({
    body: { userId: b.users.viewer },
  }),
  'GET /admin/tenants/:tenantId/assignable-roles': (b) => ({
    query: 'scopeType=tenant&scopeId=' + b.tenantId,
  }),
  'POST /admin/tenants/:tenantId/role-assignments': (b) => ({
    body: {
      subjectType: 'user',
      subjectId: b.users.viewer,
      role: 'viewer',
      scopeType: 'tenant',
      scopeId: b.tenantId,
    },
  }),
  'POST /admin/tenants/:tenantId/grants': (b) => ({
    body: {
      subjectType: 'user',
      subjectId: b.users.viewer,
      objectType: 'dashboard',
      objectId: b.dashboardId,
      access: 'view',
    },
  }),
  'POST /admin/tenants/:tenantId/impact-preview': (b) => ({
    body: {
      change: {
        kind: 'assign_role',
        subjectType: 'user',
        subjectId: b.users.viewer,
        role: 'viewer',
        scopeType: 'tenant',
        scopeId: b.tenantId,
      },
    },
  }),
  'GET /admin/platform/tenants/:tenantId/lifecycle-impact': () => ({ query: 'to=suspended' }),
  'POST /admin/platform/tenants/:tenantId/lifecycle': () => ({
    body: { to: 'suspended', confirmation: 'Kunde B' },
  }),
  'POST /projects/:projectId/solutions/analyze': () => ({
    body: { source: { catalog: { packageId: PULSE } } },
  }),
  'POST /projects/:projectId/solutions/install': () => ({
    body: {
      source: { catalog: { packageId: PULSE } },
      request: { mappings: {}, resolutions: {}, acceptWarnings: true },
    },
  }),
  'POST /projects/:projectId/solutions/mapping-preview': () => ({
    body: { sourceMetric: 'nb_visits' },
  }),
  'POST /projects/:projectId/solutions/export': (b) => ({
    body: {
      dashboardIds: [b.dashboardId],
      packageId: 'com.example.fremd',
      packageVersion: '1.0.0',
      name: 'Fremd',
      publisher: 'Fremd',
    },
  }),
  'POST /projects/:projectId/dashboards': (b) => ({ body: { name: 'Fremd', siteId: b.siteId } }),
  'POST /dashboards/:dashboardId/rollback': () => ({ body: { version: 1 } }),
  'POST /dashboards/:dashboardId/lifecycle': () => ({ body: { to: 'archived' } }),
  'PUT /dashboards/:dashboardId/draft': (b) => ({
    body: { expectedRevisionId: b.draft.revisionId, snapshot: b.draft.snapshot },
  }),
  'POST /dashboards/:dashboardId/exports': () => ({
    body: { format: 'csv', widgetId: 'kpi-visits' },
  }),
  'POST /dashboards/:dashboardId/shares': () => ({
    body: { label: 'Fremd', expiresOn: '2026-10-15', rights: NO_RIGHTS },
  }),
  'GET /projects/:projectId/reports/recipients': (b) => ({ query: 'dashboardId=' + b.dashboardId }),
  'POST /projects/:projectId/reports': (b) => ({
    body: scheduleFor(b.dashboardId, [b.users.viewer]),
  }),
  'PUT /projects/:projectId/reports/:scheduleId': (b) => ({
    body: scheduleFor(b.dashboardId, [b.users.viewer]),
  }),
  'POST /projects/:projectId/reports/:scheduleId/pause': () => ({ body: { paused: true } }),
  'PUT /themes/:scope/:id/draft': () => ({ body: { name: 'Fremd', tokens: {} } }),
  'POST /themes/:scope/:id/rollback': () => ({ body: { version: 1 } }),
  'PUT /admin/platform/tenants/:tenantId/entitlements/:entitlement': () => ({
    body: { enabled: false },
  }),
};

/** Param routes that are not tenant data: the same answer for everyone. */
const GLOBAL_ROUTES = new Set(['GET /solutions/catalog/:packageId']);

/** Routes reached by a share link's headers, not a session; covered in sharing.test.ts. */
const SHARE_LINK_ROUTES = /^\/public\/share/;

describe('tenant isolation', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  const routes: { method: string; url: string }[] = [];
  let a: World;
  let b: World;
  let platform: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestContext({ mailTransport: new MemoryMailTransport() });
    app = await buildServer({
      config: ctx.config,
      container: ctx.container,
      logger: ctx.logger,
      onRoute: (route) => routes.push(route),
    });
    await app.ready();

    const { userId: platformId } = await ctx.container.users.createLocalUser({
      email: 'platform@example.invalid',
      firstName: 'Platform',
      lastName: 'Admin',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: platformId,
      role: 'platform_admin',
      scopeType: 'platform',
      scopeId: 'platform',
    });
    platform = await signIn('platform@example.invalid');

    a = await world('a');
    b = await world('b');
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  it('knows every route parameter', () => {
    const known = new Set(Object.keys(paramValues(b, 'tenants')));
    const unknown = new Set(
      routes.flatMap((route) =>
        [...route.url.matchAll(/:(\w+)/g)].map((match) => match[1]!).filter((p) => !known.has(p)),
      ),
    );
    expect([...unknown]).toEqual([]);
  });

  it("answers no route with another tenant's data, to anyone of tenant A", async () => {
    const findings: string[] = [];
    const statuses = new Map<number, number>();
    const validationFirst = new Set<string>();
    let calls = 0;
    for (const route of sweepRoutes()) {
      for (const scope of themeScopes(route.url)) {
        const valid = VALID_REQUESTS[`${route.method} ${route.url}`]?.(b);
        const url =
          fill(route.url, paramValues(b, scope)) + (valid?.query ? `?${valid.query}` : '');
        for (const [role, session] of Object.entries(a.sessions)) {
          const response = await call(route.method, url, session, valid?.body);
          calls += 1;
          statuses.set(response.statusCode, (statuses.get(response.statusCode) ?? 0) + 1);
          if (response.statusCode === 422) validationFirst.add(`${route.method} ${route.url}`);
          // 401 would mean the session was not used at all, hiding the answer.
          if (
            response.statusCode < 300 ||
            response.statusCode === 401 ||
            response.statusCode >= 500
          ) {
            findings.push(`${role}: ${route.method} ${url} -> ${response.statusCode}`);
          }
        }
      }
    }
    expect(calls).toBeGreaterThan(300);
    if (process.env.ISOLATION_REPORT) {
      writeFileSync(
        process.env.ISOLATION_REPORT,
        JSON.stringify(
          { calls, statuses: Object.fromEntries(statuses), validationFirst: [...validationFirst] },
          null,
          2,
        ),
      );
    }
    expect(findings).toEqual([]);
    // Every route reached the question of who is asking.
    expect([...validationFirst]).toEqual([]);
  }, 300_000);

  it('would notice a leak: the same sweep with their own ids does succeed', async () => {
    let successes = 0;
    for (const route of sweepRoutes().filter((entry) => entry.method === 'GET')) {
      for (const scope of themeScopes(route.url)) {
        const url = fill(route.url, paramValues(a, scope));
        const response = await call('GET', url, a.sessions.tenantAdmin);
        if (response.statusCode < 300) successes += 1;
      }
    }
    expect(successes).toBeGreaterThan(10);
  }, 120_000);

  it("gives the platform administrator none of a customer's analytics", async () => {
    const dataRoutes = sweepRoutes().filter(
      (route) => /^\/(dashboards|projects|exports)\/:/.test(route.url) && route.method === 'GET',
    );
    expect(dataRoutes.length).toBeGreaterThan(10);
    const findings: string[] = [];
    for (const route of dataRoutes) {
      const url = fill(route.url, paramValues(b, 'tenants'));
      const response = await call(route.method, url, platform);
      if (response.statusCode < 300 || response.statusCode >= 500) {
        findings.push(`${route.method} ${url} -> ${response.statusCode}`);
      }
    }
    expect(findings).toEqual([]);
  }, 120_000);

  describe("another tenant's ids inside a request", () => {
    it('cannot grant a dashboard of another tenant', async () => {
      const response = await call(
        'POST',
        `/admin/tenants/${a.tenantId}/grants`,
        a.sessions.tenantAdmin,
        {
          subjectType: 'user',
          subjectId: a.users.viewer,
          objectType: 'dashboard',
          objectId: b.dashboardId,
          access: 'view',
        },
      );
      expectRefused(response);
    });

    it('cannot give a role on a project of another tenant, or to its people', async () => {
      expectRefused(
        await call(
          'POST',
          `/admin/tenants/${a.tenantId}/role-assignments`,
          a.sessions.tenantAdmin,
          {
            subjectType: 'user',
            subjectId: a.users.viewer,
            role: 'dashboard_editor',
            scopeType: 'project',
            scopeId: b.projectId,
          },
        ),
      );
      expectRefused(
        await call(
          'POST',
          `/admin/tenants/${a.tenantId}/role-assignments`,
          a.sessions.tenantAdmin,
          {
            subjectType: 'user',
            subjectId: b.users.viewer,
            role: 'viewer',
            scopeType: 'tenant',
            scopeId: a.tenantId,
          },
        ),
      );
    });

    it("cannot add another tenant's person to a group", async () => {
      expectRefused(
        await call(
          'POST',
          `/admin/tenants/${a.tenantId}/groups/${a.groupId}/members`,
          a.sessions.tenantAdmin,
          { userId: b.users.viewer },
        ),
      );
    });

    it("cannot schedule another tenant's dashboard, or send to its people", async () => {
      expectRefused(
        await call(
          'POST',
          `/projects/${a.projectId}/reports`,
          a.sessions.editor,
          schedule(b.dashboardId, [a.users.viewer]),
        ),
      );
      expectRefused(
        await call(
          'POST',
          `/projects/${a.projectId}/reports`,
          a.sessions.editor,
          schedule(a.dashboardId, [b.users.viewer]),
        ),
      );
    });

    it('cannot create a project for another tenant', async () => {
      expectRefused(
        await call('POST', '/projects', a.sessions.tenantAdmin, {
          tenantId: b.tenantId,
          name: 'Fremd',
          slug: 'fremd',
        }),
      );
    });

    it("never lists another tenant's objects, finds them, or styles a page with its theme", async () => {
      const bIds = [b.tenantId, b.projectId, b.dashboardId, b.connectionId, b.definitionId];
      for (const [role, session] of Object.entries(a.sessions)) {
        for (const url of [
          '/dashboards',
          '/projects',
          '/attention',
          '/search?q=Portal',
          '/admin/context',
          `/theme/effective?projectId=${b.projectId}`,
          `/theme/effective?dashboardId=${b.dashboardId}`,
        ]) {
          const response = await call('GET', url, session);
          for (const id of bIds) {
            expect(response.body.includes(id), `${role} ${url} names ${id}`).toBe(false);
          }
          expect(response.body.includes('#5b2a86'), `${role} ${url} has B's theme`).toBe(false);
        }
      }
    });
  });

  // --- the world -------------------------------------------------------------------

  async function world(key: 'a' | 'b'): Promise<World> {
    const tenantId = (
      await ctx.container.tenants.createTenant({
        portableId: `tenant.${key}`,
        name: `Kunde ${key.toUpperCase()}`,
        slug: `kunde-${key}`,
      })
    ).tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');
    const projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: `project.${key}`,
        name: `Portal ${key.toUpperCase()}`,
        slug: `portal-${key}`,
      })
    ).projectId;

    const users = {
      tenantAdmin: await person(
        tenantId,
        `admin.${key}@example.invalid`,
        'tenant_admin',
        'tenant',
        tenantId,
      ),
      editor: await person(
        tenantId,
        `editor.${key}@example.invalid`,
        'dashboard_editor',
        'project',
        projectId,
      ),
      viewer: await person(
        tenantId,
        `viewer.${key}@example.invalid`,
        'viewer',
        'project',
        projectId,
      ),
      semantic: await person(
        tenantId,
        `semantic.${key}@example.invalid`,
        'semantic_catalog_manager',
        'tenant',
        tenantId,
      ),
    };
    await grantProjectAccess(ctx, users.editor, projectId, 'edit');
    await grantProjectAccess(ctx, users.viewer, projectId, 'view');
    const { dashboardId } = await seedReferenceDashboard(ctx.container, {
      tenantId,
      projectId,
      actorUserId: users.editor,
    });
    const sessions = {
      tenantAdmin: await signIn(`admin.${key}@example.invalid`),
      editor: await signIn(`editor.${key}@example.invalid`),
      viewer: await signIn(`viewer.${key}@example.invalid`),
      semantic: await signIn(`semantic.${key}@example.invalid`),
    };

    const group = await call('POST', `/admin/tenants/${tenantId}/groups`, sessions.tenantAdmin, {
      name: `Gruppe ${key}`,
    });
    expect(group.statusCode, group.body).toBe(201);

    const share = await call('POST', `/dashboards/${dashboardId}/shares`, sessions.editor, {
      label: `Freigabe ${key}`,
      expiresOn: '2026-10-15',
      rights: { timeRange: false, comparison: false, detail: false, export: false },
    });
    expect(share.statusCode, share.body).toBe(201);
    const exported = await call('POST', `/dashboards/${dashboardId}/exports`, sessions.viewer, {
      format: 'csv',
      widgetId: 'kpi-visits',
    });
    expect(exported.statusCode, exported.body).toBe(201);
    const scheduled = await call(
      'POST',
      `/projects/${projectId}/reports`,
      sessions.editor,
      scheduleFor(dashboardId, [users.viewer]),
    );
    expect(scheduled.statusCode, scheduled.body).toBe(201);
    if (key === 'b') {
      const theme = await call('PUT', `/themes/tenants/${tenantId}/draft`, sessions.tenantAdmin, {
        name: 'B',
        tokens: { '--accent-default': '#5b2a86' },
      });
      expect(theme.statusCode, theme.body).toBe(200);
      await call('POST', `/themes/tenants/${tenantId}/publish`, sessions.tenantAdmin);
    }
    await ctx.container.attention.raise({
      tenantId,
      projectId,
      kind: 'mapping_review',
      severity: 'warning',
      groupKey: `isolation:${key}`,
      audienceCapability: 'dashboard.share',
      ownerUserId: users.editor,
      messageKey: 'attention.share_expiring',
    });

    const db = ctx.container.db;
    const [grant] = await db.select().from(objectGrants).where(eq(objectGrants.tenantId, tenantId));
    const [assignment] = await db
      .select()
      .from(roleAssignments)
      .where(and(eq(roleAssignments.scopeType, 'tenant'), eq(roleAssignments.scopeId, tenantId)));
    const [connection] = await db
      .select()
      .from(matomoConnections)
      .where(eq(matomoConnections.tenantId, tenantId));
    const [definition] = await db
      .select()
      .from(semanticDefinitions)
      .where(
        or(
          eq(semanticDefinitions.tenantId, tenantId),
          eq(semanticDefinitions.projectId, projectId),
        ),
      );
    const [version] = definition
      ? await db
          .select()
          .from(semanticVersions)
          .where(eq(semanticVersions.definitionId, definition.id))
      : [];
    const [binding] = await db
      .select()
      .from(sourceBindings)
      .where(eq(sourceBindings.projectId, projectId));
    const [template] = await db.select().from(templates).where(eq(templates.tenantId, tenantId));
    const attention = await call('GET', '/attention', sessions.editor);
    const [site] = await db
      .select()
      .from(projectSites)
      .where(eq(projectSites.projectId, projectId));
    const draft = (await call('GET', `/dashboards/${dashboardId}/draft`, sessions.editor)).json();

    return {
      tenantId,
      projectId,
      dashboardId,
      users,
      sessions,
      groupId: await firstGroup(tenantId),
      grantId: grant!.id,
      assignmentId: assignment!.id,
      connectionId: connection!.id,
      definitionId: definition?.id ?? 'no-definition',
      versionId: version?.id ?? 'no-version',
      requirementKey: binding?.requirementKey ?? 'no-binding',
      templateId: template?.id ?? null,
      shareId: share.json().id,
      artifactId: exported.json().id,
      scheduleId: scheduled.json().id,
      attentionItemId: attention.json().items[0].id,
      siteId: site!.siteId,
      draft: { revisionId: draft.revisionId, snapshot: draft.snapshot },
    };
  }

  async function firstGroup(tenantId: string): Promise<string> {
    const [row] = await ctx.container.db.select().from(groups).where(eq(groups.tenantId, tenantId));
    return row!.id;
  }

  /** The values B's ids give each route parameter. */
  function paramValues(w: World, themeScope: 'tenants' | 'projects'): Record<string, string> {
    return {
      tenantId: w.tenantId,
      projectId: w.projectId,
      dashboardId: w.dashboardId,
      userId: w.users.viewer,
      groupId: w.groupId,
      grantId: w.grantId,
      assignmentId: w.assignmentId,
      connectionId: w.connectionId,
      definitionId: w.definitionId,
      versionId: w.versionId,
      requirementKey: w.requirementKey,
      templateId: w.templateId ?? 'no-template',
      shareId: w.shareId,
      artifactId: w.artifactId,
      scheduleId: w.scheduleId,
      itemId: w.attentionItemId,
      widgetId: 'kpi-visits',
      step: 'context_profile',
      packageId: PULSE,
      entitlement: 'sharing.external',
      bundleId: 'no-bundle',
      scope: themeScope,
      id: themeScope === 'tenants' ? w.tenantId : w.projectId,
    };
  }

  function sweepRoutes() {
    return routes.filter(
      (route) =>
        route.method !== 'HEAD' &&
        route.url.includes(':') &&
        !SHARE_LINK_ROUTES.test(route.url) &&
        !GLOBAL_ROUTES.has(`${route.method} ${route.url}`),
    );
  }

  /** Theme routes are tried at both levels a customer has; the platform level is not theirs to share. */
  function themeScopes(url: string): ('tenants' | 'projects')[] {
    if (!url.startsWith('/themes/:scope')) return ['tenants'];
    return url.includes(':id') ? ['tenants', 'projects'] : [];
  }

  function fill(url: string, values: Record<string, string>): string {
    return url.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(values[name] ?? name));
  }

  function call(
    method: string,
    url: string,
    session: string,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${session}` },
      ...(payload !== undefined
        ? { payload: payload as object }
        : ['POST', 'PUT', 'PATCH'].includes(method)
          ? { payload: {} }
          : {}),
    });
  }

  function expectRefused(response: LightMyRequestResponse) {
    expect([403, 404, 409, 422], response.body).toContain(response.statusCode);
  }

  function schedule(dashboardId: string, recipients: string[]) {
    return scheduleFor(dashboardId, recipients);
  }

  async function person(
    tenantId: string,
    email: string,
    role: 'tenant_admin' | 'dashboard_editor' | 'viewer' | 'semantic_catalog_manager',
    scopeType: 'tenant' | 'project',
    scopeId: string,
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
      scopeType,
      scopeId,
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
});

function scheduleFor(dashboardId: string, recipientUserIds: string[]) {
  return {
    dashboardId,
    name: 'Isolation',
    format: 'pdf',
    period: 'last_7_days',
    comparison: 'previous_period',
    rhythm: { frequency: 'weekly', weekday: 1, time: '07:00' },
    timezone: 'Europe/Berlin',
    deliveryMode: 'attachment',
    recipientUserIds,
  };
}
