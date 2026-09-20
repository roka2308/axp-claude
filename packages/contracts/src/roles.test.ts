import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES_BY_ROLE,
  ROLE_DESCRIPTORS,
  roleAllowsScope,
  SYSTEM_ROLES,
  type SystemRole,
} from './roles';
import { CAPABILITIES_BY_ROLE, roleGrantsCapability, scopeCovers } from './scopes';
import { canTransitionTenant, tenantProcessingHalted } from './lifecycle';

describe('system roles', () => {
  it('defines exactly the five decided roles', () => {
    expect(SYSTEM_ROLES).toEqual([
      'viewer',
      'dashboard_editor',
      'semantic_catalog_manager',
      'tenant_admin',
      'platform_admin',
    ]);
  });

  it('never grants automatic analytics data access through a role', () => {
    // Master Spec §7: "Rolle ist nicht gleich automatischer Datenzugriff."
    for (const role of SYSTEM_ROLES) {
      expect(ROLE_DESCRIPTORS[role].grantsAutomaticAnalyticsAccess).toBe(false);
    }
  });

  it('prevents a tenant admin from assigning platform admin', () => {
    // Acceptance checklist A: escalation here is a blocking failure.
    expect(ASSIGNABLE_ROLES_BY_ROLE.tenant_admin).not.toContain('platform_admin');
    expect(ASSIGNABLE_ROLES_BY_ROLE.platform_admin).toContain('platform_admin');
  });

  it('gives non-administrative roles no ability to assign roles at all', () => {
    for (const role of ['viewer', 'dashboard_editor', 'semantic_catalog_manager'] as SystemRole[]) {
      expect(ASSIGNABLE_ROLES_BY_ROLE[role]).toHaveLength(0);
    }
  });

  it('keeps roles additive rather than hierarchical', () => {
    // A platform admin does not inherit tenant administration capabilities;
    // holding both requires both assignments.
    expect(CAPABILITIES_BY_ROLE.platform_admin).not.toContain('tenant.user.invite');
    expect(CAPABILITIES_BY_ROLE.tenant_admin).not.toContain('platform.tenant.create');
    expect(roleGrantsCapability('viewer', 'dashboard.publish')).toBe(false);
    expect(roleGrantsCapability('dashboard_editor', 'dashboard.publish')).toBe(true);
  });

  it('anchors platform admin at the platform scope only', () => {
    expect(roleAllowsScope('platform_admin', 'platform')).toBe(true);
    expect(roleAllowsScope('platform_admin', 'tenant')).toBe(false);
    expect(roleAllowsScope('tenant_admin', 'project')).toBe(false);
  });
});

describe('scope containment', () => {
  it('lets a platform scope cover everything below it', () => {
    expect(scopeCovers({ type: 'platform', id: '' }, { type: 'tenant', id: 't1' })).toBe(true);
    expect(scopeCovers({ type: 'platform', id: '' }, { type: 'project', id: 'p1' })).toBe(true);
  });

  it('does not infer project ownership from ids alone', () => {
    // Deciding that a project belongs to a tenant requires a database read;
    // trusting a browser-supplied id here would be a cross-tenant hole.
    expect(scopeCovers({ type: 'tenant', id: 't1' }, { type: 'project', id: 'p1' })).toBe(false);
  });

  it('matches same-type scopes only on identity', () => {
    expect(scopeCovers({ type: 'tenant', id: 't1' }, { type: 'tenant', id: 't1' })).toBe(true);
    expect(scopeCovers({ type: 'tenant', id: 't1' }, { type: 'tenant', id: 't2' })).toBe(false);
  });
});

describe('tenant lifecycle', () => {
  it('follows provisioning -> active <-> suspended -> offboarding -> deleted', () => {
    expect(canTransitionTenant('provisioning', 'active')).toBe(true);
    expect(canTransitionTenant('active', 'suspended')).toBe(true);
    expect(canTransitionTenant('suspended', 'active')).toBe(true);
    expect(canTransitionTenant('suspended', 'offboarding')).toBe(true);
    expect(canTransitionTenant('offboarding', 'deleted')).toBe(true);
  });

  it('does not allow a deleted or offboarding tenant to become active again', () => {
    expect(canTransitionTenant('deleted', 'active')).toBe(false);
    expect(canTransitionTenant('offboarding', 'active')).toBe(false);
  });

  it('halts customer-facing processing in suspended, offboarding and deleted', () => {
    expect(tenantProcessingHalted('active')).toBe(false);
    expect(tenantProcessingHalted('provisioning')).toBe(false);
    expect(tenantProcessingHalted('suspended')).toBe(true);
    expect(tenantProcessingHalted('offboarding')).toBe(true);
    expect(tenantProcessingHalted('deleted')).toBe(true);
  });
});
