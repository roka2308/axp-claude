import { eq } from 'drizzle-orm';
import {
  AppError,
  type AccessReason,
  type AuthContext,
  type Capability,
  CAPABILITIES_BY_ROLE,
  type EffectiveAccessEntry,
  type RoleAssignment,
  type ScopeRef,
} from '@axp/contracts';
import { type Database, projects } from '@axp/db';

/** Where a capability is being exercised. `platform` has no owning object. */
export type AuthorizationTarget =
  | { readonly type: 'platform' }
  | { readonly type: 'tenant'; readonly tenantId: string }
  | { readonly type: 'project'; readonly projectId: string };

export interface AuthorizationServiceDeps {
  readonly db: Database;
}

/**
 * Server-side authorization (Shared Contract §3 and §4).
 *
 * Two rules shape this class:
 *   - roles are additive and not hierarchical, so the answer is the union over
 *     all role assignments that cover the target scope;
 *   - a role never implies analytics data access. Reading a dashboard's data
 *     additionally requires an object grant, which is checked separately once
 *     dashboards exist.
 *
 * Every decision can be explained as a chain, because the Administration UI has
 * to answer "what can this user do, where, and why?" without database access
 * (Gate F5).
 */
export class AuthorizationService {
  /** Per-instance cache of project -> tenant. Instances are request-scoped. */
  private readonly projectTenantCache = new Map<string, string | null>();

  constructor(private readonly deps: AuthorizationServiceDeps) {}

  async can(
    context: AuthContext,
    capability: Capability,
    target: AuthorizationTarget,
  ): Promise<boolean> {
    const entry = await this.explain(context, capability, target);
    return entry.granted;
  }

  /** Throws a `permission_denied` AppError when the capability is not granted. */
  async assert(
    context: AuthContext,
    capability: Capability,
    target: AuthorizationTarget,
  ): Promise<void> {
    if (await this.can(context, capability, target)) return;
    throw new AppError('permission_denied', {
      code: 'capability_denied',
      messageKey: 'errors.permission_denied.capability',
      messageParams: { capability },
      internalMessage: `User ${context.userId} lacks ${capability} on ${JSON.stringify(target)}.`,
    });
  }

  async explain(
    context: AuthContext,
    capability: Capability,
    target: AuthorizationTarget,
  ): Promise<EffectiveAccessEntry> {
    const targetScope = toScopeRef(target);
    const owningTenantId =
      target.type === 'project' ? await this.resolveOwningTenant(target.projectId) : null;

    const reasons: AccessReason[] = [];

    for (const assignment of context.roleAssignments) {
      if (!CAPABILITIES_BY_ROLE[assignment.role].includes(capability)) continue;
      if (!this.assignmentCoversTarget(assignment, targetScope, owningTenantId)) continue;
      reasons.push(buildReason(context, assignment, targetScope));
    }

    return { capability, granted: reasons.length > 0, reasons };
  }

  /** Every capability the caller holds at one target, for the Effective Access view. */
  async explainAll(
    context: AuthContext,
    capabilities: readonly Capability[],
    target: AuthorizationTarget,
  ): Promise<EffectiveAccessEntry[]> {
    const entries: EffectiveAccessEntry[] = [];
    for (const capability of capabilities) {
      entries.push(await this.explain(context, capability, target));
    }
    return entries;
  }

  /**
   * Scope containment.
   *
   * A platform assignment covers everything. A tenant assignment covers its own
   * tenant and the projects that provably belong to it - the ownership is read
   * from the database, never inferred from an id the caller supplied.
   */
  private assignmentCoversTarget(
    assignment: RoleAssignment,
    target: ScopeRef,
    owningTenantId: string | null,
  ): boolean {
    if (assignment.scopeType === 'platform') return true;

    if (assignment.scopeType === 'tenant') {
      if (target.type === 'tenant') return assignment.scopeId === target.id;
      if (target.type === 'project') return owningTenantId !== null && assignment.scopeId === owningTenantId;
      return false;
    }

    if (assignment.scopeType === 'project') {
      return target.type === 'project' && assignment.scopeId === target.id;
    }

    return false;
  }

  private async resolveOwningTenant(projectId: string): Promise<string | null> {
    const cached = this.projectTenantCache.get(projectId);
    if (cached !== undefined) return cached;

    const [row] = await this.deps.db
      .select({ tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const tenantId = row?.tenantId ?? null;
    this.projectTenantCache.set(projectId, tenantId);
    return tenantId;
  }
}

function toScopeRef(target: AuthorizationTarget): ScopeRef {
  switch (target.type) {
    case 'platform':
      return { type: 'platform', id: '' };
    case 'tenant':
      return { type: 'tenant', id: target.tenantId };
    case 'project':
      return { type: 'project', id: target.projectId };
  }
}

function buildReason(
  context: AuthContext,
  assignment: RoleAssignment,
  target: ScopeRef,
): AccessReason {
  const viaGroup = assignment.subjectType === 'group';
  return {
    chain: [
      { kind: 'user', userId: context.userId, label: 'user' },
      ...(viaGroup
        ? ([
            {
              kind: 'group' as const,
              groupId: assignment.subjectId as never,
              label: 'group',
            },
          ] as const)
        : []),
      { kind: 'role_assignment', roleAssignmentId: assignment.id, role: assignment.role },
      {
        kind: 'scope',
        scope: { type: assignment.scopeType, id: assignment.scopeId },
        label: assignment.scopeType,
      },
    ],
    summaryKey: viaGroup
      ? 'access.reason.via_group_role_scope'
      : target.type === assignment.scopeType
        ? 'access.reason.via_direct_role_scope'
        : 'access.reason.via_inherited_scope',
  };
}
