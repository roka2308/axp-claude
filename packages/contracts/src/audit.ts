import { z } from 'zod';

/**
 * Audited actions (Shared Contract §16).
 *
 * Audit records never contain secrets, passwords, tokens or analytics payloads.
 * The list grows per milestone; entries are added when the feature lands.
 */
export const AUDIT_ACTIONS = [
  // Bootstrap & recovery (Phase 0)
  'platform.bootstrap.started',
  'platform.bootstrap.completed',
  'platform.bootstrap.rejected',
  'platform.recovery.started',
  'platform.recovery.completed',
  // Authentication (Phase 0)
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.logout',
  'auth.session.revoked',
  'auth.password.changed',
  'auth.reauthenticated',
  // Tenant lifecycle (Phase 0 model, Phase 5 UI)
  'tenant.created',
  'tenant.lifecycle.changed',
  'tenant.purged',
  // Project
  'project.created',
  'project.updated',
  // Users & access
  'user.invited',
  'user.invitation.accepted',
  'user.activated',
  'user.deactivated',
  'user.updated',
  'role_assignment.created',
  'role_assignment.removed',
  'group.created',
  'group.updated',
  'group.deleted',
  'group.membership.changed',
  'object_grant.changed',
  // Matomo connections and sites (Phase 1)
  'matomo_connection.created',
  'matomo_connection.credential_replaced',
  'matomo_connection.capabilities_refreshed',
  'matomo_connection.removed',
  'matomo_site.imported',
  'project.site_assigned',
  // Semantic catalog (Phase 1 model, Phase 3 builders)
  'semantic.version_activated',
  'semantic.version_deprecated',
  'source_binding.changed',
  'source_binding.reviewed',
  // Dashboards (Phase 1)
  'dashboard.created',
  'dashboard.published',
  'dashboard.rolled_back',
  'dashboard.archived',
  'dashboard.trashed',
  'dashboard.restored',
  // A takeover ends someone else's editing session, so it is recorded even
  // though both parties were allowed to edit (Master Spec §21).
  'dashboard.editor_takeover',
  // Solutions and templates (Phase 6)
  'solution.installed',
  'solution.exported',
  'project.context_updated',
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const AUDIT_OUTCOMES = ['success', 'failure'] as const;
export const auditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

export interface AuditEventInput {
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  /** Null for unauthenticated events such as a failed login. */
  readonly actorUserId?: string | null;
  readonly tenantId?: string | null;
  readonly projectId?: string | null;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly correlationId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /**
   * Structured, non-sensitive context. Reviewed per call site; must never carry
   * credentials, tokens, password hashes or analytics values.
   */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}
