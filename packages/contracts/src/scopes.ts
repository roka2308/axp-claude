import type { ScopeRef } from './identity';
import { ROLE_DESCRIPTORS, type ScopeType, type SystemRole } from './roles';

/**
 * Capability catalogue.
 *
 * A capability is a concrete action, not a role. The list grows per milestone;
 * only capabilities whose feature exists are listed, so the Effective Access UI
 * never advertises something the product cannot do yet.
 */
export const CAPABILITIES = [
  // Platform administration
  'platform.tenant.create',
  'platform.tenant.read',
  'platform.tenant.lifecycle.change',
  'platform.diagnostics.read',
  'platform.theme.manage',
  'platform.entitlement.manage',
  // Tenant administration
  'tenant.read',
  'tenant.settings.update',
  'tenant.user.invite',
  'tenant.user.deactivate',
  'tenant.role_assignment.manage',
  'tenant.group.manage',
  'tenant.audit.read',
  'tenant.theme.manage',
  // Project
  'project.read',
  'project.create',
  'project.settings.update',
  // Dashboards
  'dashboard.read_published',
  'dashboard.create',
  'dashboard.edit_draft',
  'dashboard.publish',
  // Distribution (Phase 7): an external link, and a file of the current view
  'dashboard.share',
  'dashboard.export',
  // Scheduled reporting (Phase 8)
  'report.manage',
  // Semantic catalog
  'semantic.read',
  'semantic.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Which capabilities each role carries. Roles are additive: a subject's
 * capability set is the union over all of its role assignments, evaluated per
 * scope. No role implies analytics data access - that always additionally
 * requires an object grant (Master Spec §7).
 */
export const CAPABILITIES_BY_ROLE: Readonly<Record<SystemRole, readonly Capability[]>> = {
  viewer: ['project.read', 'dashboard.read_published', 'dashboard.export'],
  dashboard_editor: [
    'project.read',
    'dashboard.read_published',
    'dashboard.create',
    'dashboard.edit_draft',
    'dashboard.publish',
    'dashboard.share',
    'dashboard.export',
    'report.manage',
    'semantic.read',
  ],
  semantic_catalog_manager: ['project.read', 'semantic.read', 'semantic.manage'],
  tenant_admin: [
    'tenant.read',
    'tenant.settings.update',
    'tenant.user.invite',
    'tenant.user.deactivate',
    'tenant.role_assignment.manage',
    'tenant.group.manage',
    'tenant.audit.read',
    'tenant.theme.manage',
    'project.read',
    'project.create',
    'project.settings.update',
  ],
  platform_admin: [
    'platform.tenant.create',
    'platform.tenant.read',
    'platform.tenant.lifecycle.change',
    'platform.diagnostics.read',
    'platform.theme.manage',
    'platform.entitlement.manage',
  ],
} as const;

/**
 * Scope containment. A role assignment at a wider scope covers narrower scopes
 * inside it - but only within the same ownership path, which the authorization
 * engine resolves server-side.
 */
export function scopeCovers(assignment: ScopeRef, target: ScopeRef): boolean {
  if (assignment.type === 'platform') return true;
  if (assignment.type === target.type) return assignment.id === target.id;
  // A tenant-scoped assignment covers projects of that tenant. Proving that the
  // project belongs to the tenant is the caller's job: it needs a database read
  // and must not be inferred from ids supplied by the browser.
  return false;
}

export function roleGrantsCapability(role: SystemRole, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].includes(capability);
}

export function rolesAllowedAtScope(scope: ScopeType): readonly SystemRole[] {
  return (Object.keys(ROLE_DESCRIPTORS) as SystemRole[]).filter((role) =>
    ROLE_DESCRIPTORS[role].allowedScopes.includes(scope),
  );
}
