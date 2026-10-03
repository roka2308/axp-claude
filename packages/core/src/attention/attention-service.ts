import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  AppError,
  type AttentionItem,
  type AttentionKind,
  type AttentionOverview,
  type AttentionSeverity,
  type AuthContext,
  type Capability,
} from '@axp/contracts';
import {
  affectedRows,
  attentionItems,
  type Database,
  newId,
  projects,
  tenants,
  users,
} from '@axp/db';
import type { AuditService } from '../audit/audit-service';
import type { AuthorizationService } from '../access/authorization-service';
import type { Clock } from '../clock';
import type { MailTransport } from '../mail/mail-transport';

export interface AttentionServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly authorization: AuthorizationService;
  readonly mail: MailTransport;
  /** Where links in a notice mail point. */
  readonly webUrl: string;
}

/** What a producer reports. The group key names the problem, not the occurrence. */
export interface AttentionSignal {
  readonly tenantId: string;
  readonly projectId?: string | null;
  readonly kind: AttentionKind;
  readonly severity: AttentionSeverity;
  readonly groupKey: string;
  /** Who should see it: holders of this capability in the item's scope... */
  readonly audienceCapability: Capability;
  /** ...and this person, when one is concerned. */
  readonly ownerUserId?: string | null;
  readonly messageKey: string;
  readonly messageParams?: Readonly<Record<string, string | number>>;
  readonly href?: string;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  action_required: 0,
  warning: 1,
  information: 2,
};

/**
 * Attention Center (Master Spec §15).
 *
 * Operational problems, grouped, routed by role, in-app first. A producer
 * calls `raise` every time it sees a problem and `resolve` when it sees the
 * problem gone; the same problem seen again is one item with a higher count,
 * not a new item. Only `action_required` items are mailed, and only once per
 * group - the inbox is the product, mail is the nudge.
 */
export class AttentionService {
  constructor(private readonly deps: AttentionServiceDeps) {}

