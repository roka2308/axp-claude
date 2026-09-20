import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireProjectScope, requireTenantScope } from '../lib/project-scope';

const tenantParams = z.object({ tenantId: z.string().min(1) });
const connectionParams = tenantParams.extend({ connectionId: z.string().min(1) });

const connectionInputSchema = z.object({
  name: z.string().min(1).max(200),
  baseUrl: z.string().min(1).max(500),
  token: z.string().min(8).max(500),
});

/**
 * Matomo connections and sites (Master Spec §13).
 *
 * Nothing in this file ever returns a credential. The token is accepted on the
 * way in, sealed, and from then on only opened inside the API process for the
 * duration of a call.
 */
export function registerMatomoRoutes(app: FastifyInstance, container: Container): void {
  app.get(
    '/tenants/:tenantId/matomo-connections',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId } = tenantParams.parse(request.params);
      await requireTenantScope(container, auth, tenantId, 'tenant.settings.update');

      const connections = await container.matomo.listConnections(tenantId);
      const withCapabilities = await Promise.all(
        connections.map(async (connection) => ({
          ...connection,
          capabilities: await container.matomo.getLatestCapabilities(connection.id),
        })),
      );

      return { connections: withCapabilities };
    },
  );

  /** Probes a connection without storing it, so setup can fail before it commits. */
  app.post(
    '/tenants/:tenantId/matomo-connections/test',
    { onRequest: [app.authenticate], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId } = tenantParams.parse(request.params);
      const body = connectionInputSchema.parse(request.body);
      await requireTenantScope(container, auth, tenantId, 'tenant.settings.update');

      return container.matomo.testConnection(body.baseUrl, body.token);
    },
  );

  app.post(
    '/tenants/:tenantId/matomo-connections',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { tenantId } = tenantParams.parse(request.params);
      const body = connectionInputSchema.parse(request.body);
      await requireTenantScope(container, auth, tenantId, 'tenant.settings.update');

      const connection = await container.matomo.createConnection({
        tenantId,
        name: body.name,
        baseUrl: body.baseUrl,
        token: body.token,
        actorUserId: auth.userId,
      });

      // Detect capabilities immediately: a connection whose compatibility is
      // unknown is not something setup can reason about.
      const capabilities = await container.matomo.refreshCapabilities(
        tenantId,
        connection.id,
        auth.userId,
      );

      void reply.status(201);
      return { connection, capabilities };
    },
  );

  app.post(
    '/tenants/:tenantId/matomo-connections/:connectionId/refresh-capabilities',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId, connectionId } = connectionParams.parse(request.params);
      await requireTenantScope(container, auth, tenantId, 'tenant.settings.update');

      return container.matomo.refreshCapabilities(tenantId, connectionId, auth.userId);
    },
  );

  /** Sites the connection can see. Read live from Matomo; nothing is stored. */
  app.get(
    '/tenants/:tenantId/matomo-connections/:connectionId/sites',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId, connectionId } = connectionParams.parse(request.params);
      await requireTenantScope(container, auth, tenantId, 'tenant.settings.update');

      const sites = await container.matomo.listRemoteSites(tenantId, connectionId);
      return { sites };
    },
  );

  /**
   * Imports a site and assigns it to a project in one step.
   *
   * Both the project and the site are resolved and checked against the same
   * tenant before anything is written (Shared Contract §4).
   */
  app.post(
    '/projects/:projectId/sites',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(request.params);
      const body = z
        .object({
          connectionId: z.string().min(1),
          matomoSiteId: z.number().int().positive(),
        })
        .parse(request.body);

      const scope = await requireProjectScope(
        container,
        auth,
        projectId,
        'project.settings.update',
      );

      const { siteId } = await container.matomo.importSite(
        scope.tenantId,
        body.connectionId,
        body.matomoSiteId,
        auth.userId,
      );
      await container.matomo.assignSiteToProject(
        scope.tenantId,
        scope.projectId,
        siteId,
        auth.userId,
      );
      await container.projects.refreshSetupState(scope.tenantId, scope.projectId);

      void reply.status(201);
      return { siteId };
    },
  );
}
