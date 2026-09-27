import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  AppError,
  type AuthContext,
  type Breakpoint,
  comparisonModeSchema,
  type DashboardSnapshot,
  responsivePlacementSchema,
  timeRangePresetSchema,
  widgetFamilySchema,
} from '@axp/contracts';
import { dashboards as dashboardsTable } from '@axp/db';
import type { Container } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireProjectScope, requireProjectSite } from '../lib/project-scope';

const filterSpecSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(['equals', 'contains', 'starts_with', 'in']),
  value: z.union([z.string(), z.array(z.string())]),
  labelKey: z.string().optional(),
});

const widgetSchema = z.object({
  id: z.string().min(1).max(64),
  family: widgetFamilySchema,
  title: z.string().min(1).max(200),
  placement: responsivePlacementSchema,
  data: z.object({
    semanticVersionIds: z.array(z.string()).max(12),
    dimension: z.string().optional(),
    topN: z.number().int().min(1).max(500).optional(),
    fixedFilters: z.array(filterSpecSchema).default([]),
  }),
  presentation: z.object({
    variant: z.string().optional(),
    showComparison: z.boolean().default(false),
    showSparkline: z.boolean().optional(),
    decimals: z.number().int().min(0).max(6).optional(),
  }),
  context: z.object({
    descriptionKey: z.string().optional(),
    description: z.string().max(2000).optional(),
    showDefinition: z.boolean().default(false),
  }),
});

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  siteId: z.string().min(1),
  defaultTimeRange: z.object({
    preset: timeRangePresetSchema,
    from: z.string(),
    to: z.string(),
  }),
  defaultComparison: z.object({
    mode: comparisonModeSchema,
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  fixedFilters: z.array(filterSpecSchema).default([]),
  // A dashboard with more widgets than this is a performance problem, not a
  // use case: the target is a 10-20 widget dashboard (Master Spec §26).
  widgets: z.array(widgetSchema).max(50),
});

const viewQuerySchema = z.object({
  timeRange: timeRangePresetSchema.default('last_30_days'),
  from: z.string().optional(),
  to: z.string().optional(),
  comparison: comparisonModeSchema.default('previous_period'),
  breakpoint: z.enum(['desktop', 'tablet', 'mobile']).default('desktop'),
  /** `draft` renders the working copy through the published path (D3 preview). */
  source: z.enum(['published', 'draft']).default('published'),
});

/**
 * Dashboard authoring and viewing (Master Spec §21, D3, D4).
 *
 * Reading a published dashboard and editing its draft are different
 * capabilities on different routes, which is what keeps "published is never
 * edited live" enforceable rather than merely intended.
 */
