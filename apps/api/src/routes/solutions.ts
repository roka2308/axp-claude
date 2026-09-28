import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  packageIdSchema,
  packageVersionSchema,
  solutionInstallRequestSchema,
  TEMPLATE_KINDS,
} from '@axp/contracts';
import type { Container, PackageSource } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireProjectScope } from '../lib/project-scope';

const projectParams = z.object({ projectId: z.string().min(1) });

/**
 * Where the package comes from. An upload arrives as the parsed JSON object;
 * the service measures and validates it before looking at anything inside.
 */
const sourceSchema = z.union([
  z
    .object({
      catalog: z
        .object({ packageId: packageIdSchema, packageVersion: packageVersionSchema.optional() })
        .strict(),
    })
    .strict(),
  z.object({ upload: z.unknown() }).strict(),
]);

/**
 * Solutions and templates (Master Spec §14, D7).
 *
 * Installing a solution creates semantic definitions, so it needs
 * `semantic.manage` - the same capability the catalog builders need. Reading
 * templates needs `semantic.read`; creating a dashboard from one needs
 * `dashboard.create`. The package itself is never trusted: every route that
 * receives one hands it to the service's validation first.
 */
export function registerSolutionRoutes(app: FastifyInstance, container: Container): void {
  const guard = { onRequest: [app.authenticate] };

  app.get('/solutions/catalog', guard, async (request) => {
    requireAuth(request);
    return { solutions: container.solutions.catalog() };
  });

  app.get('/projects/:projectId/solutions', guard, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = projectParams.parse(request.params);
    const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');
    return { installations: await container.solutions.listInstallations(scope.projectId) };
  });

  app.post('/projects/:projectId/solutions/analyze', guard, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = projectParams.parse(request.params);
    const { source } = z.object({ source: sourceSchema }).strict().parse(request.body);
    const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');
    return container.solutions.analyze(scope.tenantId, scope.projectId, source as PackageSource);
  });

  app.post('/projects/:projectId/solutions/install', guard, async (request, reply) => {
    const auth = requireAuth(request);
    const { projectId } = projectParams.parse(request.params);
    const input = z
      .object({ source: sourceSchema, request: solutionInstallRequestSchema })
      .strict()
      .parse(request.body);
    const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');

    const result = await container.solutions.install({
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      source: input.source as PackageSource,
      request: input.request,
      actorUserId: auth.userId,
    });
    void reply.status(201);
    return result;
  });

  /**
   * What a candidate source would produce, before it is chosen.
   *
   * Real numbers of this project, so it needs the data grant a dashboard
   * would (ADR 0006) on top of the right to manage the catalog.
   */
  app.post('/projects/:projectId/solutions/mapping-preview', guard, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = projectParams.parse(request.params);
    const { sourceMetric } = z
      .object({
        sourceMetric: z
          .string()
          .max(64)
          .regex(/^[a-z][a-z0-9_]*$/),
      })
      .strict()
      .parse(request.body);
    const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');
    await container.access.assertProjectData(auth, scope.projectId);

    const [site] = await container.matomo.listProjectSites(scope.projectId);
    if (!site) return { value: null };

    const value = await container.analytics.previewSource({
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      siteId: site.id,
      sourceMetric,
      timeRangePreset: 'last_7_days',
      permissionContextId: scope.permissionContextId,
    });
    return { value, timeRange: 'last_7_days' };
  });

  app.get('/projects/:projectId/templates', guard, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = projectParams.parse(request.params);
    const { kind } = z.object({ kind: z.enum(TEMPLATE_KINDS).optional() }).parse(request.query);
    const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');
    return {
      templates: await container.solutions.listTemplates(scope.tenantId, scope.projectId, kind),
    };
  });

  /** A widget template as ready-to-insert widget configuration, for the editor. */
  app.get('/projects/:projectId/templates/:templateId/widget', guard, async (request) => {
    const auth = requireAuth(request);
    const { projectId, templateId } = z
      .object({ projectId: z.string().min(1), templateId: z.string().min(1) })
      .parse(request.params);
    const scope = await requireProjectScope(container, auth, projectId, 'dashboard.edit_draft');
    const { widgets } = await container.solutions.resolveTemplate(
      scope.tenantId,
      scope.projectId,
      templateId,
    );
    return { widget: widgets[0] };
  });

  app.post(
    '/projects/:projectId/templates/:templateId/dashboards',
    guard,
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId, templateId } = z
        .object({ projectId: z.string().min(1), templateId: z.string().min(1) })
        .parse(request.params);
      const { name } = z
        .object({ name: z.string().trim().max(200).optional() })
        .strict()
        .parse(request.body ?? {});
      const scope = await requireProjectScope(container, auth, projectId, 'dashboard.create');

      const result = await container.solutions.createDashboardFromTemplate({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        templateId,
        ...(name ? { name } : {}),
        actorUserId: auth.userId,
      });
      void reply.status(201);
      return result;
    },
  );

  /**
   * Export for authorised authors: dashboards and the definitions under them,
   * as a package. Needs `semantic.manage` (it carries definitions) and edit
   * access to every dashboard exported (it carries their structure).
   */
  app.post('/projects/:projectId/solutions/export', guard, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = projectParams.parse(request.params);
    const input = z
      .object({
        dashboardIds: z.array(z.string().min(1)).min(1).max(20),
        packageId: packageIdSchema,
        packageVersion: packageVersionSchema,
        name: z.string().trim().min(1).max(200),
        publisher: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(request.body);
    const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');

    const owned = await container.dashboards.listForProject(scope.tenantId, scope.projectId);
    for (const dashboardId of input.dashboardIds) {
      // Only this project's dashboards: an id from elsewhere is not found here.
      if (!owned.some((dashboard) => dashboard.id === dashboardId)) {
        throw new AppError('not_found', {
          code: 'dashboard_not_found',
          messageKey: 'dashboard.not_found',
        });
      }
      await container.access.assertDashboard(auth, dashboardId, 'edit');
    }

    return {
      package: await container.solutions.exportPackage({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        ...input,
        actorUserId: auth.userId,
      }),
    };
  });
}
