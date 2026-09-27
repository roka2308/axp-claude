import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  type AuthContext,
  CAPABILITIES_BY_ROLE,
  type Capability,
  objectAccessSchema,
  objectTypeSchema,
  ROLE_DESCRIPTORS,
  scopeTypeSchema,
  subjectTypeSchema,
  SYSTEM_ROLES,
  systemRoleSchema,
  TENANT_LIFECYCLE_STATES,
  tenantLifecycleSchema,
} from '@axp/contracts';
import { type AccessChange, type Container } from '@axp/core';
import { requireAuth } from '../plugins/authentication';

/**
 * Administration (D5).
 *
 * Every route names its tenant in the path, and every route resolves and
 * authorizes that tenant server-side before reading anything: a tenant id from
 * the browser is a request, never a fact (Shared Contract §4).
 *
 * Reading follows the tenant capabilities; a Platform Admin may also read a
 * tenant's users and groups (`platform.tenant.read`) but changes them only by
 * holding a tenant role there - explicit, and audited like every other
 * assignment (roles_permissions.md: "Platform Admin cross-tenant actions are
 * explicit and audited").
 *
 * Sensitive actions - lifecycle changes, deactivation, handing out or taking
 * back an administrator role, deleting a group - need a recent
 * re-authentication.
 */

const tenantParams = z.object({ tenantId: z.string().uuid() });
const userParams = tenantParams.extend({ userId: z.string().uuid() });
const groupParams = tenantParams.extend({ groupId: z.string().uuid() });

const accessChangeSchema: z.ZodType<AccessChange> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assign_role'),
    subjectType: subjectTypeSchema,
    subjectId: z.string().min(1),
    role: systemRoleSchema,
    scopeType: scopeTypeSchema,
    scopeId: z.string(),
  }),
  z.object({ kind: z.literal('remove_role'), assignmentId: z.string().min(1) }),
  z.object({
    kind: z.literal('add_member'),
    groupId: z.string().min(1),
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('remove_member'),
    groupId: z.string().min(1),
    userId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('grant'),
    subjectType: subjectTypeSchema,
    subjectId: z.string().min(1),
    objectType: objectTypeSchema,
    objectId: z.string().min(1),
    access: objectAccessSchema,
  }),
  z.object({ kind: z.literal('revoke'), grantId: z.string().min(1) }),
  z.object({ kind: z.literal('delete_group'), groupId: z.string().min(1) }),
  z.object({ kind: z.literal('deactivate_user'), userId: z.string().min(1) }),
]);