export function registerDashboardRoutes(app: FastifyInstance, container: Container): void {
  app.get('/projects/:projectId/dashboards', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
    const scope = await requireProjectScope(container, auth, projectId, 'dashboard.read_published');

    const list = await container.dashboards.listForProject(scope.tenantId, scope.projectId);
    return { dashboards: list };
  });

  app.post(
    '/projects/:projectId/dashboards',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId } = z.object({ projectId: z.string() }).parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).max(200),
          description: z.string().max(1000).optional(),
          siteId: z.string().min(1),
        })
        .parse(request.body);

      const scope = await requireProjectScope(container, auth, projectId, 'dashboard.create');
      await requireProjectSite(container, scope, body.siteId);

      const draft = await container.dashboards.createDashboard({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        siteId: body.siteId,
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        actorUserId: auth.userId,
      });

      void reply.status(201);
      return draft;
    },
  );

  app.get('/dashboards/:dashboardId/draft', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
    const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.edit_draft');
    return container.dashboards.getDraft(scope.tenantId, dashboardId, auth.userId);
  });

  /**
   * Claims the draft for this editor (Master Spec §21).
   *
   * Answers 200 either way: "someone else has it" is information the editor
   * needs in order to offer a takeover, not a failure. `force` performs the
   * takeover and is audited.
   */
  app.post('/dashboards/:dashboardId/lease', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
    const { force } = z.object({ force: z.boolean().default(false) }).parse(request.body ?? {});

    const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.edit_draft');
    return container.dashboards.acquireLease({
      tenantId: scope.tenantId,
      dashboardId,
      userId: auth.userId,
      force,
    });
  });

  app.delete(
    '/dashboards/:dashboardId/lease',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.edit_draft');

      await container.dashboards.releaseLease({
        tenantId: scope.tenantId,
        dashboardId,
        userId: auth.userId,
      });
      void reply.status(204);
    },
  );

  /** Published history, newest first. Reading it needs no publish right. */
  app.get(
    '/dashboards/:dashboardId/versions',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const scope = await scopeForDashboard(
        container,
        auth,
        dashboardId,
        'dashboard.read_published',
      );

      const versions = await container.dashboards.listVersions(scope.tenantId, dashboardId);
      return { versions };
    },
  );

  /** Rolls back by publishing a new version from an older snapshot. */
  app.post(
    '/dashboards/:dashboardId/rollback',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const { version } = z.object({ version: z.number().int().positive() }).parse(request.body);

      const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.publish');
      const published = await container.dashboards.rollbackTo({
        tenantId: scope.tenantId,
        dashboardId,
        version,
        actorUserId: auth.userId,
      });

      return { dashboardId: published.dashboardId, version: published.version };
    },
  );

  /**
   * Archive, trash and restore.
   *
   * Nothing here deletes. An archived dashboard is out of the way, a trashed
   * one is out of sight, and both are recoverable (Master Spec §21).
   */
  app.post(
    '/dashboards/:dashboardId/lifecycle',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const { to } = z.object({ to: z.enum(['archived', 'trash', 'restore']) }).parse(request.body);

      const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.publish');
      const lifecycle = await container.dashboards.changeLifecycle({
        tenantId: scope.tenantId,
        dashboardId,
        to,
        actorUserId: auth.userId,
      });

      return { dashboardId, lifecycle };
    },
  );

  /**
   * Autosave.
   *
   * The expected revision id makes a stale write fail loudly instead of
   * overwriting someone else's autosave.
   */
  app.put('/dashboards/:dashboardId/draft', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
    const body = z
      .object({ expectedRevisionId: z.string().min(1), snapshot: snapshotSchema })
      .parse(request.body);

    const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.edit_draft');
    await requireProjectSite(container, scope, body.snapshot.siteId);

    return container.dashboards.saveDraft({
      tenantId: scope.tenantId,
      dashboardId,
      expectedRevisionId: body.expectedRevisionId,
      snapshot: body.snapshot as DashboardSnapshot,
      actorUserId: auth.userId,
    });
  });

  /** What publishing would change, before anything is written (D3). */
  app.get(
    '/dashboards/:dashboardId/publish-impact',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.publish');
      return container.dashboards.analysePublish(scope.tenantId, dashboardId);
    },
  );

  app.post(
    '/dashboards/:dashboardId/publish',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.publish');

      const published = await container.dashboards.publish({
        tenantId: scope.tenantId,
        dashboardId,
        actorUserId: auth.userId,
      });

      return { dashboardId: published.dashboardId, version: published.version };
    },
  );

  /**
   * The presentation model for the viewer and for preview.
   *
   * Preview renders the draft through the same builder the viewer uses, so
   * what an editor checks is what a viewer will get (D3).
   */
  app.get(
    '/dashboards/:dashboardId/presentation',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const query = viewQuerySchema.parse(request.query);

      const capability =
        query.source === 'draft' ? 'dashboard.edit_draft' : 'dashboard.read_published';
      const scope = await scopeForDashboard(container, auth, dashboardId, capability);

      const state =
        query.source === 'draft'
          ? await container.dashboards.getDraft(scope.tenantId, dashboardId, auth.userId)
          : await container.dashboards.getPublished(scope.tenantId, dashboardId);

      if (!state) {
        throw new AppError('setup_required', {
          code: 'dashboard_not_published',
          messageKey: 'dashboard.not_published',
          internalMessage: `Dashboard ${dashboardId} has no published version yet.`,
        });
      }

      const site = await requireProjectSite(container, scope, state.snapshot.siteId);

      return container.presentation.build({
        snapshot: state.snapshot,
        meta: {
          dashboardId,
          name: state.snapshot.name,
          ...(state.snapshot.description ? { description: state.snapshot.description } : {}),
          publishedVersion: 'version' in state ? state.version : null,
          isDraftPreview: query.source === 'draft',
          projectName: scope.projectName,
          tenantName: scope.tenantName,
        },
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        site,
        timeRangePreset: query.timeRange,
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        comparisonMode: query.comparison,
        breakpoint: query.breakpoint as Breakpoint,
        locale: auth.locale,
        permissionContextId: scope.permissionContextId,
      });
    },
  );

  /**
   * The dashboard without its numbers (Master Spec §11).
   *
   * Answered from the stored snapshot alone, so it returns before any Matomo
   * call has been made. The viewer draws the grid from this and then asks for
   * each widget separately, which is what makes the widgets independent rather
   * than merely described as such.
   */
  app.get('/dashboards/:dashboardId/layout', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
    const query = viewQuerySchema.parse(request.query);
    const resolved = await resolveView(container, auth, dashboardId, query);

    return container.presentation.buildLayout(resolved.input);
  });

  /**
   * One widget's values.
   *
   * Its own request so a slow metric delays only its own tile. Authorized
   * identically to the dashboard: asking for one widget is not a way past the
   * capability that guards the whole.
   */
  app.get(
    '/dashboards/:dashboardId/widgets/:widgetId',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId, widgetId } = z
        .object({ dashboardId: z.string(), widgetId: z.string().min(1) })
        .parse(request.params);
      const query = viewQuerySchema.parse(request.query);
      const resolved = await resolveView(container, auth, dashboardId, query);

      return container.presentation.buildTile({ ...resolved.input, widgetId });
    },
  );

  /**
   * One widget, in depth (D4, Master Spec §11).
   *
   * Reads the same snapshot through the same builder as the grid, with the same
   * time range and comparison, so the detail view cannot contradict the tile it
   * was opened from. Authorized identically: opening a widget is not a way past
   * the capability that guards the dashboard.
   */
  app.get(
    '/dashboards/:dashboardId/widgets/:widgetId/detail',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId, widgetId } = z
        .object({ dashboardId: z.string(), widgetId: z.string().min(1) })
        .parse(request.params);
      const query = viewQuerySchema.parse(request.query);

      const capability =
        query.source === 'draft' ? 'dashboard.edit_draft' : 'dashboard.read_published';
      const scope = await scopeForDashboard(container, auth, dashboardId, capability);

      const state =
        query.source === 'draft'
          ? await container.dashboards.getDraft(scope.tenantId, dashboardId, auth.userId)
          : await container.dashboards.getPublished(scope.tenantId, dashboardId);

      if (!state) {
        throw new AppError('setup_required', {
          code: 'dashboard_not_published',
          messageKey: 'dashboard.not_published',
          internalMessage: `Dashboard ${dashboardId} has no published version yet.`,
        });
      }

      const site = await requireProjectSite(container, scope, state.snapshot.siteId);

      // Only the capabilities the detail view's actions depend on, rather than
      // the whole project surface: this runs on every widget a viewer opens.
      const canReadCatalog = await container.authorization.can(auth, 'semantic.read', {
        type: 'project',
        projectId: scope.projectId,
      });

      return container.presentation.buildDetail({
        widgetId,
        capabilities: canReadCatalog ? ['semantic.read'] : [],
        snapshot: state.snapshot,
        meta: {
          dashboardId,
          name: state.snapshot.name,
          ...(state.snapshot.description ? { description: state.snapshot.description } : {}),
          publishedVersion: 'version' in state ? state.version : null,
          isDraftPreview: query.source === 'draft',
          projectName: scope.projectName,
          tenantName: scope.tenantName,
        },
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        site,
        timeRangePreset: query.timeRange,
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        comparisonMode: query.comparison,
        breakpoint: query.breakpoint as Breakpoint,
        locale: auth.locale,
        permissionContextId: scope.permissionContextId,
      });
    },
  );
}

