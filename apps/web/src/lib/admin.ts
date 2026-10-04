import 'server-only';
import type {
  AuditEntry,
  Capability,
  EffectiveAccess,
  GroupMember,
  GroupSummary,
  LifecycleImpact,
  ObjectAccessEntry,
  ObjectGrantView,
  ProfileField,
  RoleAssignmentView,
  ScopeType,
  SystemRole,
  TenantLifecycle,
  TenantOverview,
  TenantSummary,
  UserDetail,
  UserListEntry,
} from '@axp/contracts';
import { apiRequest } from './api-client';

/**
 * Administration reads (D5).
 *
 * Everything here is a GET against the API, which authorizes each call on its
 * own. The web app decides nothing about access - it shows what the API says.
 */

export interface AdminTenant {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: TenantLifecycle;
  readonly capabilities: readonly Capability[];
}

export interface AdminContext {
  readonly platformAdmin: boolean;
  readonly tenants: readonly AdminTenant[];
}

const t = (tenantId: string) => `/admin/tenants/${encodeURIComponent(tenantId)}`;

export function getAdminContext(): Promise<AdminContext> {
  return apiRequest<AdminContext>('/admin/context', { authenticated: true });
}

/**
 * The tenant a page is about: the one named in the URL if the caller may see
 * it, otherwise their first. Never a tenant from the URL that the API did not
 * list - that would only produce a 403 one step later.
 */
export function pickTenant(context: AdminContext, requested?: string): AdminTenant | null {
  return context.tenants.find((tenant) => tenant.id === requested) ?? context.tenants[0] ?? null;
}

export async function listUsers(tenantId: string, query?: string): Promise<UserListEntry[]> {
  const search = query ? `?${new URLSearchParams({ q: query })}` : '';
  return (
    await apiRequest<{ users: UserListEntry[] }>(`${t(tenantId)}/users${search}`, {
      authenticated: true,
    })
  ).users;
}

export interface UserAdminView {
  readonly user: UserDetail;
  readonly roles: readonly RoleAssignmentView[];
  readonly grants: readonly ObjectGrantView[];
  readonly effective: EffectiveAccess;
}

export function getUser(tenantId: string, userId: string): Promise<UserAdminView> {
  return apiRequest<UserAdminView>(`${t(tenantId)}/users/${encodeURIComponent(userId)}`, {
    authenticated: true,
  });
}

export async function listGroups(tenantId: string): Promise<GroupSummary[]> {
  return (
    await apiRequest<{ groups: GroupSummary[] }>(`${t(tenantId)}/groups`, { authenticated: true })
  ).groups;
}

export interface GroupAdminView {
  readonly group: GroupSummary & { readonly members: readonly GroupMember[] };
  readonly roles: readonly RoleAssignmentView[];
  readonly grants: readonly ObjectGrantView[];
}

export function getGroup(tenantId: string, groupId: string): Promise<GroupAdminView> {
  return apiRequest<GroupAdminView>(`${t(tenantId)}/groups/${encodeURIComponent(groupId)}`, {
    authenticated: true,
  });
}

export interface RoleCatalogue {
  readonly catalogue: readonly {
    readonly role: SystemRole;
    readonly allowedScopes: readonly ScopeType[];
    readonly capabilities: readonly Capability[];
    readonly grantsAutomaticAnalyticsAccess: boolean;
  }[];
  readonly assignments: readonly RoleAssignmentView[];
}

export function getRoles(tenantId: string): Promise<RoleCatalogue> {
  return apiRequest<RoleCatalogue>(`${t(tenantId)}/roles`, { authenticated: true });
}

export async function getAssignableRoles(
  tenantId: string,
  scopeType: ScopeType,
  scopeId: string,
): Promise<SystemRole[]> {
  return (
    await apiRequest<{ roles: SystemRole[] }>(
      `${t(tenantId)}/assignable-roles?${new URLSearchParams({ scopeType, scopeId })}`,
      { authenticated: true },
    )
  ).roles;
}

export interface TenantObjects {
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly dashboards: readonly {
    readonly id: string;
    readonly name: string;
    readonly projectId: string;
    readonly projectName: string;
    readonly published: boolean;
  }[];
}

export function getObjects(tenantId: string): Promise<TenantObjects> {
  return apiRequest<TenantObjects>(`${t(tenantId)}/objects`, { authenticated: true });
}

export function getDashboardAccess(
  tenantId: string,
  dashboardId: string,
): Promise<{ entries: ObjectAccessEntry[]; grants: ObjectGrantView[] }> {
  return apiRequest(`${t(tenantId)}/objects/dashboards/${encodeURIComponent(dashboardId)}/access`, {
    authenticated: true,
  });
}

export async function getAudit(tenantId: string, before?: string): Promise<AuditEntry[]> {
  const search = before ? `?${new URLSearchParams({ before })}` : '';
  return (
    await apiRequest<{ events: AuditEntry[] }>(`${t(tenantId)}/audit${search}`, {
      authenticated: true,
    })
  ).events;
}

export async function listTenants(): Promise<TenantSummary[]> {
  return (
    await apiRequest<{ tenants: TenantSummary[] }>('/admin/platform/tenants', {
      authenticated: true,
    })
  ).tenants;
}

export async function getTenant(tenantId: string): Promise<TenantOverview> {
  return (
    await apiRequest<{ tenant: TenantOverview }>(
      `/admin/platform/tenants/${encodeURIComponent(tenantId)}`,
      { authenticated: true },
    )
  ).tenant;
}

export function getLifecycleImpact(
  tenantId: string,
  to: TenantLifecycle,
): Promise<LifecycleImpact> {
  return apiRequest<LifecycleImpact>(
    `/admin/platform/tenants/${encodeURIComponent(tenantId)}/lifecycle-impact?${new URLSearchParams({ to })}`,
    { authenticated: true },
  );
}

export interface MyProfile {
  readonly profile: {
    readonly id: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly email: string;
    readonly locale: 'de' | 'en';
    readonly provider: 'local' | 'oidc';
    readonly managedAttributes: readonly ProfileField[];
    readonly emailVerified: boolean;
  };
  readonly pendingEmailChange: { readonly newEmail: string; readonly expiresAt: string } | null;
  readonly recentlyAuthenticated: boolean;
}

export function getMyProfile(): Promise<MyProfile> {
  return apiRequest<MyProfile>('/me/profile', { authenticated: true });
}

export async function getMyAccess(): Promise<
  { tenantId: string; tenantName: string; effective: EffectiveAccess }[]
> {
  return (
    await apiRequest<{
      tenants: { tenantId: string; tenantName: string; effective: EffectiveAccess }[];
    }>('/me/access', { authenticated: true })
  ).tenants;
}

export async function inspectInvitation(
  token: string,
): Promise<{ email: string; firstName: string } | null> {
  try {
    // The token travels in the body, never in a URL a server would log.
    return await apiRequest<{ email: string; firstName: string }>('/invitations/inspect', {
      method: 'POST',
      body: { token },
    });
  } catch {
    return null;
  }
}

/** Whether a password reset link can still be used. */
export async function inspectPasswordReset(token: string): Promise<boolean> {
  try {
    return (
      await apiRequest<{ valid: boolean }>('/auth/password-reset/inspect', {
        method: 'POST',
        body: { token },
      })
    ).valid;
  } catch {
    return false;
  }
}
