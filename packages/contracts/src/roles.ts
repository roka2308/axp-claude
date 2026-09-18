import { z } from 'zod';

/**
 * Exactly five additive system roles (Master Spec §7, contracts/roles_permissions.md).
 *
 * Roles are additive and NOT hierarchical: `platform_admin` is not a superset of
 * `tenant_admin`, and no role grants analytics data access by itself.
 */
export const SYSTEM_ROLES = [
  'viewer',
  'dashboard_editor',
  'semantic_catalog_manager',
  'tenant_admin',
  'platform_admin',
] as const;

export const systemRoleSchema = z.enum(SYSTEM_ROLES);
export type SystemRole = z.infer<typeof systemRoleSchema>;

export const SCOPE_TYPES = ['platform', 'tenant', 'project'] as const;
export const scopeTypeSchema = z.enum(SCOPE_TYPES);
export type ScopeType = z.infer<typeof scopeTypeSchema>;

export interface RoleDescriptor {
  readonly role: SystemRole;
  /** Scopes a role assignment may be anchored at. */
  readonly allowedScopes: readonly ScopeType[];
  /**
   * False for every role. Kept explicit rather than implied so the invariant
   * "role is not automatic data access" is visible in code and in the UI.
   */
  readonly grantsAutomaticAnalyticsAccess: false;
  /** i18n key for the human readable purpose shown in Administration. */
  readonly purposeKey: string;
}

export const ROLE_DESCRIPTORS: Readonly<Record<SystemRole, RoleDescriptor>> = {
  viewer: {
    role: 'viewer',
    allowedScopes: ['tenant', 'project'],
    grantsAutomaticAnalyticsAccess: false,
    purposeKey: 'roles.viewer.purpose',
  },
  dashboard_editor: {
    role: 'dashboard_editor',
    allowedScopes: ['tenant', 'project'],
    grantsAutomaticAnalyticsAccess: false,
    purposeKey: 'roles.dashboard_editor.purpose',
  },
  semantic_catalog_manager: {
    role: 'semantic_catalog_manager',
    allowedScopes: ['tenant', 'project'],
    grantsAutomaticAnalyticsAccess: false,
    purposeKey: 'roles.semantic_catalog_manager.purpose',
  },
  tenant_admin: {
    role: 'tenant_admin',
    allowedScopes: ['tenant'],
    grantsAutomaticAnalyticsAccess: false,
    purposeKey: 'roles.tenant_admin.purpose',
  },
  platform_admin: {
    role: 'platform_admin',
    allowedScopes: ['platform'],
    grantsAutomaticAnalyticsAccess: false,
    purposeKey: 'roles.platform_admin.purpose',
  },
} as const;

/**
 * Roles a subject may hand out, given the roles it holds itself.
 *
 * Tenant Admin must never be able to escalate to Platform Admin
 * (Master Spec §7, acceptance checklist A).
 */
export const ASSIGNABLE_ROLES_BY_ROLE: Readonly<Record<SystemRole, readonly SystemRole[]>> = {
  viewer: [],
  dashboard_editor: [],
  semantic_catalog_manager: [],
  tenant_admin: ['viewer', 'dashboard_editor', 'semantic_catalog_manager', 'tenant_admin'],
  platform_admin: SYSTEM_ROLES,
} as const;

export function isSystemRole(value: unknown): value is SystemRole {
  return systemRoleSchema.safeParse(value).success;
}

export function roleAllowsScope(role: SystemRole, scope: ScopeType): boolean {
  return ROLE_DESCRIPTORS[role].allowedScopes.includes(scope);
}