export function registerAdminRoutes(app: FastifyInstance, container: Container): void {
  const guard = { onRequest: [app.authenticate] };

  // --- where the caller may administer -------------------------------------

  /**
   * The tenants this caller can administer or inspect, and what they may do
   * there - so the UI offers only what will work.
   */
  app.get('/admin/context', guard, async (request) => {
    const auth = requireAuth(request);
    const isPlatformAdmin = await container.authorization.can(auth, 'platform.tenant.read', {
      type: 'platform',
    });

    const tenantIds = isPlatformAdmin
      ? (await container.tenantAdmin.list()).map((tenant) => tenant.id)
      : auth.tenantIds;

    const tenants = [];
    for (const tenantId of tenantIds) {
      const capabilities = await tenantCapabilities(container, auth, tenantId);
      if (capabilities.length === 0 && !isPlatformAdmin) continue;
      const overview = await container.tenantAdmin.overview(tenantId);
      tenants.push({
        id: tenantId,
        name: overview.name,
        lifecycle: overview.lifecycle,
        capabilities,
      });
    }

    return { platformAdmin: isPlatformAdmin, tenants };
  });

  // --- users -----------------------------------------------------------------

  app.get('/admin/tenants/:tenantId/users', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const { q } = z.object({ q: z.string().max(100).optional() }).parse(request.query);
    await requireTenantRead(container, auth, tenantId);

    return { users: await container.userAdmin.list(tenantId, { ...(q ? { query: q } : {}) }) };
  });

  /** Invites a person. The invitation token is in this response and nowhere else. */
  app.post('/admin/tenants/:tenantId/users', guard, async (request, reply) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const input = z
      .object({
        email: z.string().email().max(320),
        firstName: z.string().trim().min(1).max(100),
        lastName: z.string().trim().min(1).max(100),
        locale: z.enum(['de', 'en']).default('de'),
      })
      .parse(request.body);
    await requireTenantCapability(container, auth, tenantId, 'tenant.user.invite');

    const result = await container.userAdmin.invite({
      tenantId,
      ...input,
      actorUserId: auth.userId,
    });
    void reply.status(201);
    return result;
  });

  /**
   * One person, answered as the Gate F5 question: who they are, what they
   * hold, and what that lets them do, where, and why.
   */
  app.get('/admin/tenants/:tenantId/users/:userId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, userId } = userParams.parse(request.params);
    await requireTenantRead(container, auth, tenantId);

    const detail = await container.userAdmin.detail(tenantId, userId);
    const [roles, effective] = await Promise.all([
      container.roles.listForUser(tenantId, userId),
      container.effectiveAccess.explainUser(tenantId, userId),
    ]);
    const grants = await container.access.listGrants(tenantId, {
      subjectIds: [userId, ...detail.groups.map((group) => group.id)],
    });

    return { user: detail, roles, grants, effective };
  });

  app.patch('/admin/tenants/:tenantId/users/:userId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, userId } = userParams.parse(request.params);
    const changes = z
      .object({
        firstName: z.string().trim().min(1).max(100).optional(),
        lastName: z.string().trim().min(1).max(100).optional(),
        locale: z.enum(['de', 'en']).optional(),
      })
      .strict()
      .parse(request.body);
    await requireTenantCapability(container, auth, tenantId, 'tenant.user.invite');

    await container.userAdmin.updateProfile({
      tenantId,
      userId,
      changes,
      actorUserId: auth.userId,
    });
    return { ok: true };
  });

  app.post('/admin/tenants/:tenantId/users/:userId/deactivate', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, userId } = userParams.parse(request.params);
    await requireTenantCapability(container, auth, tenantId, 'tenant.user.deactivate');
    requireRecentAuthentication(request);

    return container.userAdmin.deactivate({ tenantId, userId, actor: auth });
  });

  app.post('/admin/tenants/:tenantId/users/:userId/reactivate', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, userId } = userParams.parse(request.params);
    await requireTenantCapability(container, auth, tenantId, 'tenant.user.deactivate');

    await container.userAdmin.reactivate({ tenantId, userId, actor: auth });
    return { ok: true };
  });

  app.post('/admin/tenants/:tenantId/users/:userId/revoke-sessions', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, userId } = userParams.parse(request.params);
    await requireTenantCapability(container, auth, tenantId, 'tenant.user.deactivate');

    return container.userAdmin.revokeSessions({ tenantId, userId, actorUserId: auth.userId });
  });

  app.post('/admin/tenants/:tenantId/users/:userId/invitation', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, userId } = userParams.parse(request.params);
    await requireTenantCapability(container, auth, tenantId, 'tenant.user.invite');

    return container.userAdmin.reissueInvitation({ tenantId, userId, actorUserId: auth.userId });
  });

  // --- groups ----------------------------------------------------------------

  app.get('/admin/tenants/:tenantId/groups', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    await requireTenantRead(container, auth, tenantId);
    return { groups: await container.groups.list(tenantId) };
  });

  app.post('/admin/tenants/:tenantId/groups', guard, async (request, reply) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const input = z
      .object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).optional(),
      })
      .parse(request.body);
    await requireTenantCapability(container, auth, tenantId, 'tenant.group.manage');

    const created = await container.groups.create({ tenantId, ...input, actorUserId: auth.userId });
    void reply.status(201);
    return created;
  });

  app.get('/admin/tenants/:tenantId/groups/:groupId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, groupId } = groupParams.parse(request.params);
    await requireTenantRead(container, auth, tenantId);

    const [group, roles, grants] = await Promise.all([
      container.groups.get(tenantId, groupId),
      container.roles.listForGroup(tenantId, groupId),
      container.access.listGrants(tenantId, { subjectType: 'group', subjectIds: [groupId] }),
    ]);
    return { group, roles, grants };
  });

  app.patch('/admin/tenants/:tenantId/groups/:groupId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, groupId } = groupParams.parse(request.params);
    const input = z
      .object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).nullable().optional(),
      })
      .parse(request.body);
    await requireTenantCapability(container, auth, tenantId, 'tenant.group.manage');

    await container.groups.update({ tenantId, groupId, ...input, actorUserId: auth.userId });
    return { ok: true };
  });

  app.delete('/admin/tenants/:tenantId/groups/:groupId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, groupId } = groupParams.parse(request.params);
    await requireTenantCapability(container, auth, tenantId, 'tenant.group.manage');
    requireRecentAuthentication(request);

    await container.groups.delete({ tenantId, groupId, actorUserId: auth.userId });
    return { ok: true };
  });

  app.post('/admin/tenants/:tenantId/groups/:groupId/members', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, groupId } = groupParams.parse(request.params);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.body);
    await requireTenantCapability(container, auth, tenantId, 'tenant.group.manage');

    await container.groups.addMember({ tenantId, groupId, userId, actorUserId: auth.userId });
    return { ok: true };
  });

  app.delete('/admin/tenants/:tenantId/groups/:groupId/members/:userId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, groupId, userId } = groupParams
      .extend({ userId: z.string().uuid() })
      .parse(request.params);
    await requireTenantCapability(container, auth, tenantId, 'tenant.group.manage');

    await container.groups.removeMember({ tenantId, groupId, userId, actorUserId: auth.userId });
    return { ok: true };
  });

  // --- roles and grants -------------------------------------------------------

  /**
   * The "Rollen" view: what each of the five roles is for, what it carries,
   * the fact that none of them opens data by itself, and who holds it here.
   */
  app.get('/admin/tenants/:tenantId/roles', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    await requireTenantRead(container, auth, tenantId);

    return {
      catalogue: SYSTEM_ROLES.map((role) => ({
        role,
        allowedScopes: ROLE_DESCRIPTORS[role].allowedScopes,
        capabilities: CAPABILITIES_BY_ROLE[role],
        grantsAutomaticAnalyticsAccess: ROLE_DESCRIPTORS[role].grantsAutomaticAnalyticsAccess,
      })),
      assignments: await container.roles.listForTenant(tenantId),
    };
  });

  app.get('/admin/tenants/:tenantId/assignable-roles', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const { scopeType, scopeId } = z
      .object({ scopeType: scopeTypeSchema, scopeId: z.string() })
      .parse(request.query);
    await requireTenantRead(container, auth, tenantId);

    return { roles: await container.roles.assignableRoles(auth, scopeType, scopeId) };
  });

  app.post('/admin/tenants/:tenantId/role-assignments', guard, async (request, reply) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const input = z
      .object({
        subjectType: subjectTypeSchema,
        subjectId: z.string().min(1),
        role: systemRoleSchema,
        scopeType: scopeTypeSchema,
        scopeId: z.string(),
      })
      .parse(request.body);
    await requireTenantRead(container, auth, tenantId);
    if (input.role === 'tenant_admin' || input.role === 'platform_admin') {
      requireRecentAuthentication(request);
    }

    // The service enforces who may hand out what, where - including that a
    // tenant admin can never produce a platform admin.
    const result = await container.roles.assign({ actor: auth, ...input });
    void reply.status(201);
    return result;
  });

  app.delete('/admin/tenants/:tenantId/role-assignments/:assignmentId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, assignmentId } = tenantParams
      .extend({ assignmentId: z.string().uuid() })
      .parse(request.params);
    await requireTenantRead(container, auth, tenantId);

    const current = (await container.roles.listForTenant(tenantId)).find(
      (assignment) => assignment.id === assignmentId,
    );
    if (current && (current.role === 'tenant_admin' || current.role === 'platform_admin')) {
      requireRecentAuthentication(request);
    }

    await container.roles.remove({ actor: auth, assignmentId });
    return { ok: true };
  });

  app.get('/admin/tenants/:tenantId/grants', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const filter = z
      .object({ objectType: objectTypeSchema.optional(), objectId: z.string().optional() })
      .parse(request.query);
    await requireTenantRead(container, auth, tenantId);

    return { grants: await container.access.listGrants(tenantId, filter) };
  });

  app.post('/admin/tenants/:tenantId/grants', guard, async (request, reply) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const input = z
      .object({
        subjectType: subjectTypeSchema,
        subjectId: z.string().min(1),
        objectType: objectTypeSchema,
        objectId: z.string().min(1),
        access: objectAccessSchema,
      })
      .parse(request.body);
    await requireTenantCapability(container, auth, tenantId, 'tenant.role_assignment.manage');

    const result = await container.access.grant({ tenantId, ...input, actorUserId: auth.userId });
    void reply.status(201);
    return result;
  });

  app.delete('/admin/tenants/:tenantId/grants/:grantId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId, grantId } = tenantParams
      .extend({ grantId: z.string().uuid() })
      .parse(request.params);
    await requireTenantCapability(container, auth, tenantId, 'tenant.role_assignment.manage');

    await container.access.revoke({ tenantId, grantId, actorUserId: auth.userId });
    return { ok: true };
  });

  /** The "Objekte" view: every project and dashboard, and who can open each, and why. */
  app.get('/admin/tenants/:tenantId/objects', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    await requireTenantRead(container, auth, tenantId);

    const overview = await container.tenantAdmin.overview(tenantId);
    const dashboards = [];
    for (const project of overview.projectList) {
      for (const dashboard of await container.dashboards.listForProject(tenantId, project.id)) {
        if (dashboard.lifecycle === 'trash') continue;
        dashboards.push({
          id: dashboard.id,
          name: dashboard.name,
          projectId: project.id,
          projectName: project.name,
          published: dashboard.publishedVersion !== null,
        });
      }
    }
    return { projects: overview.projectList, dashboards };
  });

  app.get(
    '/admin/tenants/:tenantId/objects/dashboards/:dashboardId/access',
    guard,
    async (request) => {
      const auth = requireAuth(request);
      const { tenantId, dashboardId } = tenantParams
        .extend({ dashboardId: z.string().uuid() })
        .parse(request.params);
      await requireTenantRead(container, auth, tenantId);

      return {
        entries: await container.effectiveAccess.explainDashboard(tenantId, dashboardId),
        grants: await container.access.listGrants(tenantId, {
          objectType: 'dashboard',
          objectId: dashboardId,
        }),
      };
    },
  );

  /**
   * What a change would do, before it is made. Writes nothing.
   *
   * "Permission change impact preview" (Phase 5): every person the change
   * reaches, with the capabilities and dashboards they would gain or lose.
   */
  app.post('/admin/tenants/:tenantId/impact-preview', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const { change } = z.object({ change: accessChangeSchema }).parse(request.body);
    await requireTenantRead(container, auth, tenantId);

    return container.effectiveAccess.preview(tenantId, change);
  });

  app.get('/admin/tenants/:tenantId/audit', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const { before, limit } = z
      .object({ before: z.string().datetime().optional(), limit: z.coerce.number().optional() })
      .parse(request.query);

    const canRead =
      (await container.authorization.can(auth, 'tenant.audit.read', {
        type: 'tenant',
        tenantId,
      })) ||
      (await container.authorization.can(auth, 'platform.tenant.read', { type: 'platform' }));
    if (!canRead) {
      await container.authorization.assert(auth, 'tenant.audit.read', { type: 'tenant', tenantId });
    }

    return {
      events: await container.auditLog.list(tenantId, {
        ...(before ? { before } : {}),
        ...(limit ? { limit } : {}),
      }),
    };
  });

  // --- tenants (platform) -------------------------------------------------------

  app.get('/admin/platform/tenants', guard, async (request) => {
    const auth = requireAuth(request);
    await container.authorization.assert(auth, 'platform.tenant.read', { type: 'platform' });
    return { tenants: await container.tenantAdmin.list() };
  });

  /** The create wizard's final step. The first admin's invitation token is returned once. */
  app.post('/admin/platform/tenants', guard, async (request, reply) => {
    const auth = requireAuth(request);
    const input = z
      .object({
        name: z.string().trim().min(2).max(200),
        slug: z
          .string()
          .trim()
          .min(2)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        defaultLocale: z.enum(['de', 'en']).default('de'),
        admin: z.object({
          email: z.string().email().max(320),
          firstName: z.string().trim().min(1).max(100),
          lastName: z.string().trim().min(1).max(100),
        }),
        firstProject: z
          .object({
            name: z.string().trim().min(2).max(200),
            slug: z
              .string()
              .trim()
              .min(2)
              .max(100)
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          })
          .optional(),
      })
      .parse(request.body);
    await container.authorization.assert(auth, 'platform.tenant.create', { type: 'platform' });

    const result = await container.tenantAdmin.create({ actor: auth, ...input });
    void reply.status(201);
    return result;
  });

  app.get('/admin/platform/tenants/:tenantId', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    await container.authorization.assert(auth, 'platform.tenant.read', { type: 'platform' });
    return { tenant: await container.tenantAdmin.overview(tenantId) };
  });

  app.get('/admin/platform/tenants/:tenantId/lifecycle-impact', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const { to } = z.object({ to: tenantLifecycleSchema }).parse(request.query);
    await container.authorization.assert(auth, 'platform.tenant.lifecycle.change', {
      type: 'platform',
    });
    return container.tenantAdmin.lifecycleImpact(tenantId, to);
  });

  app.post('/admin/platform/tenants/:tenantId/lifecycle', guard, async (request) => {
    const auth = requireAuth(request);
    const { tenantId } = tenantParams.parse(request.params);
    const { to, confirmation } = z
      .object({ to: z.enum(TENANT_LIFECYCLE_STATES), confirmation: z.string().max(200) })
      .parse(request.body);
    await container.authorization.assert(auth, 'platform.tenant.lifecycle.change', {
      type: 'platform',
    });
    requireRecentAuthentication(request);

    return container.tenantAdmin.changeLifecycle({
      tenantId,
      to,
      confirmation,
      actorUserId: auth.userId,
    });
  });
}

