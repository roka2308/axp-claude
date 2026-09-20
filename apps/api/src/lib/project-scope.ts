import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { AppError, type AuthContext, type Capability } from '@axp/contracts';
import { matomoSites, projects, projectSites, tenants } from '@axp/db';
import type { Container } from '@axp/core';
import { enrichContext } from '@axp/observability';

export interface ProjectScope {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly timezone: string;
  /** Identifies the authorization decision behind a query, for cache keying. */
  readonly permissionContextId: string;
}

/**
 * Resolves a project from a request and authorizes the caller for it.
 *
 * The project id arrives from the browser and is therefore untrusted: the
 * owning tenant is read from the database, and the capability is checked
 * against that resolved tenant - never against anything the caller supplied
 * (Shared Contract §4).
 */
export async function requireProjectScope(
  container: Container,
  auth: AuthContext,
  projectId: string,
  capability: Capability,
): Promise<ProjectScope> {
  const [row] = await container.db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      tenantId: projects.tenantId,
      tenantName: tenants.name,
      timezone: projects.timezone,
      tenantLifecycle: tenants.lifecycle,
    })
    .from(projects)
    .innerJoin(tenants, eq(tenants.id, projects.tenantId))
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row) {
    // A project the caller may not see and one that does not exist answer the
    // same way: existence is itself information.
    throw new AppError('not_found', {
      code: 'project_not_found',
      messageKey: 'project.not_found',
      internalMessage: `Project ${projectId} does not exist.`,
    });
  }

  await container.authorization.assert(auth, capability, { type: 'project', projectId });

  // A suspended or offboarding tenant stops serving its users (Master Spec §5).
  if (row.tenantLifecycle !== 'active' && row.tenantLifecycle !== 'provisioning') {
    throw new AppError('permission_denied', {
      code: 'tenant_not_active',
      messageKey: 'tenant.not_active',
      internalMessage: `Tenant ${row.tenantId} is ${row.tenantLifecycle}.`,
    });
  }

  enrichContext({ tenantId: row.tenantId, projectId: row.projectId });

  return {
    tenantId: row.tenantId,
    tenantName: row.tenantName,
    projectId: row.projectId,
    projectName: row.projectName,
    timezone: row.timezone,
    permissionContextId: permissionContextIdFor(auth, row.projectId),
  };
}

/**
 * A stable id for "what this caller is allowed to see here".
 *
 * Part of every analytics cache key. Two callers share a cache entry only when
 * their effective access is identical; anything that could change what a query
 * may return has to be folded in here, which is why it is derived rather than
 * simply the user id.
 */
export function permissionContextIdFor(auth: AuthContext, projectId: string): string {
  const roles = auth.roleAssignments
    .map((assignment) => `${assignment.role}@${assignment.scopeType}:${assignment.scopeId}`)
    .sort()
    .join('|');

  return createHash('sha256').update(`${projectId}|${roles}`).digest('hex').slice(0, 32);
}

/** The site a dashboard reads from, verified to belong to the project. */
export async function requireProjectSite(
  container: Container,
  scope: ProjectScope,
  siteId: string,
): Promise<{ id: string; name: string; timezone: string }> {
  const [row] = await container.db
    .select({
      id: matomoSites.id,
      name: matomoSites.name,
      timezone: matomoSites.timezone,
      tenantId: matomoSites.tenantId,
    })
    .from(projectSites)
    .innerJoin(matomoSites, eq(matomoSites.id, projectSites.siteId))
    .where(and(eq(projectSites.projectId, scope.projectId), eq(projectSites.siteId, siteId)))
    .limit(1);

  if (!row || row.tenantId !== scope.tenantId) {
    throw new AppError('setup_required', {
      code: 'site_not_assigned',
      messageKey: 'analytics.site_not_assigned',
      internalMessage: `Site ${siteId} is not assigned to project ${scope.projectId}.`,
    });
  }

  return { id: row.id, name: row.name, timezone: row.timezone };
}

/** Authorizes a tenant-level action, resolving the tenant independently. */
export async function requireTenantScope(
  container: Container,
  auth: AuthContext,
  tenantId: string,
  capability: Capability,
): Promise<{ tenantId: string; tenantName: string }> {
  const [row] = await container.db
    .select({ id: tenants.id, name: tenants.name, lifecycle: tenants.lifecycle })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!row) {
    throw new AppError('not_found', {
      code: 'tenant_not_found',
      messageKey: 'tenant.not_found',
      internalMessage: `Tenant ${tenantId} does not exist.`,
    });
  }

  await container.authorization.assert(auth, capability, { type: 'tenant', tenantId });
  enrichContext({ tenantId });

  return { tenantId: row.id, tenantName: row.name };
}
