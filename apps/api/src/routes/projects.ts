import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import {
  type Capability,
  contextProfileSchema,
  SETUP_STEP_KEYS,
  type TenantId,
} from '@axp/contracts';
import type { Container } from '@axp/core';
import { matomoConnections, matomoSites, projectSites, tenants } from '@axp/db';
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

  /**
   * Where the caller may create a project, and what each tenant already has
   * to offer as a data source - its connections and the sites other projects
   * read (Master Spec §13: connections are tenant-level and reused).
   */
  app.get('/projects/creation-options', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const allowed: TenantId[] = [];
    for (const tenantId of auth.tenantIds) {
      if (await container.authorization.can(auth, 'project.create', { type: 'tenant', tenantId })) {
        allowed.push(tenantId);
      }
    }
    if (allowed.length === 0) return { tenants: [] };

    const [tenantRows, connectionRows, siteRows] = await Promise.all([
      container.db
        .select({ id: tenants.id, name: tenants.name })
        .from(tenants)
        .where(inArray(tenants.id, allowed)),
      container.db
        .select({
          id: matomoConnections.id,
          tenantId: matomoConnections.tenantId,
          name: matomoConnections.name,
          status: matomoConnections.status,
        })
        .from(matomoConnections)
        .where(inArray(matomoConnections.tenantId, allowed)),
      container.db
        .select({
          id: matomoSites.id,
          name: matomoSites.name,
          timezone: matomoSites.timezone,
          connectionId: matomoSites.connectionId,
          tenantId: matomoConnections.tenantId,
        })
        .from(matomoSites)
        .innerJoin(matomoConnections, eq(matomoConnections.id, matomoSites.connectionId))
        .where(inArray(matomoConnections.tenantId, allowed)),
    ]);

    const usage = siteRows.length
      ? await container.db
          .select({ siteId: projectSites.siteId })
          .from(projectSites)
          .where(
            inArray(
              projectSites.siteId,
              siteRows.map((site) => site.id),
            ),
          )
      : [];

    return {
      tenants: tenantRows.map((tenant) => ({
        ...tenant,
        connections: connectionRows.filter((row) => row.tenantId === tenant.id),
        sites: siteRows
          .filter((row) => row.tenantId === tenant.id)
          .map((site) => ({
            id: site.id,
            name: site.name,
            timezone: site.timezone,
            connectionName: connectionRows.find((row) => row.id === site.connectionId)?.name ?? '',
            usedByProjects: usage.filter((entry) => entry.siteId === site.id).length,
          })),
      })),
    };
  });

  /** Project creation, the small flow (Master Spec §13). */
  app.post('/projects', { onRequest: [app.authenticate] }, async (request, reply) => {
    const auth = requireAuth(request);
    const input = z
      .object({
        tenantId: z.string().min(1),
        name: z.string().trim().min(2).max(200),
        slug: z
          .string()
          .trim()
          .min(2)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        description: z.string().trim().max(1000).optional(),
        timezone: z.string().trim().min(1).max(64).default('Europe/Berlin'),
        defaultLocale: z.enum(['de', 'en']).default('de'),
        contextProfile: contextProfileSchema.default({}),
        source: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('existing_site'), siteId: z.string().min(1) }).strict(),
          z
            .object({
              kind: z.literal('connection_site'),
              connectionId: z.string().min(1),
              matomoSiteId: z.number().int().positive(),
            })
            .strict(),
          z.object({ kind: z.literal('later') }).strict(),
        ]),
      })
      .strict()
      .parse(request.body);

    // The tenant id comes from the browser, so it is authorised on its own -
    // never trusted because the caller happens to belong to some tenant.
    await container.authorization.assert(auth, 'project.create', {
      type: 'tenant',
      tenantId: input.tenantId,
    });
    if (input.source.kind === 'connection_site') {
      await container.authorization.assert(auth, 'tenant.settings.update', {
        type: 'tenant',
        tenantId: input.tenantId,
      });
    }

    const result = await container.projects.createProject({
      ...input,
      ...(input.description ? { description: input.description } : {}),
      actorUserId: auth.userId,
    });
    void reply.status(201);
    return result;
  });

  app.put(
    '/projects/:projectId/context-profile',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const scope = await requireProjectScope(
        container,
        auth,
        projectId,
        'project.settings.update',
      );
      const profile = contextProfileSchema.parse(request.body);

      return {
        contextProfile: await container.projects.updateContextProfile({
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          profile,
          actorUserId: auth.userId,
        }),
      };
    },
  );

  app.put(
    '/projects/:projectId/setup-steps/:step',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId, step } = z
        .object({ projectId: z.string().min(1), step: z.enum(SETUP_STEP_KEYS) })
        .parse(request.params);
      const { notRelevant } = z.object({ notRelevant: z.boolean() }).strict().parse(request.body);
      const scope = await requireProjectScope(
        container,
        auth,
        projectId,
        'project.settings.update',
      );

      return {
        setup: await container.projects.setStepRelevance({
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          step,
          notRelevant,
        }),
      };
    },
  );
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
