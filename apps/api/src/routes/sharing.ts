import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  type Breakpoint,
  comparisonModeSchema,
  type DashboardPermissions,
  exportRequestSchema,
  type InternalAccessSummary,
  type Locale,
  SHARE_MAX_LIFETIME_DAYS,
  SHARE_SUGGESTED_LIFETIME_DAYS,
  type ShareAccess,
  type ShareExpiryWindow,
  shareCreateRequestSchema,
  type SharedLayout,
  shareUnlockRequestSchema,
  timeRangePresetSchema,
} from '@axp/contracts';
import { addDays, todayIn } from '@axp/core';
import type { BuildPresentationInput, Container, ResolvedShare } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { defaultPreset, scopeForDashboard } from '../lib/dashboard-scope';
import { sendFile } from './exports';

/**
 * Where a recipient's link token and password session travel: request
 * headers, set by the web server. Never the API's URL, because URLs end up in
 * access logs and a share token in a log is a share handed to whoever reads it.
 */
export const SHARE_TOKEN_HEADER = 'x-share-token';
export const SHARE_SESSION_HEADER = 'x-share-session';

const publicViewQuerySchema = z.object({
  timeRange: timeRangePresetSchema.exclude(['custom']).optional(),
  comparison: comparisonModeSchema.exclude(['custom']).optional(),
  breakpoint: z.enum(['desktop', 'tablet', 'mobile']).default('desktop'),
  locale: z.enum(['de', 'en']).default('de'),
});
type PublicViewQuery = z.infer<typeof publicViewQuerySchema>;

/**
 * Sharing (Master Spec §15, Shared Contract §11).
 *
 * Two audiences on two route families. Signed-in editors create, list and
 * revoke shares - `dashboard.share` plus a view grant on the dashboard. Share
 * recipients are not signed in: every public route resolves the link afresh,
 * serves only the published dashboard, never the draft or internal notes, and
 * enforces the share's rights on the server.
 */
