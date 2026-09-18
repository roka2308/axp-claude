import { type AuditEventInput, type AuditAction, type AuditOutcome } from '@axp/contracts';
import { auditEvents, type Database, newId } from '@axp/db';
import { getContext, sanitizeForLog, type Logger } from '@axp/observability';
import type { Clock } from '../clock';

export interface AuditServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Append-only audit trail (Shared Contract §16).
 *
 * Two deliberate properties:
 *   - metadata passes through the telemetry sanitiser, so a forgotten token or
 *     analytics value cannot be written into the trail;
 *   - a failure to write is logged but never propagated, because losing an
 *     audit row must not turn a successful privileged action into an error.
 *     Callers that need guaranteed auditing write inside their own transaction.
 */
export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async record(input: AuditEventInput): Promise<void> {
    const context = getContext();
    try {
      await this.deps.db.insert(auditEvents).values({
        id: newId(),
        action: input.action,
        outcome: input.outcome,
        actorUserId: input.actorUserId ?? null,
        tenantId: input.tenantId ?? context?.tenantId ?? null,
        projectId: input.projectId ?? context?.projectId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        correlationId: input.correlationId ?? context?.correlationId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 255) ?? null,
        metadata: input.metadata
          ? (sanitizeForLog(input.metadata) as Record<string, unknown>)
          : null,
        occurredAt: this.deps.clock.now(),
      });
    } catch (error) {
      this.deps.logger.error(
        { err: error, auditAction: input.action },
        'Failed to write audit event',
      );
    }
  }

  success(
    action: AuditAction,
    input: Omit<AuditEventInput, 'action' | 'outcome'> = {},
  ): Promise<void> {
    return this.record({ ...input, action, outcome: 'success' });
  }

  failure(
    action: AuditAction,
    input: Omit<AuditEventInput, 'action' | 'outcome'> = {},
  ): Promise<void> {
    return this.record({ ...input, action, outcome: 'failure' satisfies AuditOutcome });
  }
}
