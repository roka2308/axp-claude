import { describe, expect, it } from 'vitest';
import { type AccessModel, computeEffectiveAccess, diffEffectiveAccess } from './effective-access';

const TENANT = { id: 't1', name: 'Kunde' };
const PORTAL = { id: 'p1', name: 'Portal' };
const INTRANET = { id: 'p2', name: 'Intranet' };
const OVERVIEW = { id: 'd1', name: 'Overview', projectId: 'p1', published: true };
const NEWS = { id: 'd2', name: 'News', projectId: 'p2', published: true };

function model(overrides: Partial<AccessModel> = {}): AccessModel {
  return {
    user: { id: 'u1', name: 'Vera Viewer', active: true },
    tenant: TENANT,
    groups: [],
    projects: [PORTAL, INTRANET],
    dashboards: [OVERVIEW, NEWS],
    assignments: [],
    grants: [],
    ...overrides,
  };
}

const viewerAt = (projectId: string, subject: { type?: 'user' | 'group'; id?: string } = {}) => ({
  id: `ra-${projectId}-${subject.id ?? 'u1'}`,
  subjectType: subject.type ?? ('user' as const),
  subjectId: subject.id ?? 'u1',
  role: 'viewer' as const,
  scopeType: 'project' as const,
  scopeId: projectId,
});

const grant = (
  objectType: 'dashboard' | 'project',
  objectId: string,
  access: 'view' | 'edit' = 'view',
  subject: { type: 'user' | 'group'; id: string } = { type: 'user', id: 'u1' },
) => ({
  id: `g-${objectType}-${objectId}-${subject.id}-${access}`,
  subjectType: subject.type,
  subjectId: subject.id,
  objectType,
  objectId,
  access,
});