export function registerSharingRoutes(app: FastifyInstance, container: Container): void {
  // --- signed-in: managing shares ------------------------------------------

  app.get('/dashboards/:dashboardId/shares', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
    const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.share');
    const today = todayIn(scope.timezone, container.clock.now());
    const expiry: ShareExpiryWindow = {
      timezone: scope.timezone,
      min: today,
      max: addDays(today, SHARE_MAX_LIFETIME_DAYS),
      suggested: addDays(today, SHARE_SUGGESTED_LIFETIME_DAYS),
    };
    // Listing and revoking stay possible without the module: links already
    // handed out must remain controllable. Only creating needs it.
    const entitled = await container.entitlements.hasEntitlement(
      { tenantId: scope.tenantId },
      'sharing.external',
    );
    return { shares: await container.shares.list(scope.tenantId, dashboardId), expiry, entitled };
  });

  app.post(
    '/dashboards/:dashboardId/shares',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const body = shareCreateRequestSchema.parse(request.body);
      const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.share');
      await container.entitlements.require({ tenantId: scope.tenantId }, 'sharing.external');

      const created = await container.shares.create({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        dashboardId,
        timezone: scope.timezone,
        actorUserId: auth.userId,
        request: body,
      });
      void reply.status(201);
      return created;
    },
  );

  app.post(
    '/dashboards/:dashboardId/shares/:shareId/revoke',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { dashboardId, shareId } = z
        .object({ dashboardId: z.string(), shareId: z.string() })
        .parse(request.params);
      const scope = await scopeForDashboard(container, auth, dashboardId, 'dashboard.share');
      return container.shares.revoke({
        tenantId: scope.tenantId,
        dashboardId,
        shareId,
        actorUserId: auth.userId,
      });
    },
  );

  /** Which distribution actions to offer on the viewer. */
  app.get(
    '/dashboards/:dashboardId/permissions',
    { onRequest: [app.authenticate] },
    async (request): Promise<DashboardPermissions> => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const scope = await scopeForDashboard(
        container,
        auth,
        dashboardId,
        'dashboard.read_published',
      );
      const target = { type: 'project' as const, projectId: scope.projectId };
      const [canExport, canShare, mayEdit, editGrant] = await Promise.all([
        container.authorization.can(auth, 'dashboard.export', target),
        container.authorization.can(auth, 'dashboard.share', target),
        container.authorization.can(auth, 'dashboard.edit_draft', target),
        container.access.decideDashboard(auth, dashboardId, 'edit'),
      ]);
      return { canExport, canShare, canEdit: mayEdit && editGrant.granted };
    },
  );

  /**
   * Internal distribution is a permission, not a link: who already has
   * access, and where that is changed (development plan, Phase 7).
   */
  app.get(
    '/dashboards/:dashboardId/internal-access',
    { onRequest: [app.authenticate] },
    async (request): Promise<InternalAccessSummary> => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const scope = await scopeForDashboard(
        container,
        auth,
        dashboardId,
        'dashboard.read_published',
      );

      const [onDashboard, onProject, canManage] = await Promise.all([
        container.access.listGrants(scope.tenantId, {
          objectType: 'dashboard',
          objectId: dashboardId,
        }),
        container.access.listGrants(scope.tenantId, {
          objectType: 'project',
          objectId: scope.projectId,
        }),
        container.authorization.can(auth, 'tenant.role_assignment.manage', {
          type: 'tenant',
          tenantId: scope.tenantId,
        }),
      ]);

      return {
        grants: [
          ...onDashboard.map((grant) => ({ ...grantView(grant), via: 'dashboard' as const })),
          ...onProject.map((grant) => ({ ...grantView(grant), via: 'project' as const })),
        ],
        canManage,
        ...(canManage
          ? {
              manageHref: `/admin/access?tenant=${scope.tenantId}&view=objects&dashboard=${dashboardId}`,
            }
          : {}),
      };
    },
  );

  // --- public: the recipient's side -----------------------------------------

  const publicLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get('/public/share', publicLimit, async (request): Promise<ShareAccess> => {
    const resolution = await container.shares.resolve(...credentialsOf(request));
    if (resolution.state === 'unavailable') return { state: 'unavailable' };
    if (resolution.state === 'password_required') return { state: 'password_required' };
    await container.shares.touch(resolution.share);
    return { state: 'available', meta: resolution.meta };
  });

  app.post(
    '/public/share/unlock',
    // Password guessing through the web is slowed here and paused per share.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const { password } = shareUnlockRequestSchema.parse(request.body);
      const [token] = credentialsOf(request);
      return container.shares.unlock(token, password);
    },
  );

  app.get('/public/share/layout', publicLimit, async (request): Promise<SharedLayout> => {
    const share = await requireShare(container, request);
    const query = parseQuery(request, share);
    const layout = container.presentation.buildLayout(viewInput(share, query));
    return { ...layout, share: share.meta };
  });

  app.get('/public/share/widgets/:widgetId', publicLimit, async (request) => {
    const share = await requireShare(container, request);
    const { widgetId } = z.object({ widgetId: z.string().min(1).max(64) }).parse(request.params);
    const query = parseQuery(request, share);
    return container.presentation.buildTile({ ...viewInput(share, query), widgetId });
  });

  app.get('/public/share/widgets/:widgetId/detail', publicLimit, async (request) => {
    const share = await requireShare(container, request);
    requireRight(share, 'detail');
    const { widgetId } = z.object({ widgetId: z.string().min(1).max(64) }).parse(request.params);
    const query = parseQuery(request, share);
    return container.presentation.buildDetail({
      ...viewInput(share, query),
      widgetId,
      capabilities: share.rights.export ? ['dashboard.export'] : [],
    });
  });

  app.post(
    '/public/share/exports',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const share = await requireShare(container, request);
      requireRight(share, 'export');
      const body = exportRequestSchema.parse(request.body);
      const { locale } = z
        .object({ locale: z.enum(['de', 'en']).default('de') })
        .parse(request.query ?? {});
      const query = checkRights(share, {
        breakpoint: 'desktop',
        locale,
        ...(body.timeRange && body.timeRange !== 'custom' ? { timeRange: body.timeRange } : {}),
        ...(body.comparison && body.comparison !== 'custom' ? { comparison: body.comparison } : {}),
      });

      const artifact = await container.exports.create({
        tenantId: share.share.tenantId,
        dashboardId: share.share.dashboardId,
        format: body.format,
        ...(body.widgetId ? { widgetId: body.widgetId } : {}),
        view: viewInput(share, query),
        requester: {
          kind: 'share',
          shareId: share.share.id,
          shareExpiresAt: share.share.expiresAt,
        },
      });
      void reply.status(201);
      return artifact;
    },
  );

  app.get('/public/share/exports/:artifactId', publicLimit, async (request, reply) => {
    const share = await requireShare(container, request);
    requireRight(share, 'export');
    const { artifactId } = z
      .object({ artifactId: z.string().min(1).max(64) })
      .parse(request.params);
    const file = await container.exports.open(artifactId, {
      kind: 'share',
      shareId: share.share.id,
    });
    return sendFile(reply, file);
  });
}

