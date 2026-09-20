import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireProjectScope } from '../lib/project-scope';

const projectParams = z.object({ projectId: z.string().min(1) });

/**
 * Project context (Master Spec §8, §13).
 *
 * Listing is driven by the caller's resolved authorization context, so a
 * project a user may not see never appears - the filter is not applied in the
 * UI, it is applied before anything leaves the server.
 */
export function registerProjectRoutes(app: FastifyInstance, container: Container): void {
  app.get('/projects', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const projects = await container.projects.listAccessible({
      tenantIds: auth.tenantIds,
      projectIds: auth.projectIds,
    });
    return { projects };
  });

  app.get('/projects/:projectId', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = projectParams.parse(request.params);
    const scope = await requireProjectScope(container, auth, projectId, 'project.read');

    const [project, setup, sites] = await Promise.all([
      container.projects.getProject(scope.tenantId, scope.projectId),
      container.projects.getSetupStatus(scope.tenantId, scope.projectId),
      container.matomo.listProjectSites(scope.projectId),
    ]);

    return { project, setup, sites };
  });

  /**
   * Semantic definitions available in the project.
   *
   * The catalog itself is not analytics data, so `semantic.read` is enough;
   * seeing a definition does not imply being able to query with it.
   */
  app.get(
    '/projects/:projectId/semantic-definitions',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');

      const definitions = await container.semantics.listForProject(scope.tenantId, scope.projectId);
      return { definitions };
    },
  );
}
