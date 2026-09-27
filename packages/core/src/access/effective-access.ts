import {
  CAPABILITIES_BY_ROLE,
  type AccessReason,
  type AccessReasonLink,
  type Capability,
  type GroupId,
  type ObjectAccess,
  type ObjectType,
  type RoleAssignmentId,
  type ScopeType,
  type SubjectType,
  type SystemRole,
  type UserId,
} from '@axp/contracts';

/**
 * Effective Access (Master Spec §7, D5, Gate F5).
 *
 * "What can this user do, where, and why?" - answered from the same rules the
 * request path enforces, but computed in memory over a snapshot of one user's
 * roles, groups and grants. Pure on purpose: an impact preview is the same
 * computation over a modified snapshot, and the result can be compared with
 * what the live authorization says (the tests do exactly that).
 *
 * Two layers, kept apart all the way to the UI:
 *
 *   - capabilities, from role assignments at a scope (direct or via a group);
 *   - data access, which needs a capability AND an object grant (ADR 0006).
 *
 * Nothing here can take access away except the absence of what gives it:
 * there are no deny rules (§7).
 */

export interface AccessModelAssignment {
  readonly id: string;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly role: SystemRole;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
}

export interface AccessModelGrant {
  readonly id: string;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly objectType: ObjectType;
  readonly objectId: string;
  readonly access: ObjectAccess;
}

