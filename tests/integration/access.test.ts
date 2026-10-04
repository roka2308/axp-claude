import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { seedReferenceDashboard } from '@axp/fixtures';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * Administration and effective access (D5, Gate F5).
 *
 * The five security tests of Phase 5, against a real database:
 *
 *   - Tenant Admin cannot assign Platform Admin
 *   - Platform Admin without object/data grant cannot open customer analytics
 *   - group/direct grant accumulation correct
 *   - no deny rules exist
 *   - deactivated user/session behaviour
 *
 * and the property the gate rests on: what Effective Access says is what the
 * request path does, and what the impact preview predicts is what happens.
 */
describe('administration and effective access', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  let tenantId: string;
  let otherTenantId: string;
  let projectId: string;
  let dashboardId: string;

  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  const VIEW = 'timeRange=last_30_days&comparison=previous_period&breakpoint=desktop';

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();

    tenantId = await tenant('demo.tenant', 'Kunde', 'kunde');
    otherTenantId = await tenant('other.tenant', 'Anderer', 'anderer');
    projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: 'demo.project',
        name: 'Portal',
        slug: 'portal',
      })
    ).projectId;

    ids.platform = await person('platform@example.invalid', null);
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: ids.platform,
      role: 'platform_admin',
      scopeType: 'platform',
      scopeId: '',
    });

    ids.admin = await person('admin@example.invalid', tenantId);
    await role(ids.admin, 'tenant_admin', 'tenant', tenantId);
    ids.viewer = await person('viewer@example.invalid', tenantId);
    await role(ids.viewer, 'viewer', 'project', projectId);
    ids.editor = await person('editor@example.invalid', tenantId);
    await role(ids.editor, 'dashboard_editor', 'project', projectId);

    dashboardId = (
      await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId: ids.editor })
    ).dashboardId;

    for (const key of ['platform', 'admin', 'viewer', 'editor']) {
      tokens[key] = await signIn(`${key}@example.invalid`);
    }
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- security tests ----------------------------------------------------------

  describe('Tenant Admin cannot assign Platform Admin', () => {
    it('refuses platform_admin at the platform scope', async () => {
      const response = await post(`/admin/tenants/${tenantId}/role-assignments`, tokens.admin!, {
        subjectType: 'user',
        subjectId: ids.viewer,
        role: 'platform_admin',
        scopeType: 'platform',
        scopeId: '',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('role_not_assignable');
      expect(await countRows('role_assignments', "role = 'platform_admin'")).toBe(1);
    });

    it('never offers platform_admin as something to assign', async () => {
      for (const [scopeType, scopeId] of [
        ['tenant', tenantId],
        ['project', projectId],
        ['platform', ''],
      ]) {
        const response = await get(
          `/admin/tenants/${tenantId}/assignable-roles?scopeType=${scopeType}&scopeId=${scopeId}`,
          tokens.admin!,
        );
        expect(response.json().roles, scopeType).not.toContain('platform_admin');
      }
    });

    it('cannot reach into another tenant', async () => {
      const response = await post(
        `/admin/tenants/${otherTenantId}/role-assignments`,
        tokens.admin!,
        {
          subjectType: 'user',
          subjectId: ids.viewer,
          role: 'viewer',
          scopeType: 'tenant',
          scopeId: otherTenantId,
        },
      );
      expect(response.statusCode).toBe(403);
    });

    it('can assign the four tenant roles inside the tenant', async () => {
      for (const assignable of ['viewer', 'dashboard_editor', 'semantic_catalog_manager']) {
        const response = await post(`/admin/tenants/${tenantId}/role-assignments`, tokens.admin!, {
          subjectType: 'user',
          subjectId: ids.viewer,
          role: assignable,
          scopeType: 'project',
          scopeId: projectId,
        });
        expect(response.statusCode, assignable).toBe(201);
      }
    });
  });

  describe('Platform Admin without a data grant cannot open customer analytics', () => {
    it('is refused the dashboard, its tiles and its detail view', async () => {
      for (const path of [
        `/dashboards/${dashboardId}/layout?${VIEW}`,
        `/dashboards/${dashboardId}/widgets/kpi-visits?${VIEW}`,
        `/dashboards/${dashboardId}/presentation?${VIEW}`,
      ]) {
        const response = await get(path, tokens.platform!);
        expect([403, 404], path).toContain(response.statusCode);
      }
    });

    it('sees no dashboard in the library, and cannot find one by search', async () => {
      expect((await get('/dashboards', tokens.platform!)).json().dashboards).toEqual([]);
      expect((await get('/search?q=portal', tokens.platform!)).json().hits).toEqual([]);
    });

    it('can still administer the platform', async () => {
      const tenants = await get('/admin/platform/tenants', tokens.platform!);
      expect(tenants.statusCode).toBe(200);
      expect(tenants.json().tenants).toHaveLength(2);
    });

    it('and neither can a tenant admin', async () => {
      const response = await get(`/dashboards/${dashboardId}/layout?${VIEW}`, tokens.admin!);
      expect([403, 404]).toContain(response.statusCode);
    });
  });

  describe('group and direct grants accumulate', () => {
    it('keeps access through the group when the direct grant goes, and the other way round', async () => {
      const group = (
        await post(`/admin/tenants/${tenantId}/groups`, tokens.admin!, { name: 'Leser' })
      ).json();
      await post(`/admin/tenants/${tenantId}/groups/${group.groupId}/members`, tokens.admin!, {
        userId: ids.viewer,
      });

      const direct = (
        await post(`/admin/tenants/${tenantId}/grants`, tokens.admin!, grantTo('user', ids.viewer!))
      ).json();
      await post(
        `/admin/tenants/${tenantId}/grants`,
        tokens.admin!,
        grantTo('group', group.groupId),
      );

      expect(await opens(tokens.viewer!)).toBe(true);

      // Two paths; removing one leaves the other.
      await del(`/admin/tenants/${tenantId}/grants/${direct.grantId}`, tokens.admin!);
      expect(await opens(tokens.viewer!)).toBe(true);

      // And the explanation names what remains.
      const detail = (
        await get(`/admin/tenants/${tenantId}/users/${ids.viewer}`, tokens.admin!)
      ).json();
      const overview = detail.effective.dashboards.find(
        (entry: { id: string }) => entry.id === dashboardId,
      );
      expect(overview.view.granted).toBe(true);
      expect(overview.view.grantReasons[0].chain[1]).toMatchObject({
        kind: 'group',
        label: 'Leser',
      });

      await del(
        `/admin/tenants/${tenantId}/groups/${group.groupId}/members/${ids.viewer}`,
        tokens.admin!,
      );
      expect(await opens(tokens.viewer!)).toBe(false);
    });
  });

  describe('no deny rules exist', () => {
    it('stores only view and edit', async () => {
      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(
        "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_NAME = 'object_grants' AND COLUMN_NAME = 'access' AND TABLE_SCHEMA = DATABASE()",
      );
      expect(rows[0]!.t).toBe("enum('view','edit')");
    });

    it('refuses a grant that tries to deny', async () => {
      const response = await post(`/admin/tenants/${tenantId}/grants`, tokens.admin!, {
        ...grantTo('user', ids.viewer!),
        access: 'deny',
      });
      expect(response.statusCode).toBe(422);
    });
  });

  describe('deactivation', () => {
    it('ends every session at once and keeps what the account held', async () => {
      await post(`/admin/tenants/${tenantId}/grants`, tokens.admin!, grantTo('user', ids.viewer!));
      expect(await opens(tokens.viewer!)).toBe(true);

      const deactivated = await post(
        `/admin/tenants/${tenantId}/users/${ids.viewer}/deactivate`,
        tokens.admin!,
        {},
      );
      expect(deactivated.statusCode).toBe(200);
      expect(deactivated.json().revokedSessions).toBeGreaterThanOrEqual(1);

      // The old session is gone, and a new one cannot be opened.
      expect((await get('/auth/me', tokens.viewer!)).statusCode).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'viewer@example.invalid', password: STRONG_TEST_PASSWORD },
      });
      expect(login.statusCode).toBe(401);

      // Effective access says "nothing", although the rows are still there.
      const detail = (
        await get(`/admin/tenants/${tenantId}/users/${ids.viewer}`, tokens.admin!)
      ).json();
      expect(detail.effective.active).toBe(false);
      expect(detail.grants).toHaveLength(1);

      // Reactivation restores exactly that.
      await post(`/admin/tenants/${tenantId}/users/${ids.viewer}/reactivate`, tokens.admin!, {});
      expect(await opens(await signIn('viewer@example.invalid'))).toBe(true);
    });

    it('refuses to deactivate oneself or a platform admin', async () => {
      const self = await post(
        `/admin/tenants/${tenantId}/users/${ids.admin}/deactivate`,
        tokens.admin!,
        {},
      );
      expect(self.json().error.code).toBe('cannot_change_own_status');

      await ctx.container.userAdmin.addMembership(tenantId, ids.platform!);
      const platform = await post(
        `/admin/tenants/${tenantId}/users/${ids.platform}/deactivate`,
        tokens.admin!,
        {},
      );
      expect(platform.json().error.code).toBe('target_is_platform_admin');
    });

    it('needs a recent re-authentication', async () => {
      ctx.clock.advance(20 * 60_000);
      tokens.admin = await refresh(tokens.admin!);

      const refused = await post(
        `/admin/tenants/${tenantId}/users/${ids.viewer}/deactivate`,
        tokens.admin,
        {},
      );
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error.code).toBe('reauthentication_required');

      const wrong = await post('/auth/reauthenticate', tokens.admin, { password: 'falsch-falsch' });
      expect(wrong.statusCode).toBe(401);

      const ok = await post('/auth/reauthenticate', tokens.admin, {
        password: STRONG_TEST_PASSWORD,
      });
      expect(ok.statusCode).toBe(200);

      const allowed = await post(
        `/admin/tenants/${tenantId}/users/${ids.viewer}/deactivate`,
        tokens.admin,
        {},
      );
      expect(allowed.statusCode).toBe(200);
    });
  });

  // --- the gate's property ----------------------------------------------------

  describe('effective access tells the truth', () => {
    it('agrees with the request path for every dashboard and every person', async () => {
      await post(`/admin/tenants/${tenantId}/grants`, tokens.admin!, grantTo('user', ids.viewer!));

      for (const key of ['viewer', 'editor', 'admin']) {
        const effective = (
          await get(`/admin/tenants/${tenantId}/users/${ids[key]}`, tokens.admin!)
        ).json().effective;
        for (const dashboard of effective.dashboards) {
          const response = await get(`/dashboards/${dashboard.id}/layout?${VIEW}`, tokens[key]!);
          expect(response.statusCode === 200, `${key} → ${dashboard.name}`).toBe(
            dashboard.view.granted,
          );
        }
      }
    });

    it('predicts in the preview exactly what the change then does', async () => {
      const change = { kind: 'grant', ...grantTo('user', ids.viewer!) };
      const preview = (
        await post(`/admin/tenants/${tenantId}/impact-preview`, tokens.admin!, { change })
      ).json();

      expect(preview.affected).toHaveLength(1);
      expect(preview.affected[0].dashboardsGained).toEqual([
        { id: dashboardId, name: 'Portal Overview', access: 'view' },
      ]);
      // Nothing was written by the preview.
      expect(await opens(tokens.viewer!)).toBe(false);

      const { kind: _kind, ...grant } = change;
      await post(`/admin/tenants/${tenantId}/grants`, tokens.admin!, grant);
      expect(await opens(tokens.viewer!)).toBe(true);
    });

    it('previews a group deletion for every member', async () => {
      const group = (
        await post(`/admin/tenants/${tenantId}/groups`, tokens.admin!, { name: 'Alle' })
      ).json();
      for (const member of [ids.viewer, ids.editor]) {
        await post(`/admin/tenants/${tenantId}/groups/${group.groupId}/members`, tokens.admin!, {
          userId: member,
        });
      }
      await post(
        `/admin/tenants/${tenantId}/grants`,
        tokens.admin!,
        grantTo('group', group.groupId),
      );

      const preview = (
        await post(`/admin/tenants/${tenantId}/impact-preview`, tokens.admin!, {
          change: { kind: 'delete_group', groupId: group.groupId },
        })
      ).json();

      expect(preview.affected).toHaveLength(2);
      const viewerLoss = preview.affected.find(
        (entry: { userId: string }) => entry.userId === ids.viewer,
      );
      expect(viewerLoss.dashboardsLost).toEqual([
        { id: dashboardId, name: 'Portal Overview', access: 'view' },
      ]);
    });

    it('explains an object: who can open this dashboard, and why', async () => {
      await post(`/admin/tenants/${tenantId}/grants`, tokens.admin!, grantTo('user', ids.viewer!));
      const entries = (
        await get(
          `/admin/tenants/${tenantId}/objects/dashboards/${dashboardId}/access`,
          tokens.admin!,
        )
      ).json().entries;

      const viewer = entries.find((entry: { userId: string }) => entry.userId === ids.viewer);
      expect(viewer.view.granted).toBe(true);
      const editor = entries.find((entry: { userId: string }) => entry.userId === ids.editor);
      // The creator's own grant.
      expect(editor.edit.granted).toBe(true);
    });
  });

  // --- administration ----------------------------------------------------------

  describe('users, invitations and profile ownership', () => {
    it('invites a person who then chooses their own password', async () => {
      const invited = await post(`/admin/tenants/${tenantId}/users`, tokens.admin!, {
        email: 'neu@example.invalid',
        firstName: 'Nora',
        lastName: 'Neu',
      });
      expect(invited.statusCode).toBe(201);
      const token = invited.json().invitation.token as string;

      expect(
        (
          await app.inject({ method: 'POST', url: '/invitations/inspect', payload: { token } })
        ).json(),
      ).toMatchObject({
        email: 'neu@example.invalid',
      });

      const accepted = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        payload: { token, password: STRONG_TEST_PASSWORD },
      });
      expect(accepted.statusCode).toBe(200);
      await signIn('neu@example.invalid');

      // Single use.
      const again = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        payload: { token, password: STRONG_TEST_PASSWORD },
      });
      expect(again.statusCode).toBe(422);

      // Only the hash is stored.
      expect(await countRows('user_invitations', `token_hash = '${token}'`)).toBe(0);
    });

    it('refuses to edit a field the identity provider owns', async () => {
      const { userId } = await ctx.container.users.createFederatedUser({
        email: 'sso@example.invalid',
        firstName: 'Sina',
        lastName: 'SSO',
        providerSubject: 'idp|sina',
        managedAttributes: ['firstName', 'lastName', 'email'],
      });
      await ctx.container.userAdmin.addMembership(tenantId, userId);

      const refused = await app.inject({
        method: 'PATCH',
        url: `/admin/tenants/${tenantId}/users/${userId}`,
        headers: as(tokens.admin!),
        payload: { firstName: 'Anders' },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.code).toBe('attribute_managed_by_idp');

      const detail = (
        await get(`/admin/tenants/${tenantId}/users/${userId}`, tokens.admin!)
      ).json();
      expect(detail.user.provider).toBe('oidc');
      expect(detail.user.managedAttributes).toEqual(['firstName', 'lastName', 'email']);

      // What the provider does not own stays editable.
      const locale = await app.inject({
        method: 'PATCH',
        url: `/admin/tenants/${tenantId}/users/${userId}`,
        headers: as(tokens.admin!),
        payload: { locale: 'en' },
      });
      expect(locale.statusCode).toBe(200);
    });

    it('lets a person edit their own profile and see their own access', async () => {
      const patched = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: as(tokens.viewer!),
        payload: { firstName: 'Vera' },
      });
      expect(patched.statusCode).toBe(200);
      expect((await get('/me/profile', tokens.viewer!)).json().profile.firstName).toBe('Vera');

      const access = (await get('/me/access', tokens.viewer!)).json();
      expect(access.tenants[0].effective.dashboards[0].view.missing).toBe('grant');
    });

    it('never lets the last tenant admin be removed', async () => {
      const assignments = (await get(`/admin/tenants/${tenantId}/roles`, tokens.admin!)).json()
        .assignments;
      const only = assignments.find((entry: { role: string }) => entry.role === 'tenant_admin');
      const response = await del(
        `/admin/tenants/${tenantId}/role-assignments/${only.id}`,
        tokens.admin!,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().error.messageKey).toBe('admin.last_tenant_admin');
    });

    it('records privileged changes in the audit trail', async () => {
      await post(`/admin/tenants/${tenantId}/groups`, tokens.admin!, { name: 'Protokolliert' });
      await post(`/admin/tenants/${tenantId}/grants`, tokens.admin!, grantTo('user', ids.viewer!));
      // The account status is global, but the change was made from this
      // tenant, so this tenant's trail is where it has to show up.
      await post(`/admin/tenants/${tenantId}/users/${ids.viewer}/deactivate`, tokens.admin!, {});
      await post(`/admin/tenants/${tenantId}/users/${ids.viewer}/reactivate`, tokens.admin!, {});

      const events = (await get(`/admin/tenants/${tenantId}/audit`, tokens.admin!)).json().events;
      const actions = events.map((event: { action: string }) => event.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'group.created',
          'object_grant.changed',
          'user.deactivated',
          'user.activated',
        ]),
      );
      expect(events[0].actor.name).toBeTruthy();

      // A viewer may not read it. (Deactivation above ended the old session.)
      const viewer = await signIn('viewer@example.invalid');
      expect((await get(`/admin/tenants/${tenantId}/audit`, viewer)).statusCode).toBe(403);
    });
  });

  describe('tenant lifecycle', () => {
    it('creates a tenant with its first administrator and a first project', async () => {
      const created = await post('/admin/platform/tenants', tokens.platform!, {
        name: 'Neuer Kunde',
        slug: 'neuer-kunde',
        admin: { email: 'chef@example.invalid', firstName: 'Chris', lastName: 'Chef' },
        firstProject: { name: 'Intranet', slug: 'intranet' },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body.invitation.token).toBeTruthy();
      expect(body.projectId).toBeTruthy();

      const overview = (
        await get(`/admin/platform/tenants/${body.tenantId}`, tokens.platform!)
      ).json();
      expect(overview.tenant).toMatchObject({ lifecycle: 'provisioning', projects: 1, users: 1 });
    });

    it('refuses the wizard to a tenant admin', async () => {
      const response = await post('/admin/platform/tenants', tokens.admin!, {
        name: 'Schatten',
        slug: 'schatten',
        admin: { email: 'x@example.invalid', firstName: 'X', lastName: 'Y' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('previews a suspension, needs the name typed, then signs members out', async () => {
      const impact = (
        await get(
          `/admin/platform/tenants/${tenantId}/lifecycle-impact?to=suspended`,
          tokens.platform!,
        )
      ).json();
      expect(impact).toMatchObject({
        allowed: true,
        haltsProcessing: true,
        confirmationPhrase: 'Kunde',
      });
      expect(impact.usersSignedOut).toBe(3);

      const wrong = await post(`/admin/platform/tenants/${tenantId}/lifecycle`, tokens.platform!, {
        to: 'suspended',
        confirmation: 'kunde',
      });
      expect(wrong.json().error.code).toBe('confirmation_mismatch');

      const done = await post(`/admin/platform/tenants/${tenantId}/lifecycle`, tokens.platform!, {
        to: 'suspended',
        confirmation: 'Kunde',
      });
      expect(done.statusCode).toBe(200);

      expect((await get('/auth/me', tokens.viewer!)).statusCode).toBe(401);
      // The platform admin is not a member and keeps working.
      expect((await get('/admin/platform/tenants', tokens.platform!)).statusCode).toBe(200);
    });

    it('refuses a transition the lifecycle does not allow', async () => {
      const response = await post(
        `/admin/platform/tenants/${tenantId}/lifecycle`,
        tokens.platform!,
        {
          to: 'deleted',
          confirmation: 'Kunde',
        },
      );
      expect(response.statusCode).toBe(409);
    });
  });

  // --- helpers -----------------------------------------------------------------

  async function tenant(portableId: string, name: string, slug: string) {
    const { tenantId: id } = await ctx.container.tenants.createTenant({ portableId, name, slug });
    await ctx.container.tenants.changeLifecycle(id, 'active');
    return id;
  }

  async function person(email: string, memberOf: string | null): Promise<string> {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: email.split('@')[0]!,
      lastName: 'Test',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    if (memberOf) await ctx.container.userAdmin.addMembership(memberOf, userId);
    return userId;
  }

  async function role(
    userId: string,
    name: 'viewer' | 'dashboard_editor' | 'tenant_admin',
    scopeType: 'tenant' | 'project',
    scopeId: string,
  ) {
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role: name,
      scopeType,
      scopeId,
    });
  }

  async function signIn(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: STRONG_TEST_PASSWORD },
    });
    expect(response.statusCode, email).toBe(200);
    return response.json().token as string;
  }

  /** A fresh session after the clock moved, so idle expiry does not interfere. */
  async function refresh(_token: string): Promise<string> {
    const session = await signIn('admin@example.invalid');
    // Sign-in counts as authentication; age it past the re-auth window.
    ctx.clock.advance(20 * 60_000);
    return session;
  }

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: as(token) });
  }

  function post(url: string, token: string, payload: unknown) {
    return app.inject({ method: 'POST', url, headers: as(token), payload: payload as object });
  }

  function del(url: string, token: string) {
    return app.inject({ method: 'DELETE', url, headers: as(token) });
  }

  function grantTo(subjectType: 'user' | 'group', subjectId: string) {
    return { subjectType, subjectId, objectType: 'project', objectId: projectId, access: 'view' };
  }

  async function opens(token: string): Promise<boolean> {
    return (await get(`/dashboards/${dashboardId}/layout?${VIEW}`, token)).statusCode === 200;
  }

  async function countRows(table: string, where: string): Promise<number> {
    const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE ${where}`,
    );
    return Number(rows[0]!.n);
  }
});
