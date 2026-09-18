import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, asUserId } from '@axp/contracts';
import { resolveAuthContext } from '@axp/core';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * Cross-tenant negative tests (Shared Contract §4, acceptance checklist D).
 *
 * The scenario mirrors the canonical fixture: two tenants, each with a project,
 * and users whose access must not spill across the boundary.
 */
describe('tenant isolation and authorization', () => {
  let ctx: TestContext;
  let tenantA: string;
  let tenantB: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();

    tenantA = (
      await ctx.container.tenants.createTenant({
        portableId: 'demo.tenant-a',
        name: 'Tenant A',
        slug: 'tenant-a',
      })
    ).tenantId;
    tenantB = (
      await ctx.container.tenants.createTenant({
        portableId: 'demo.tenant-b',
        name: 'Tenant B',
        slug: 'tenant-b',
      })
    ).tenantId;

    await ctx.container.tenants.changeLifecycle(tenantA, 'active');
    await ctx.container.tenants.changeLifecycle(tenantB, 'active');

    projectA = (
      await ctx.container.tenants.createProject({
        tenantId: tenantA,
        portableId: 'demo.project-a',
        name: 'Project A',
        slug: 'project-a',
      })
    ).projectId;
    projectB = (
      await ctx.container.tenants.createProject({
        tenantId: tenantB,
        portableId: 'demo.project-b',
        name: 'Project B',
        slug: 'project-b',
      })
    ).projectId;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function userWithRole(
    email: string,
    role: 'viewer' | 'dashboard_editor' | 'tenant_admin' | 'platform_admin',
    scopeType: 'platform' | 'tenant' | 'project',
    scopeId: string,
  ) {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: 'Test',
      lastName: 'User',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role,
      scopeType,
      scopeId,
    });
    const context = await resolveAuthContext(ctx.container.db, asUserId(userId), ctx.clock.now());
    return { userId, context: context! };
  }

  it('does not let a tenant admin of one tenant act on another tenant', async () => {
    const { context } = await userWithRole('admin.a@example.invalid', 'tenant_admin', 'tenant', tenantA);

    expect(await ctx.container.authorization.can(context, 'tenant.read', { type: 'tenant', tenantId: tenantA })).toBe(true);
    expect(await ctx.container.authorization.can(context, 'tenant.read', { type: 'tenant', tenantId: tenantB })).toBe(false);
  });

  it('does not let a tenant-scoped role reach a project of a different tenant', async () => {
    const { context } = await userWithRole('admin.a@example.invalid', 'tenant_admin', 'tenant', tenantA);

    // Ownership is resolved from the database, not from the supplied id.
    expect(await ctx.container.authorization.can(context, 'project.read', { type: 'project', projectId: projectA })).toBe(true);
    expect(await ctx.container.authorization.can(context, 'project.read', { type: 'project', projectId: projectB })).toBe(false);
  });

  it('confines a project-scoped role to its own project', async () => {
    const { context } = await userWithRole('viewer.a@example.invalid', 'viewer', 'project', projectA);

    expect(await ctx.container.authorization.can(context, 'dashboard.read_published', { type: 'project', projectId: projectA })).toBe(true);
    expect(await ctx.container.authorization.can(context, 'dashboard.read_published', { type: 'project', projectId: projectB })).toBe(false);
    // A project role does not confer tenant administration.
    expect(await ctx.container.authorization.can(context, 'tenant.read', { type: 'tenant', tenantId: tenantA })).toBe(false);
  });

  it('gives a platform admin no automatic access to customer analytics', async () => {
    const { context } = await userWithRole('platform@example.invalid', 'platform_admin', 'platform', '');

    // Platform administration is real...
    expect(await ctx.container.authorization.can(context, 'platform.tenant.create', { type: 'platform' })).toBe(true);
    // ...but reading a customer's dashboards is not implied by it
    // (Master Spec §7, acceptance checklist A).
    expect(await ctx.container.authorization.can(context, 'dashboard.read_published', { type: 'project', projectId: projectA })).toBe(false);
    expect(await ctx.container.authorization.can(context, 'tenant.user.invite', { type: 'tenant', tenantId: tenantA })).toBe(false);
  });

  it('keeps roles additive rather than hierarchical', async () => {
    const { userId, context } = await userWithRole('both@example.invalid', 'platform_admin', 'platform', '');
    expect(await ctx.container.authorization.can(context, 'tenant.user.invite', { type: 'tenant', tenantId: tenantA })).toBe(false);

    // Granting the second role explicitly is what unlocks the capability.
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role: 'tenant_admin',
      scopeType: 'tenant',
      scopeId: tenantA,
    });
    const updated = await resolveAuthContext(ctx.container.db, asUserId(userId), ctx.clock.now());
    expect(await ctx.container.authorization.can(updated!, 'tenant.user.invite', { type: 'tenant', tenantId: tenantA })).toBe(true);
  });

  it('explains why access exists, with the granting chain', async () => {
    const { context } = await userWithRole('editor.a@example.invalid', 'dashboard_editor', 'project', projectA);

    const entry = await ctx.container.authorization.explain(context, 'dashboard.publish', {
      type: 'project',
      projectId: projectA,
    });

    expect(entry.granted).toBe(true);
    expect(entry.reasons).toHaveLength(1);
    const kinds = entry.reasons[0]!.chain.map((link) => link.kind);
    // Gate F5: the UI must be able to answer "what, where and why".
    expect(kinds).toEqual(['user', 'role_assignment', 'scope']);
  });

  it('explains a denial as an empty reason list rather than a bare false', async () => {
    const { context } = await userWithRole('viewer.a@example.invalid', 'viewer', 'project', projectA);

    const entry = await ctx.container.authorization.explain(context, 'dashboard.publish', {
      type: 'project',
      projectId: projectA,
    });
    expect(entry.granted).toBe(false);
    expect(entry.reasons).toEqual([]);
  });

  it('raises permission_denied from assert(), with the capability named', async () => {
    const { context } = await userWithRole('viewer.a@example.invalid', 'viewer', 'project', projectA);

    await expect(
      ctx.container.authorization.assert(context, 'dashboard.publish', {
        type: 'project',
        projectId: projectA,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => AppError.isAppError(error) && error.category === 'permission_denied',
    );
  });

  it('carries group membership into the effective context', async () => {
    const { userId } = await ctx.container.users.createLocalUser({
      email: 'member@example.invalid',
      firstName: 'Group',
      lastName: 'Member',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });

    const context = await resolveAuthContext(ctx.container.db, asUserId(userId), ctx.clock.now());
    expect(context?.roleAssignments).toHaveLength(0);
    expect(context?.tenantIds).toHaveLength(0);
  });

  it('refuses to create a project under a tenant that is offboarding', async () => {
    await ctx.container.tenants.changeLifecycle(tenantA, 'offboarding');

    await expect(
      ctx.container.tenants.createProject({
        tenantId: tenantA,
        portableId: 'demo.project-late',
        name: 'Too late',
        slug: 'too-late',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        AppError.isAppError(error) && error.code === 'tenant_not_accepting_changes',
    );
  });

  it('rejects an invalid tenant lifecycle transition', async () => {
    await ctx.container.tenants.changeLifecycle(tenantA, 'offboarding');
    await expect(ctx.container.tenants.changeLifecycle(tenantA, 'active')).rejects.toSatisfy(
      (error: unknown) =>
        AppError.isAppError(error) && error.code === 'invalid_lifecycle_transition',
    );
  });
});