/** Everything the engine needs about one user in one tenant. */
export interface AccessModel {
  readonly user: { readonly id: string; readonly name: string; readonly active: boolean };
  readonly tenant: { readonly id: string; readonly name: string };
  /** The groups the user belongs to, in this tenant. */
  readonly groups: readonly { readonly id: string; readonly name: string }[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly dashboards: readonly {
    readonly id: string;
    readonly name: string;
    readonly projectId: string;
    readonly published: boolean;
  }[];
  /** Assignments held by the user directly or by one of their groups. */
  readonly assignments: readonly AccessModelAssignment[];
  /** Grants held by the user directly or by one of their groups. */
  readonly grants: readonly AccessModelGrant[];
}

export interface ScopeAccess {
  readonly scope: { readonly type: ScopeType; readonly id: string; readonly label: string };
  readonly capabilities: readonly {
    readonly capability: Capability;
    readonly reasons: readonly AccessReason[];
  }[];
}

export interface DashboardAccess {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly published: boolean;
  readonly view: DataAccessView;
  readonly edit: DataAccessView;
}

export interface DataAccessView {
  readonly granted: boolean;
  readonly missing?: 'role' | 'grant' | 'role_and_grant';
  readonly roleReasons: readonly AccessReason[];
  readonly grantReasons: readonly AccessReason[];
}

export interface EffectiveAccess {
  readonly userId: string;
  readonly active: boolean;
  readonly scopes: readonly ScopeAccess[];
  readonly dashboards: readonly DashboardAccess[];
}

/** The capabilities that open or change a dashboard's data, by level. */
const DATA_CAPABILITY: Readonly<Record<ObjectAccess, Capability>> = {
  view: 'dashboard.read_published',
  edit: 'dashboard.edit_draft',
};

export function computeEffectiveAccess(model: AccessModel): EffectiveAccess {
  // A deactivated account can do nothing, whatever it still holds on paper.
  // The rows stay (reactivation restores them), but the answer is "nothing".
  if (!model.user.active) {
    return {
      userId: model.user.id,
      active: false,
      scopes: [],
      dashboards: model.dashboards.map((dashboard) => ({
        id: dashboard.id,
        name: dashboard.name,
        projectId: dashboard.projectId,
        projectName: projectName(model, dashboard.projectId),
        published: dashboard.published,
        view: { granted: false, missing: 'role_and_grant', roleReasons: [], grantReasons: [] },
        edit: { granted: false, missing: 'role_and_grant', roleReasons: [], grantReasons: [] },
      })),
    };
  }

  const scopeTargets: ScopeAccess['scope'][] = [
    { type: 'tenant', id: model.tenant.id, label: model.tenant.name },
    ...model.projects.map((project) => ({
      type: 'project' as const,
      id: project.id,
      label: project.name,
    })),
  ];

  const hasPlatform = model.assignments.some((assignment) => assignment.scopeType === 'platform');
  if (hasPlatform) scopeTargets.unshift({ type: 'platform', id: '', label: 'Plattform' });

  const scopes: ScopeAccess[] = scopeTargets
    .map((scope) => {
      const byCapability = new Map<Capability, AccessReason[]>();
      for (const assignment of model.assignments) {
        if (!covers(assignment, scope, model)) continue;
        for (const capability of CAPABILITIES_BY_ROLE[assignment.role]) {
          if (!isCapabilityForScope(capability, scope.type)) continue;
          const reasons = byCapability.get(capability) ?? [];
          reasons.push(roleReason(model, assignment, scope));
          byCapability.set(capability, reasons);
        }
      }
      return {
        scope,
        capabilities: [...byCapability].map(([capability, reasons]) => ({ capability, reasons })),
      };
    })
    .filter((entry) => entry.capabilities.length > 0);

  const dashboards: DashboardAccess[] = model.dashboards.map((dashboard) => ({
    id: dashboard.id,
    name: dashboard.name,
    projectId: dashboard.projectId,
    projectName: projectName(model, dashboard.projectId),
    published: dashboard.published,
    view: dataAccess(model, dashboard, 'view'),
    edit: dataAccess(model, dashboard, 'edit'),
  }));

  return { userId: model.user.id, active: true, scopes, dashboards };
}

/**
 * What changes between two answers, for the impact preview (D5).
 *
 * Listed as capabilities gained and lost per scope, and dashboards whose data
 * becomes visible or invisible, editable or not. A change that alters nothing
 * says so - which is itself worth knowing before confirming it.
 */
export interface AccessDiff {
  readonly userId: string;
  readonly capabilitiesGained: readonly { scope: string; capability: Capability }[];
  readonly capabilitiesLost: readonly { scope: string; capability: Capability }[];
  readonly dashboardsGained: readonly { id: string; name: string; access: ObjectAccess }[];
  readonly dashboardsLost: readonly { id: string; name: string; access: ObjectAccess }[];
  readonly unchanged: boolean;
}

export function diffEffectiveAccess(before: EffectiveAccess, after: EffectiveAccess): AccessDiff {
  const capabilitySet = (access: EffectiveAccess) =>
    new Map(
      access.scopes.flatMap((scope) =>
        scope.capabilities.map((entry) => [
          `${scope.scope.type}:${scope.scope.id}|${entry.capability}`,
          { scope: scope.scope.label, capability: entry.capability },
        ]),
      ),
    );
  const dashboardSet = (access: EffectiveAccess) =>
    new Map(
      access.dashboards.flatMap((dashboard) =>
        (['view', 'edit'] as const)
          .filter((level) => dashboard[level].granted)
          .map((level) => [
            `${dashboard.id}|${level}`,
            { id: dashboard.id, name: dashboard.name, access: level },
          ]),
      ),
    );

  const beforeCaps = capabilitySet(before);
  const afterCaps = capabilitySet(after);
  const beforeDash = dashboardSet(before);
  const afterDash = dashboardSet(after);

  const gained = <T>(from: Map<string, T>, to: Map<string, T>) =>
    [...to].filter(([key]) => !from.has(key)).map(([, value]) => value);

  const capabilitiesGained = gained(beforeCaps, afterCaps);
  const capabilitiesLost = gained(afterCaps, beforeCaps);
  const dashboardsGained = gained(beforeDash, afterDash);
  const dashboardsLost = gained(afterDash, beforeDash);

  return {
    userId: after.userId,
    capabilitiesGained,
    capabilitiesLost,
    dashboardsGained,
    dashboardsLost,
    unchanged:
      capabilitiesGained.length === 0 &&
      capabilitiesLost.length === 0 &&
      dashboardsGained.length === 0 &&
      dashboardsLost.length === 0,
  };
}

// --- internals ---------------------------------------------------------------

/**
 * Scope containment, the same rule the request path applies: platform covers
 * everything, a tenant assignment covers the tenant and its projects, a project
 * assignment covers its project.
 */
function covers(
  assignment: AccessModelAssignment,
  scope: ScopeAccess['scope'],
  model: AccessModel,
): boolean {
  if (assignment.scopeType === 'platform') return true;
  if (assignment.scopeType === 'tenant') {
    if (assignment.scopeId !== model.tenant.id) return false;
    return scope.type === 'tenant' || scope.type === 'project';
  }
  return scope.type === 'project' && assignment.scopeId === scope.id;
}

/**
 * Shows a capability at the scope where it means something. A tenant admin's
 * `project.read` belongs on each project, `tenant.user.invite` on the tenant,
 * `platform.*` on the platform - listing every capability at every scope would
 * be true and unreadable.
 */
function isCapabilityForScope(capability: Capability, scope: ScopeType): boolean {
  if (capability.startsWith('platform.')) return scope === 'platform';
  if (capability.startsWith('tenant.')) return scope === 'tenant';
  return scope === 'project';
}

function roleReason(
  model: AccessModel,
  assignment: AccessModelAssignment,
  scope: ScopeAccess['scope'],
): AccessReason {
  const viaGroup = assignment.subjectType === 'group';
  const group = viaGroup ? model.groups.find((entry) => entry.id === assignment.subjectId) : null;

  const chain: AccessReasonLink[] = [
    { kind: 'user', userId: model.user.id as UserId, label: model.user.name },
    ...(viaGroup
      ? [
          {
            kind: 'group' as const,
            groupId: assignment.subjectId as GroupId,
            label: group?.name ?? '—',
          },
        ]
      : []),
    {
      kind: 'role_assignment',
      roleAssignmentId: assignment.id as RoleAssignmentId,
      role: assignment.role,
    },
    {
      kind: 'scope',
      scope: { type: assignment.scopeType, id: assignment.scopeId },
      label: scopeLabel(model, assignment.scopeType, assignment.scopeId),
    },
  ];

  return {
    chain,
    summaryKey: viaGroup
      ? 'access.reason.via_group_role_scope'
      : scope.type === assignment.scopeType
        ? 'access.reason.via_direct_role_scope'
        : 'access.reason.via_inherited_scope',
  };
}

function dataAccess(
  model: AccessModel,
  dashboard: AccessModel['dashboards'][number],
  need: ObjectAccess,
): DataAccessView {
  const projectScope = {
    type: 'project' as const,
    id: dashboard.projectId,
    label: projectName(model, dashboard.projectId),
  };

  const capability = DATA_CAPABILITY[need];
  const roleReasons = model.assignments
    .filter(
      (assignment) =>
        CAPABILITIES_BY_ROLE[assignment.role].includes(capability) &&
        covers(assignment, projectScope, model),
    )
    .map((assignment) => roleReason(model, assignment, projectScope));

  const grantReasons = model.grants
    .filter(
      (grant) =>
        (need === 'view' || grant.access === 'edit') &&
        ((grant.objectType === 'dashboard' && grant.objectId === dashboard.id) ||
          (grant.objectType === 'project' && grant.objectId === dashboard.projectId)),
    )
    .map((grant) => grantReason(model, grant, dashboard));

  const granted = roleReasons.length > 0 && grantReasons.length > 0;
  return {
    granted,
    ...(granted
      ? {}
      : {
          missing:
            roleReasons.length === 0 && grantReasons.length === 0
              ? 'role_and_grant'
              : roleReasons.length === 0
                ? 'role'
                : 'grant',
        }),
    roleReasons,
    grantReasons,
  };
}

function grantReason(
  model: AccessModel,
  grant: AccessModelGrant,
  dashboard: AccessModel['dashboards'][number],
): AccessReason {
  const viaGroup = grant.subjectType === 'group';
  const group = viaGroup ? model.groups.find((entry) => entry.id === grant.subjectId) : null;

  return {
    chain: [
      { kind: 'user', userId: model.user.id as UserId, label: model.user.name },
      ...(viaGroup
        ? [
            {
              kind: 'group' as const,
              groupId: grant.subjectId as GroupId,
              label: group?.name ?? '—',
            },
          ]
        : []),
      {
        kind: 'object_grant',
        grantId: grant.id,
        objectType: grant.objectType,
        objectId: grant.objectId,
        access: grant.access,
        label: grant.objectType === 'project' ? projectName(model, grant.objectId) : dashboard.name,
      },
    ],
    summaryKey: viaGroup
      ? grant.objectType === 'project'
        ? 'access.reason.grant_via_group_project'
        : 'access.reason.grant_via_group_dashboard'
      : grant.objectType === 'project'
        ? 'access.reason.grant_direct_project'
        : 'access.reason.grant_direct_dashboard',
  };
}

function projectName(model: AccessModel, projectId: string): string {
  return model.projects.find((project) => project.id === projectId)?.name ?? '—';
}

function scopeLabel(model: AccessModel, type: ScopeType, id: string): string {
  if (type === 'platform') return 'Plattform';
  if (type === 'tenant') return id === model.tenant.id ? model.tenant.name : '—';
  return projectName(model, id);
}