describe('effective access', () => {
  it('opens no data with a role alone', () => {
    const access = computeEffectiveAccess(model({ assignments: [viewerAt('p1')] }));
    const overview = access.dashboards.find((entry) => entry.id === 'd1')!;

    expect(overview.view.granted).toBe(false);
    expect(overview.view.missing).toBe('grant');
    expect(overview.view.roleReasons).toHaveLength(1);
  });

  it('opens no data with a grant alone', () => {
    const access = computeEffectiveAccess(model({ grants: [grant('dashboard', 'd1')] }));
    expect(access.dashboards.find((entry) => entry.id === 'd1')!.view).toMatchObject({
      granted: false,
      missing: 'role',
    });
  });

  it('opens data with both, and explains both halves', () => {
    const access = computeEffectiveAccess(
      model({ assignments: [viewerAt('p1')], grants: [grant('dashboard', 'd1')] }),
    );
    const view = access.dashboards.find((entry) => entry.id === 'd1')!.view;

    expect(view.granted).toBe(true);
    expect(view.roleReasons[0]!.chain.map((link) => link.kind)).toEqual([
      'user',
      'role_assignment',
      'scope',
    ]);
    expect(view.grantReasons[0]!.chain.map((link) => link.kind)).toEqual(['user', 'object_grant']);
  });

  it('accumulates group and direct grants, and names the group in the chain', () => {
    const access = computeEffectiveAccess(
      model({
        groups: [{ id: 'grp1', name: 'Portal-Leser' }],
        assignments: [viewerAt('p1', { type: 'group', id: 'grp1' })],
        grants: [
          grant('project', 'p1', 'view', { type: 'group', id: 'grp1' }),
          grant('dashboard', 'd1', 'view'),
        ],
      }),
    );
    const view = access.dashboards.find((entry) => entry.id === 'd1')!.view;

    expect(view.granted).toBe(true);
    // Two independent reasons, both kept: the explanation shows every path.
    expect(view.grantReasons).toHaveLength(2);
    const viaGroup = view.grantReasons.find((reason) =>
      reason.chain.some((link) => link.kind === 'group'),
    )!;
    expect(viaGroup.chain[1]).toMatchObject({ kind: 'group', label: 'Portal-Leser' });
    expect(viaGroup.summaryKey).toBe('access.reason.grant_via_group_project');
  });

  it('lets a project grant cover every dashboard in that project, and only there', () => {
    const access = computeEffectiveAccess(
      model({
        assignments: [viewerAt('p1'), viewerAt('p2')],
        grants: [grant('project', 'p1')],
      }),
    );
    expect(access.dashboards.find((entry) => entry.id === 'd1')!.view.granted).toBe(true);
    expect(access.dashboards.find((entry) => entry.id === 'd2')!.view.granted).toBe(false);
  });

  it('requires an edit grant for editing, while edit also satisfies view', () => {
    const editorAssignment = { ...viewerAt('p1'), role: 'dashboard_editor' as const };
    const viewOnly = computeEffectiveAccess(
      model({ assignments: [editorAssignment], grants: [grant('dashboard', 'd1', 'view')] }),
    );
    const withEdit = computeEffectiveAccess(
      model({ assignments: [editorAssignment], grants: [grant('dashboard', 'd1', 'edit')] }),
    );

    expect(viewOnly.dashboards[0]!.edit).toMatchObject({ granted: false, missing: 'grant' });
    expect(withEdit.dashboards[0]!.edit.granted).toBe(true);
    expect(withEdit.dashboards[0]!.view.granted).toBe(true);
  });

  it('gives a tenant admin administration but no customer data', () => {
    const access = computeEffectiveAccess(
      model({
        assignments: [
          {
            id: 'ra-admin',
            subjectType: 'user',
            subjectId: 'u1',
            role: 'tenant_admin',
            scopeType: 'tenant',
            scopeId: 't1',
          },
        ],
      }),
    );

    const tenantScope = access.scopes.find((scope) => scope.scope.type === 'tenant')!;
    expect(tenantScope.capabilities.map((entry) => entry.capability)).toContain(
      'tenant.role_assignment.manage',
    );
    expect(access.dashboards.every((entry) => !entry.view.granted)).toBe(true);
  });

  it('gives a platform admin no customer data, even with every platform capability', () => {
    const access = computeEffectiveAccess(
      model({
        assignments: [
          {
            id: 'ra-platform',
            subjectType: 'user',
            subjectId: 'u1',
            role: 'platform_admin',
            scopeType: 'platform',
            scopeId: '',
          },
        ],
        // Even a grant does not help: the role carries no read capability.
        grants: [grant('project', 'p1')],
      }),
    );

    expect(access.scopes[0]!.scope.type).toBe('platform');
    expect(access.dashboards.find((entry) => entry.id === 'd1')!.view).toMatchObject({
      granted: false,
      missing: 'role',
    });
  });

  it('answers nothing for a deactivated account, whatever it still holds', () => {
    const access = computeEffectiveAccess(
      model({
        user: { id: 'u1', name: 'Vera', active: false },
        assignments: [viewerAt('p1')],
        grants: [grant('project', 'p1')],
      }),
    );
    expect(access.active).toBe(false);
    expect(access.scopes).toEqual([]);
    expect(access.dashboards.every((entry) => !entry.view.granted)).toBe(true);
  });

  it('has no way to express a deny: adding anything never removes access', () => {
    const base = model({ assignments: [viewerAt('p1')], grants: [grant('dashboard', 'd1')] });
    const before = computeEffectiveAccess(base);

    // Every kind of addition the model knows about.
    const after = computeEffectiveAccess({
      ...base,
      groups: [{ id: 'grp1', name: 'Gruppe' }],
      assignments: [...base.assignments, viewerAt('p2', { type: 'group', id: 'grp1' })],
      grants: [...base.grants, grant('dashboard', 'd2', 'view', { type: 'group', id: 'grp1' })],
    });

    const diff = diffEffectiveAccess(before, after);
    expect(diff.capabilitiesLost).toEqual([]);
    expect(diff.dashboardsLost).toEqual([]);
    expect(diff.dashboardsGained).toEqual([{ id: 'd2', name: 'News', access: 'view' }]);
  });

  it('shows what a removal would take away, before it happens', () => {
    const base = model({ assignments: [viewerAt('p1')], grants: [grant('dashboard', 'd1')] });
    const diff = diffEffectiveAccess(
      computeEffectiveAccess(base),
      computeEffectiveAccess({ ...base, grants: [] }),
    );

    expect(diff.dashboardsLost).toEqual([{ id: 'd1', name: 'Overview', access: 'view' }]);
    expect(diff.capabilitiesLost).toEqual([]);
    expect(diff.unchanged).toBe(false);
  });

  it('says so when a change alters nothing', () => {
    const base = model({ assignments: [viewerAt('p1')], grants: [grant('dashboard', 'd1')] });
    // A second, redundant path to the same access.
    const diff = diffEffectiveAccess(
      computeEffectiveAccess(base),
      computeEffectiveAccess({ ...base, grants: [...base.grants, grant('project', 'p1')] }),
    );
    expect(diff.unchanged).toBe(true);
  });
});