function credentialsOf(request: FastifyRequest): [string, string | undefined] {
  const token = request.headers[SHARE_TOKEN_HEADER];
  const session = request.headers[SHARE_SESSION_HEADER];
  return [
    typeof token === 'string' ? token : '',
    typeof session === 'string' && session.length > 0 ? session : undefined,
  ];
}

async function requireShare(container: Container, request: FastifyRequest): Promise<ResolvedShare> {
  const resolution = await container.shares.resolve(...credentialsOf(request));
  if (resolution.state === 'available') return resolution;
  if (resolution.state === 'password_required') {
    throw new AppError('authentication_required', {
      code: 'share_password_required',
      messageKey: 'share.password_required',
      internalMessage: 'The share needs its password first.',
    });
  }
  throw new AppError('not_found', {
    code: 'share_unavailable',
    messageKey: 'share.unavailable',
    internalMessage: 'The share is unknown, revoked, expired or its dashboard is gone.',
  });
}

function requireRight(share: ResolvedShare, right: 'detail' | 'export'): void {
  if (share.rights[right]) return;
  throw new AppError('permission_denied', {
    code: 'share_right_missing',
    messageKey: `share.right_missing.${right}`,
    internalMessage: `Share ${share.share.id} does not allow ${right}.`,
  });
}

function parseQuery(request: FastifyRequest, share: ResolvedShare): PublicViewQuery {
  return checkRights(share, publicViewQuerySchema.parse(request.query ?? {}));
}

/**
 * A recipient may change the period or the comparison only when the share
 * says so. Asking for the dashboard's own default is always fine.
 */
function checkRights(share: ResolvedShare, query: PublicViewQuery): PublicViewQuery {
  const preset = defaultPreset(share.snapshot);
  if (query.timeRange && query.timeRange !== preset && !share.rights.timeRange) {
    throw new AppError('permission_denied', {
      code: 'share_right_missing',
      messageKey: 'share.right_missing.timeRange',
      internalMessage: `Share ${share.share.id} does not allow changing the time range.`,
    });
  }
  if (
    query.comparison &&
    query.comparison !== share.snapshot.defaultComparison.mode &&
    !share.rights.comparison
  ) {
    throw new AppError('permission_denied', {
      code: 'share_right_missing',
      messageKey: 'share.right_missing.comparison',
      internalMessage: `Share ${share.share.id} does not allow changing the comparison.`,
    });
  }
  return query;
}

/**
 * The view a recipient gets: the latest published version, the dashboard's
 * defaults unless the share allows otherwise, and the external audience - so
 * the builder itself leaves every internal note out.
 */
function viewInput(share: ResolvedShare, query: PublicViewQuery): BuildPresentationInput {
  return {
    snapshot: share.snapshot,
    meta: {
      // The recipient addresses the share, not the dashboard behind it.
      dashboardId: share.share.id,
      name: share.snapshot.name,
      ...(share.snapshot.description ? { description: share.snapshot.description } : {}),
      publishedVersion: share.publishedVersion,
      isDraftPreview: false,
      projectName: '',
      tenantName: share.tenantName,
    },
    tenantId: share.share.tenantId,
    projectId: share.share.projectId,
    site: share.site,
    timeRangePreset: query.timeRange ?? defaultPreset(share.snapshot),
    comparisonMode: query.comparison ?? share.snapshot.defaultComparison.mode,
    breakpoint: query.breakpoint as Breakpoint,
    locale: query.locale as Locale,
    permissionContextId: `share:${share.share.id}`,
    audience: 'external',
  };
}

function grantView(grant: { subjectType: string; subjectLabel: string; access: 'view' | 'edit' }) {
  return {
    subjectType: grant.subjectType as 'user' | 'group',
    subjectName: grant.subjectLabel,
    access: grant.access,
  };
}