// --- helpers -----------------------------------------------------------------

const TENANT_CAPABILITIES: readonly Capability[] = [
  'tenant.read',
  'tenant.user.invite',
  'tenant.user.deactivate',
  'tenant.role_assignment.manage',
  'tenant.group.manage',
  'tenant.audit.read',
];

async function tenantCapabilities(
  container: Container,
  auth: AuthContext,
  tenantId: string,
): Promise<Capability[]> {
  const granted: Capability[] = [];
  for (const capability of TENANT_CAPABILITIES) {
    if (await container.authorization.can(auth, capability, { type: 'tenant', tenantId })) {
      granted.push(capability);
    }
  }
  return granted;
}

/**
 * Reading a tenant's administration: its own administrators, or a platform
 * admin inspecting it. The tenant must exist; the check reads it.
 */
async function requireTenantRead(container: Container, auth: AuthContext, tenantId: string) {
  await container.tenantAdmin.overview(tenantId); // 404 for an unknown tenant
  if (await container.authorization.can(auth, 'tenant.read', { type: 'tenant', tenantId })) return;
  if (await container.authorization.can(auth, 'platform.tenant.read', { type: 'platform' })) return;
  await container.authorization.assert(auth, 'tenant.read', { type: 'tenant', tenantId });
}

async function requireTenantCapability(
  container: Container,
  auth: AuthContext,
  tenantId: string,
  capability: Capability,
) {
  await container.tenantAdmin.overview(tenantId);
  await container.authorization.assert(auth, capability, { type: 'tenant', tenantId });
}

/**
 * Sensitive actions need a password confirmed within the re-auth window.
 *
 * The answer is `authentication_required` with its own code, so the UI can ask
 * for the password and retry, rather than treating it as a denial.
 */
export function requireRecentAuthentication(request: FastifyRequest): void {
  if (request.recentlyAuthenticated) return;
  throw new AppError('authentication_required', {
    code: 'reauthentication_required',
    messageKey: 'auth.reauthentication_required',
    internalMessage: 'A sensitive action was attempted outside the re-auth window.',
  });
}
