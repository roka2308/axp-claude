import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { AppError, type AuthContext, ENTITLEMENTS, renderThemeStylesheet } from '@axp/contracts';
import { dashboards, projects } from '@axp/db';
import type { Container, ThemeTarget } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireRecentAuthentication } from './admin';
import { SHARE_SESSION_HEADER, SHARE_TOKEN_HEADER } from './sharing';

const draftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // Validated against the allowlist and safe value shapes in the service;
    // here only the shape of the envelope and its size.
    tokens: z.record(z.string().max(80), z.string().max(200)),
    darkTokens: z.record(z.string().max(80), z.string().max(200)).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value.tokens).length + Object.keys(value.darkTokens ?? {}).length <= 200,
    {
      message: 'too many tokens',
    },
  );

/**
 * Themes, entitlements, release metadata and diagnostics (Phase 9).
 *
 * Who may change what: the platform theme needs `platform.theme.manage`; a
 * customer's or a project's theme `tenant.theme.manage` in that customer.
 * Modules per customer are a platform decision (`platform.entitlement.manage`).
 * Diagnostics are platform-only, and generating a bundle needs a fresh
 * password confirmation.
 */
export function registerProductizationRoutes(app: FastifyInstance, container: Container): void {
  // --- themes -------------------------------------------------------------------

  const target = async (request: FastifyRequest, auth: AuthContext): Promise<ThemeTarget> => {
    const params = request.params as { scope?: string; id?: string };
    if (params.scope === 'platform') {
      await container.authorization.assert(auth, 'platform.theme.manage', { type: 'platform' });
      return { scope: 'platform' };
    }
    if (params.scope === 'tenants' && params.id) {
      await container.authorization.assert(auth, 'tenant.theme.manage', {
        type: 'tenant',
        tenantId: params.id,
      });
      return { scope: 'tenant', tenantId: params.id };
    }
    if (params.scope === 'projects' && params.id) {
      const [project] = await container.db
        .select({ tenantId: projects.tenantId })
        .from(projects)
        .where(eq(projects.id, params.id))
        .limit(1);
      if (!project) {
        throw new AppError('not_found', {
          code: 'project_not_found',
          messageKey: 'project.not_found',
          internalMessage: `Project ${params.id} does not exist.`,
        });
      }
      await container.authorization.assert(auth, 'tenant.theme.manage', {
        type: 'tenant',
        tenantId: project.tenantId,
      });
      return { scope: 'project', tenantId: project.tenantId, projectId: params.id };
    }
    throw new AppError('not_found', {
      code: 'theme_scope_unknown',
      messageKey: 'theme.scope_unknown',
      internalMessage: `Unknown theme scope ${params.scope}.`,
    });
  };

  const themePaths = ['/themes/:scope', '/themes/:scope/:id'];
  for (const base of themePaths) {
    app.get(base, { onRequest: [app.authenticate] }, async (request) => {
      const auth = requireAuth(request);
      return container.themes.overview(await target(request, auth));
    });

    app.put(`${base}/draft`, { onRequest: [app.authenticate] }, async (request) => {
      const auth = requireAuth(request);
      const body = draftSchema.parse(request.body);
      return container.themes.saveDraft({
        target: await target(request, auth),
        name: body.name,
        tokens: body.tokens,
        ...(body.darkTokens ? { darkTokens: body.darkTokens } : {}),
        actorUserId: auth.userId,
      });
    });

    app.delete(`${base}/draft`, { onRequest: [app.authenticate] }, async (request) => {
      const auth = requireAuth(request);
      return container.themes.discardDraft(await target(request, auth));
    });

    app.post(`${base}/validate`, { onRequest: [app.authenticate] }, async (request) => {
      const auth = requireAuth(request);
      return container.themes.validateDraft(await target(request, auth));
    });

    app.post(`${base}/publish`, { onRequest: [app.authenticate] }, async (request) => {
      const auth = requireAuth(request);
      return container.themes.publish({
        target: await target(request, auth),
        actorUserId: auth.userId,
      });
    });

    app.post(`${base}/rollback`, { onRequest: [app.authenticate] }, async (request) => {
      const auth = requireAuth(request);
      const { version } = z.object({ version: z.number().int().positive() }).parse(request.body);
      return container.themes.rollback({
        target: await target(request, auth),
        version,
        actorUserId: auth.userId,
      });
    });
  }

  /**
   * The stylesheet for a signed-in person's view: the platform theme, their
   * customer's and - on a project page - the project's, as far as the customer
   * is entitled to its own. Token declarations only.
   */
  app.get('/theme/effective', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const query = z
      .object({
        projectId: z.string().max(64).optional(),
        dashboardId: z.string().max(64).optional(),
      })
      .parse(request.query ?? {});
    let projectId = query.projectId;
    if (!projectId && query.dashboardId) {
      const [dashboard] = await container.db
        .select({ projectId: dashboards.projectId })
        .from(dashboards)
        .where(eq(dashboards.id, query.dashboardId))
        .limit(1);
      projectId = dashboard?.projectId;
    }
    let tenantId: string | null = auth.tenantIds[0] ?? null;
    let project: string | null = null;
    // Only a project of a customer the caller belongs to; anything else gets
    // their own customer's theme. A theme is no secret, but it is no one
    // else's business either.
    if (projectId) {
      const [row] = await container.db
        .select({ tenantId: projects.tenantId })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (row && auth.tenantIds.includes(row.tenantId as never)) {
        tenantId = row.tenantId;
        project = projectId;
      }
    }
    const theme = await container.themes.effective({ tenantId, projectId: project });
    return { css: renderThemeStylesheet(theme) };
  });

  /** Before sign-in there is no customer yet: the platform theme. */
  app.get(
    '/theme/platform',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async () => {
      return { css: renderThemeStylesheet(await container.themes.effective({})) };
    },
  );

  /** A shared dashboard looks like its customer's product. */
  app.get(
    '/public/share/theme',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const token = request.headers[SHARE_TOKEN_HEADER];
      const session = request.headers[SHARE_SESSION_HEADER];
      const resolution = await container.shares.resolve(
        typeof token === 'string' ? token : '',
        typeof session === 'string' ? session : undefined,
      );
      if (resolution.state !== 'available')
        return { css: renderThemeStylesheet(await container.themes.effective({})) };
      const theme = await container.themes.effective({
        tenantId: resolution.share.tenantId,
        projectId: resolution.share.projectId,
      });
      return { css: renderThemeStylesheet(theme) };
    },
  );

  // --- entitlements ---------------------------------------------------------------

  const tenantParams = z.object({ tenantId: z.string().min(1) });

  app.get(
    '/admin/platform/tenants/:tenantId/entitlements',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId } = tenantParams.parse(request.params);
      await container.authorization.assert(auth, 'platform.entitlement.manage', {
        type: 'platform',
      });
      return {
        entitlements: await container.entitlements.list(tenantId),
        featureFlags: container.entitlements.featureFlags(),
      };
    },
  );

  app.put(
    '/admin/platform/tenants/:tenantId/entitlements/:entitlement',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId, entitlement } = z
        .object({ tenantId: z.string().min(1), entitlement: z.enum(ENTITLEMENTS) })
        .parse(request.params);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
      await container.authorization.assert(auth, 'platform.entitlement.manage', {
        type: 'platform',
      });
      return {
        entitlements: await container.entitlements.set({
          tenantId,
          entitlement,
          enabled,
          actorUserId: auth.userId,
        }),
      };
    },
  );

  /** What a customer has, for its own administrators to see. */
  app.get(
    '/admin/tenants/:tenantId/entitlements',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId } = tenantParams.parse(request.params);
      await container.authorization.assert(auth, 'tenant.read', { type: 'tenant', tenantId });
      return { entitlements: await container.entitlements.list(tenantId) };
    },
  );

  // --- release metadata and diagnostics -------------------------------------------

  app.get('/admin/platform/system', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    await container.authorization.assert(auth, 'platform.diagnostics.read', { type: 'platform' });
    return container.diagnostics.overview();
  });

  app.post(
    '/admin/platform/diagnostics',
    { onRequest: [app.authenticate], config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireAuth(request);
      await container.authorization.assert(auth, 'platform.diagnostics.read', { type: 'platform' });
      requireRecentAuthentication(request);
      const bundle = await container.diagnostics.generateBundle(auth.userId);
      void reply.status(201);
      return bundle;
    },
  );

  app.get(
    '/admin/platform/diagnostics/:bundleId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { bundleId } = z.object({ bundleId: z.string().min(1).max(64) }).parse(request.params);
      await container.authorization.assert(auth, 'platform.diagnostics.read', { type: 'platform' });
      const file = await container.diagnostics.open(bundleId, auth.userId);
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file.content);
    },
  );
}
