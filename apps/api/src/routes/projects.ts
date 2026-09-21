import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Capability } from '@axp/contracts';
import type { Container } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireProjectScope } from '../lib/project-scope';

const projectParams = z.object({ projectId: z.string().min(1) });

/**
 * Capabilities the project surfaces offer an action for.
 *
 * The web app must not re-derive authorization: it asks which of these the
 * caller holds and hides what is not offered. The server decides, here and on
 * every write - hiding a button is a courtesy, never a control
 * (Shared Contract §4).
 */
const PROJECT_SURFACE_CAPABILITIES: readonly Capability[] = [
  'project.settings.update',
  'dashboard.read_published',
  'dashboard.create',
  'dashboard.edit_draft',
  'dashboard.publish',
  'semantic.read',
  'semantic.manage',
];

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

    const [project, setup, sites, capabilities] = await Promise.all([
      container.projects.getProject(scope.tenantId, scope.projectId),
      container.projects.getSetupStatus(scope.tenantId, scope.projectId),
      container.matomo.listProjectSites(scope.projectId),
      grantedCapabilities(container, auth, scope.projectId, scope.tenantId),
    ]);

    return { project, setup, sites, capabilities };
  });

}

/**
 * Which of the project-surface capabilities this caller actually holds.
 *
 * `tenant.settings.update` is answered against the owning tenant, because
 * connecting Matomo is tenant administration even though it is reached from a
 * project page.
 */
async function grantedCapabilities(
  container: Container,
  auth: Parameters<typeof requireProjectScope>[1],
  projectId: string,
  tenantId: string,
): Promise<Capability[]> {
  const checks = await Promise.all(
    PROJECT_SURFACE_CAPABILITIES.map(async (capability) => ({
      capability,
      granted: await container.authorization.can(auth, capability, { type: 'project', projectId }),
    })),
  );

  const granted = checks.filter((check) => check.granted).map((check) => check.capability);

  if (
    await container.authorization.can(auth, 'tenant.settings.update', { type: 'tenant', tenantId })
  ) {
    granted.push('tenant.settings.update');
  }

  return granted;
}
