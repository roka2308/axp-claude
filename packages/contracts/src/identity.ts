import { z } from 'zod';
import type { GroupId, ProjectId, RoleAssignmentId, TenantId, UserId } from './ids';
import type { Locale, UserStatus } from './lifecycle';
import { type ScopeType, scopeTypeSchema, type SystemRole, systemRoleSchema } from './roles';

/**
 * Identity (who someone is) and authentication (how they prove it) are separate
 * concepts (Master Spec §6). The internal user id is primary; email is mutable
 * and never a primary key.
 */
export interface UserIdentity {
  readonly id: UserId;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly status: UserStatus;
  readonly locale: Locale;
}

export const AUTH_PROVIDER_TYPES = ['local', 'oidc'] as const;
export const authProviderTypeSchema = z.enum(AUTH_PROVIDER_TYPES);
export type AuthProviderType = z.infer<typeof authProviderTypeSchema>;

export const MANAGED_ATTRIBUTES = ['firstName', 'lastName', 'email'] as const;
export const managedAttributeSchema = z.enum(MANAGED_ATTRIBUTES);
export type ManagedAttribute = z.infer<typeof managedAttributeSchema>;

/**
 * Attributes listed in `managedAttributes` are owned by the identity provider.
 * The UI marks them "managed by identity provider" and read-only (§12).
 */
export interface AuthIdentityLink {
  readonly userId: UserId;
  readonly providerType: AuthProviderType;
  readonly providerSubject: string;
  readonly managedAttributes: readonly ManagedAttribute[];
}

export interface ScopeRef {
  readonly type: ScopeType;
  /** Empty string for the platform scope, which has no owning object. */
  readonly id: string;
}

export const scopeRefSchema = z.object({
  type: scopeTypeSchema,
  id: z.string(),
});

export const SUBJECT_TYPES = ['user', 'group'] as const;
export const subjectTypeSchema = z.enum(SUBJECT_TYPES);
export type SubjectType = z.infer<typeof subjectTypeSchema>;

export interface RoleAssignment {
  readonly id: RoleAssignmentId;
  readonly subjectType: SubjectType;
  readonly subjectId: UserId | GroupId;
  readonly role: SystemRole;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
}

export const roleAssignmentInputSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectId: z.string().min(1),
  role: systemRoleSchema,
  scopeType: scopeTypeSchema,
  scopeId: z.string(),
});
export type RoleAssignmentInput = z.infer<typeof roleAssignmentInputSchema>;

/** Object grants are positive only. There are no deny rules in MVP (§7). */
export const OBJECT_ACCESS_LEVELS = ['view', 'edit'] as const;
export const objectAccessSchema = z.enum(OBJECT_ACCESS_LEVELS);
export type ObjectAccess = z.infer<typeof objectAccessSchema>;

/**
 * What an object grant can point at (ADR 0006).
 *
 * `dashboard` opens one dashboard. `project` opens the analytics data of every
 * dashboard in a project - the grant a group gets, so that access scales by
 * membership rather than by listing dashboards one by one (Master Spec §7).
 */
export const OBJECT_TYPES = ['dashboard', 'project'] as const;
export const objectTypeSchema = z.enum(OBJECT_TYPES);
export type ObjectType = z.infer<typeof objectTypeSchema>;

export interface ObjectGrant {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectType: SubjectType;
  readonly subjectId: UserId | GroupId;
  readonly objectType: ObjectType;
  readonly objectId: string;
  readonly access: ObjectAccess;
}

/**
 * One link in the explanation chain
 * `User -> Group -> RoleAssignment -> Scope -> ObjectGrant -> capability`.
 *
 * The permissions API returns these so the UI can answer "why does this access
 * exist?" without anyone reading database rows (Gate F5).
 */
export type AccessReasonLink =
  | { readonly kind: 'user'; readonly userId: UserId; readonly label: string }
  | { readonly kind: 'group'; readonly groupId: GroupId; readonly label: string }
  | {
      readonly kind: 'role_assignment';
      readonly roleAssignmentId: RoleAssignmentId;
      readonly role: SystemRole;
    }
  | { readonly kind: 'scope'; readonly scope: ScopeRef; readonly label: string }
  | {
      readonly kind: 'object_grant';
      readonly grantId: string;
      readonly objectType: ObjectType;
      readonly objectId: string;
      readonly access: ObjectAccess;
      /** The object's name, so the chain can be read without a lookup. */
      readonly label?: string;
    };

export interface AccessReason {
  readonly chain: readonly AccessReasonLink[];
  /** i18n key summarising the chain in one sentence. */
  readonly summaryKey: string;
}

export interface EffectiveAccessEntry {
  readonly capability: string;
  readonly granted: boolean;
  readonly reasons: readonly AccessReason[];
}

/**
 * Whether a subject may see or change the analytics data behind one dashboard.
 *
 * Two independent halves, both required (ADR 0006): a role that carries the
 * capability in the dashboard's scope, and an object grant that covers the
 * dashboard. "Rolle ist nicht gleich automatischer Datenzugriff" (§7) - the
 * decision keeps both halves so the UI can say which one is missing.
 */
export interface DataAccessDecision {
  readonly dashboardId: string;
  readonly need: ObjectAccess;
  readonly granted: boolean;
  /** The role half: capability at the dashboard's project. */
  readonly role: EffectiveAccessEntry;
  /** The grant half: every grant that covers the dashboard at the needed level. */
  readonly grants: readonly AccessReason[];
  /** Which half is missing, when access is refused. */
  readonly missing?: 'role' | 'grant' | 'role_and_grant';
}

/**
 * The authenticated caller as resolved server-side. Tenant and project ids are
 * never taken from the browser without independent resolution (Shared Contract §4).
 */
export interface AuthContext {
  readonly userId: UserId;
  readonly status: UserStatus;
  readonly locale: Locale;
  readonly roleAssignments: readonly RoleAssignment[];
  readonly groupIds: readonly GroupId[];
  /** Tenants the caller can address at all - not an analytics data grant. */
  readonly tenantIds: readonly TenantId[];
  readonly projectIds: readonly ProjectId[];
  /** Timestamp of the last successful authentication, for re-auth windows. */
  readonly authenticatedAt: Date;
}