/**
 * Everything the presentation builder needs, resolved and authorized once.
 *
 * Three routes read the same snapshot with the same capability and the same
 * time range. Sharing the resolution is what keeps the layout, a tile and a
 * detail view from ever disagreeing about which snapshot they are describing.
 */
async function resolveView(
  container: Container,
  auth: AuthContext,
  dashboardId: string,
  query: z.infer<typeof viewQuerySchema>,
) {
  const capability = query.source === 'draft' ? 'dashboard.edit_draft' : 'dashboard.read_published';
  const scope = await scopeForDashboard(container, auth, dashboardId, capability);

  const state =
    query.source === 'draft'
      ? await container.dashboards.getDraft(scope.tenantId, dashboardId, auth.userId)
      : await container.dashboards.getPublished(scope.tenantId, dashboardId);

  if (!state) {
    throw new AppError('setup_required', {
      code: 'dashboard_not_published',
      messageKey: 'dashboard.not_published',
      internalMessage: `Dashboard ${dashboardId} has no published version yet.`,
    });
  }

  const site = await requireProjectSite(container, scope, state.snapshot.siteId);

  return {
    scope,
    input: {
      snapshot: state.snapshot,
      meta: {
        dashboardId,
        name: state.snapshot.name,
        ...(state.snapshot.description ? { description: state.snapshot.description } : {}),
        publishedVersion: 'version' in state ? state.version : null,
        isDraftPreview: query.source === 'draft',
        projectName: scope.projectName,
        tenantName: scope.tenantName,
      },
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      site,
      timeRangePreset: query.timeRange,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      comparisonMode: query.comparison,
      breakpoint: query.breakpoint as Breakpoint,
      locale: auth.locale,
      permissionContextId: scope.permissionContextId,
    },
  };
}

/**
 * Resolves the project a dashboard belongs to, then authorizes against it.
 *
 * The dashboard id comes from the browser; its project and tenant are read
 * from the database before any capability check happens.
 */
async function scopeForDashboard(
  container: Container,
  auth: Parameters<typeof requireProjectScope>[1],
  dashboardId: string,
  capability: Parameters<typeof requireProjectScope>[3],
) {
  const [row] = await container.db
    .select({ projectId: dashboardsTable.projectId })
    .from(dashboardsTable)
    .where(eq(dashboardsTable.id, dashboardId))
    .limit(1);

  if (!row) {
    throw new AppError('not_found', {
      code: 'dashboard_not_found',
      messageKey: 'dashboard.not_found',
      internalMessage: `Dashboard ${dashboardId} does not exist.`,
    });
  }

  return requireProjectScope(container, auth, row.projectId, capability);
}
