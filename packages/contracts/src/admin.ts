import type { Capability } from './scopes';
import type { AuditAction, AuditOutcome } from './audit';
import type {
  AccessReason,
  AuthProviderType,
  ObjectAccess,
  ObjectGrant,
  ObjectType,
  SubjectType,
} from './identity';
import type { ScopeType, SystemRole } from './roles';
import type { Locale, TenantLifecycle, UserStatus } from './lifecycle';

/**
 * Administration API shapes (D5, Gate F5).
 *
 * Shared by the API, which produces them, and the web app, which renders them.
 * The effective-access types are the answer to "what can this user do, where,
 * and why?" - kept in the contract so both tracks give the same answer in the
 * same shape.
 */

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

/** A change an administrator is about to make, described before it is made. */
export type AccessChange =
  | {
      readonly kind: 'assign_role';
      readonly subjectType: SubjectType;
      readonly subjectId: string;
      readonly role: SystemRole;
      readonly scopeType: ScopeType;
      readonly scopeId: string;
    }
  | { readonly kind: 'remove_role'; readonly assignmentId: string }
  | { readonly kind: 'add_member'; readonly groupId: string; readonly userId: string }
  | { readonly kind: 'remove_member'; readonly groupId: string; readonly userId: string }
  | {
      readonly kind: 'grant';
      readonly subjectType: SubjectType;
      readonly subjectId: string;
      readonly objectType: ObjectType;
      readonly objectId: string;
      readonly access: ObjectAccess;
    }
  | { readonly kind: 'revoke'; readonly grantId: string }
  | { readonly kind: 'delete_group'; readonly groupId: string }
  | { readonly kind: 'deactivate_user'; readonly userId: string };

export interface ImpactPreview {
  readonly change: AccessChange;
  /** One entry per person the change reaches, with what they gain and lose. */
  readonly affected: readonly (AccessDiff & { readonly name: string })[];
  /** True when nobody's access changes - worth knowing before confirming. */
  readonly noEffect: boolean;
}

/** Who can open one object, and why - the "Objekte" view (D5). */
export interface ObjectAccessEntry {
  readonly userId: string;
  readonly name: string;
  readonly view: EffectiveAccess['dashboards'][number]['view'];
  readonly edit: EffectiveAccess['dashboards'][number]['edit'];
}

/** An object grant with the names a person needs to read it. */
export interface ObjectGrantView extends ObjectGrant {
  readonly subjectLabel: string;
  readonly objectLabel: string;
}

export interface GroupSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly memberCount: number;
}

export interface GroupMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
}

export interface RoleAssignmentView {
  readonly id: string;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly role: SystemRole;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly scopeLabel: string;
  /** Who holds it: a person's name or a group's. */
  readonly subjectLabel: string;
  /** Set when the assignment reaches a user through a group. */
  readonly viaGroup?: { readonly id: string; readonly name: string };
}

/** Profile fields a person or an administrator may edit. */
export const PROFILE_FIELDS = ['firstName', 'lastName', 'email', 'locale'] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface UserListEntry {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly provider: AuthProviderType;
  readonly lastLoginAt: string | null;
  readonly groups: readonly string[];
  readonly roles: readonly string[];
}

export interface UserDetail {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly locale: Locale;
  readonly status: UserStatus;
  readonly provider: AuthProviderType;
  /**
   * Fields the identity provider owns. Shown as "Durch Identity Provider
   * verwaltet" and never editable here (Master Spec §12).
   */
  readonly managedAttributes: readonly ProfileField[];
  readonly lastLoginAt: string | null;
  readonly deactivatedAt: string | null;
  readonly activeSessions: number;
  readonly pendingInvitation: { readonly expiresAt: string } | null;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
}

export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly lifecycle: TenantLifecycle;
  readonly projects: number;
  readonly users: number;
  readonly lifecycleChangedAt: string | null;
}

export interface TenantOverview extends TenantSummary {
  readonly portableId: string;
  readonly defaultLocale: string;
  readonly groups: number;
  readonly dashboards: number;
  readonly connections: number;
  readonly projectList: readonly { readonly id: string; readonly name: string }[];
  /** Where this tenant may go next, and nothing else. */
  readonly allowedTransitions: readonly TenantLifecycle[];
}

/**
 * What a lifecycle change would do, before it is done (D5).
 *
 * "Gefährliche Lifecycle-Aktionen sind klar getrennt, besitzen Impact Preview,
 * Re-Authentication, explizite Bestätigung und Audit."
 */
export interface LifecycleImpact {
  readonly from: TenantLifecycle;
  readonly to: TenantLifecycle;
  readonly allowed: boolean;
  /** Customer processing (sign-in, queries, shares, reports) stops or resumes. */
  readonly haltsProcessing: boolean;
  readonly resumesProcessing: boolean;
  /** Members who would be signed out now, because this is their only tenant. */
  readonly usersSignedOut: number;
  readonly liveSessions: number;
  readonly affectedUsers: number;
  readonly dashboards: number;
  /** Irreversible: nothing leads back from here. */
  readonly irreversible: boolean;
  /** The text the administrator has to type to confirm. */
  readonly confirmationPhrase: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly occurredAt: string;
  readonly actor: { readonly id: string; readonly name: string } | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}