  async raise(signal: AttentionSignal): Promise<void> {
    const now = this.deps.clock.now();
    const [existing] = await this.deps.db
      .select()
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.tenantId, signal.tenantId),
          eq(attentionItems.groupKey, signal.groupKey),
        ),
      )
      .limit(1);

    if (existing) {
      // Seen again: one more occurrence. A resolved or acknowledged problem
      // that returns is open again - it needs looking at again.
      await this.deps.db
        .update(attentionItems)
        .set({
          severity: signal.severity,
          status: 'open',
          occurrences: existing.status === 'resolved' ? 1 : existing.occurrences + 1,
          ...(existing.status === 'resolved' ? { firstSeenAt: now, mailedAt: null } : {}),
          lastSeenAt: now,
          resolvedAt: null,
          messageKey: signal.messageKey,
          messageParams: { ...(signal.messageParams ?? {}) },
          href: signal.href ?? null,
          ownerUserId: signal.ownerUserId ?? null,
        })
        .where(eq(attentionItems.id, existing.id));
      if (existing.status === 'resolved' || !existing.mailedAt) await this.notify(existing.id);
      return;
    }

    const id = newId();
    await this.deps.db.insert(attentionItems).values({
      id,
      tenantId: signal.tenantId,
      projectId: signal.projectId ?? null,
      kind: signal.kind,
      severity: signal.severity,
      status: 'open',
      groupKey: signal.groupKey,
      audienceCapability: signal.audienceCapability,
      ownerUserId: signal.ownerUserId ?? null,
      messageKey: signal.messageKey,
      messageParams: { ...(signal.messageParams ?? {}) },
      href: signal.href ?? null,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    await this.notify(id);
  }

  /** The problem is gone; the item leaves the inbox. */
  async resolve(tenantId: string, groupKey: string): Promise<boolean> {
    const result = await this.deps.db
      .update(attentionItems)
      .set({ status: 'resolved', resolvedAt: this.deps.clock.now() })
      .where(
        and(
          eq(attentionItems.tenantId, tenantId),
          eq(attentionItems.groupKey, groupKey),
          ne(attentionItems.status, 'resolved'),
        ),
      );
    return affectedRows(result) > 0;
  }

  /** Resolves every open item of a kind whose group key is not in `stillOpen`. */
  async resolveAllExcept(
    tenantId: string,
    kind: AttentionKind,
    stillOpen: ReadonlySet<string>,
    scope?: { projectId: string },
  ): Promise<number> {
    const open = await this.deps.db
      .select({ groupKey: attentionItems.groupKey })
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.tenantId, tenantId),
          eq(attentionItems.kind, kind),
          ne(attentionItems.status, 'resolved'),
          ...(scope ? [eq(attentionItems.projectId, scope.projectId)] : []),
        ),
      );
    let resolved = 0;
    for (const row of open) {
      if (!stillOpen.has(row.groupKey) && (await this.resolve(tenantId, row.groupKey)))
        resolved += 1;
    }
    return resolved;
  }

  /**
   * What this person should look at: items whose capability they hold in the
   * item's scope, and items that concern them by name. Highest severity first.
   */
  async list(auth: AuthContext): Promise<AttentionOverview> {
    const tenantIds = [...auth.tenantIds];
    if (tenantIds.length === 0) return { items: [], counts: emptyCounts() };

    const rows = await this.deps.db
      .select({
        item: attentionItems,
        tenantName: tenants.name,
        projectName: projects.name,
      })
      .from(attentionItems)
      .innerJoin(tenants, eq(tenants.id, attentionItems.tenantId))
      .leftJoin(projects, eq(projects.id, attentionItems.projectId))
      .where(
        and(inArray(attentionItems.tenantId, tenantIds), ne(attentionItems.status, 'resolved')),
      )
      .orderBy(desc(attentionItems.lastSeenAt))
      .limit(500);

    const items: AttentionItem[] = [];
    for (const row of rows) {
      if (!(await this.visibleTo(auth, row.item))) continue;
      items.push(toItem(row.item, row.tenantName, row.projectName));
    }
    items.sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        b.lastSeenAt.localeCompare(a.lastSeenAt),
    );

    const counts = emptyCounts();
    for (const item of items) if (item.status === 'open') counts[item.severity] += 1;
    return { items: items.slice(0, 200), counts };
  }

  /** "Seen it." The item stays until the problem is gone, but stops counting as new. */
  async acknowledge(auth: AuthContext, itemId: string): Promise<void> {
    const [row] = await this.deps.db
      .select()
      .from(attentionItems)
      .where(and(eq(attentionItems.id, itemId), ne(attentionItems.status, 'resolved')))
      .limit(1);
    if (
      !row ||
      !auth.tenantIds.includes(row.tenantId as never) ||
      !(await this.visibleTo(auth, row))
    ) {
      throw new AppError('not_found', {
        code: 'attention_item_not_found',
        messageKey: 'attention.not_found',
        internalMessage: `Attention item ${itemId} is unknown or not the caller's.`,
      });
    }
    await this.deps.db
      .update(attentionItems)
      .set({
        status: 'acknowledged',
        acknowledgedAt: this.deps.clock.now(),
        acknowledgedByUserId: auth.userId,
      })
      .where(eq(attentionItems.id, itemId));
    await this.deps.audit.record({
      action: 'attention.acknowledged',
      outcome: 'success',
      actorUserId: auth.userId,
      tenantId: row.tenantId,
      projectId: row.projectId,
      targetType: 'attention_item',
      targetId: row.id,
      metadata: { kind: row.kind },
    });
  }

  private async visibleTo(
    auth: AuthContext,
    item: typeof attentionItems.$inferSelect,
  ): Promise<boolean> {
    if (item.ownerUserId && item.ownerUserId === auth.userId) return true;
    return this.deps.authorization.can(
      auth,
      item.audienceCapability as Capability,
      item.projectId
        ? { type: 'project', projectId: item.projectId }
        : { type: 'tenant', tenantId: item.tenantId },
    );
  }

  /**
   * Selective mail: an `action_required` item with an owner is mailed to that
   * owner once. Everything else waits in the Attention Center.
   */
  private async notify(itemId: string): Promise<void> {
    const [row] = await this.deps.db
      .select({
        item: attentionItems,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        locale: users.locale,
      })
      .from(attentionItems)
      .leftJoin(users, eq(users.id, attentionItems.ownerUserId))
      .where(and(eq(attentionItems.id, itemId), isNull(attentionItems.mailedAt)))
      .limit(1);
    if (!row || row.item.severity !== 'action_required' || !row.email) return;

    const english = row.locale === 'en';
    await this.deps.mail.send({
      to: { address: row.email, name: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() },
      subject: english
        ? 'Analytics Experience: something needs your attention'
        : 'Analytics Experience: Bitte prüfen Sie einen Hinweis',
      text: [
        english
          ? 'A problem in Analytics Experience needs your action. Details are in the Attention Center:'
          : 'In Analytics Experience ist eine Aufgabe für Sie aufgelaufen. Die Details stehen im Attention Center:',
        `${this.deps.webUrl}/attention`,
        '',
        english
          ? 'You get this mail once per problem; repeats appear only in the Attention Center.'
          : 'Diese Mail kommt einmal je Problem; Wiederholungen erscheinen nur im Attention Center.',
      ].join('\n'),
    });
    await this.deps.db
      .update(attentionItems)
      .set({ mailedAt: this.deps.clock.now() })
      .where(eq(attentionItems.id, itemId));
  }
}

function toItem(
  row: typeof attentionItems.$inferSelect,
  tenantName: string,
  projectName: string | null,
): AttentionItem {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status === 'acknowledged' ? 'acknowledged' : 'open',
    messageKey: row.messageKey,
    messageParams: row.messageParams ?? {},
    ...(row.href ? { href: row.href } : {}),
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    tenantName,
    ...(projectName ? { projectName } : {}),
  };
}

function emptyCounts(): Record<AttentionSeverity, number> {
  return { action_required: 0, warning: 0, information: 0 };
}
