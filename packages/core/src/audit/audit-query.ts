import type { AuditEntry } from '@axp/contracts';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { AuditAction } from '@axp/contracts';
import { auditEvents, type Database, users } from '@axp/db';

/**
 * Reading the audit trail of one tenant (D5: "Audit für privilegierte
 * Änderungen").
 *
 * Paged by time rather than by offset, so a page stays stable while new events
 * arrive. What is shown is what was recorded: metadata never carries
 * credentials or analytics values, which the audit service guarantees on the
 * way in.
 */
export class AuditQueryService {
  constructor(private readonly deps: { readonly db: Database }) {}

  async list(
    tenantId: string,
    options: { limit?: number; before?: string; actions?: readonly AuditAction[] } = {},
  ): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const conditions = [eq(auditEvents.tenantId, tenantId)];
    if (options.before) conditions.push(lt(auditEvents.occurredAt, new Date(options.before)));
    if (options.actions && options.actions.length > 0) {
      conditions.push(inArray(auditEvents.action, [...options.actions]));
    }

    const rows = await this.deps.db
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(desc(auditEvents.occurredAt))
      .limit(limit);

    const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter(Boolean))] as string[];
    const names = new Map(
      actorIds.length > 0
        ? (
            await this.deps.db
              .select({ id: users.id, first: users.firstName, last: users.lastName })
              .from(users)
              .where(inArray(users.id, actorIds))
          ).map((row) => [row.id, `${row.first} ${row.last}`.trim()])
        : [],
    );

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      outcome: row.outcome,
      occurredAt: row.occurredAt.toISOString(),
      actor: row.actorUserId
        ? { id: row.actorUserId, name: names.get(row.actorUserId) ?? '—' }
        : null,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata ?? {},
    }));
  }
}

export type { AuditEntry };
