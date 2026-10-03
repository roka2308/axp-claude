import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import {
  type Database,
  dashboardShares,
  projects,
  sourceBindings,
  tenantMemberships,
  tenants,
  users,
} from '@axp/db';
import type { Logger } from '@axp/observability';
import type { Clock } from '../clock';
import type { MatomoConnectionService } from '../matomo/connection-service';
import type { SemanticService } from '../semantic/semantic-service';
import type { AttentionService } from './attention-service';

export interface AttentionScansDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly attention: AttentionService;
  readonly matomo: MatomoConnectionService;
  readonly semantics: SemanticService;
  readonly shareExpiryWarningDays: number;
  readonly inactivityDays: number;
}

const DAY_MS = 86_400_000;

/**
 * The periodic checks that feed the Attention Center (Master Spec §15).
 *
 * Each scan raises what it finds and resolves what it no longer finds, so the
 * inbox reflects the current state rather than a history. All of them look at
 * how the product runs; none looks at what a metric did.
 */
export class AttentionScans {
  constructor(private readonly deps: AttentionScansDeps) {}

  /** Links about to stop working, for the person who created them. */
  async expiringShares(): Promise<number> {
    const now = this.deps.clock.now();
    const horizon = new Date(now.getTime() + this.deps.shareExpiryWarningDays * DAY_MS);
    const rows = await this.deps.db
      .select({ share: dashboardShares })
      .from(dashboardShares)
      .innerJoin(tenants, eq(tenants.id, dashboardShares.tenantId))
      .where(
        and(
          isNull(dashboardShares.revokedAt),
          gt(dashboardShares.expiresAt, now),
          lte(dashboardShares.expiresAt, horizon),
          inArray(tenants.lifecycle, ['active', 'provisioning']),
        ),
      );

    const open = new Map<string, Set<string>>();
    for (const { share } of rows) {
      const groupKey = `share_expiring:${share.id}`;
      open.set(share.tenantId, (open.get(share.tenantId) ?? new Set()).add(groupKey));
      await this.deps.attention.raise({
        tenantId: share.tenantId,
        projectId: share.projectId,
        kind: 'share_expiring',
        severity: 'warning',
        groupKey,
        audienceCapability: 'dashboard.share',
        ownerUserId: share.createdByUserId,
        messageKey: 'attention.share_expiring',
        messageParams: { label: share.label, expiresAt: share.expiresAt.toISOString() },
        href: `/dashboards/${share.dashboardId}/share`,
      });
    }
    await this.resolveElsewhere('share_expiring', open);
    return rows.length;
  }

  /** Accounts nobody has used for a long time, for whoever manages accounts. */
  async inactiveAccounts(): Promise<number> {
    const cutoff = new Date(this.deps.clock.now().getTime() - this.deps.inactivityDays * DAY_MS);
    const rows = await this.deps.db
      .select({
        tenantId: tenantMemberships.tenantId,
        userId: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(
        and(
          eq(users.status, 'active'),
          inArray(tenants.lifecycle, ['active', 'provisioning']),
          or(
            lte(users.lastLoginAt, cutoff),
            and(isNull(users.lastLoginAt), lte(users.createdAt, cutoff)),
          ),
        ),
      );

    const open = new Map<string, Set<string>>();
    for (const row of rows) {
      const groupKey = `inactive:${row.userId}`;
      open.set(row.tenantId, (open.get(row.tenantId) ?? new Set()).add(groupKey));
      await this.deps.attention.raise({
        tenantId: row.tenantId,
        kind: 'inactivity_review',
        severity: 'information',
        groupKey,
        audienceCapability: 'tenant.user.deactivate',
        messageKey: 'attention.inactivity_review',
        messageParams: {
          name: `${row.firstName} ${row.lastName}`.trim(),
          days: this.deps.inactivityDays,
        },
        href: `/admin/users/${row.userId}?tenant=${row.tenantId}`,
      });
    }
    await this.resolveElsewhere('inactivity_review', open);
    return rows.length;
  }

  /**
   * Mappings whose source changed in Matomo, for the catalog managers. Reports,
   * never repairs (Master Spec §13). A project whose Matomo cannot be reached
   * is left as it was: "unreachable" is not "fixed".
   */
  async mappingDrift(): Promise<number> {
    const bound = await this.deps.db
      .selectDistinct({
        projectId: sourceBindings.projectId,
        siteId: sourceBindings.siteId,
        tenantId: projects.tenantId,
      })
      .from(sourceBindings)
      .innerJoin(projects, eq(projects.id, sourceBindings.projectId))
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(inArray(tenants.lifecycle, ['active', 'provisioning']));

    let raised = 0;
    const byProject = new Map<string, { tenantId: string; siteIds: string[] }>();
    for (const row of bound) {
      if (!row.projectId || !row.siteId) continue;
      const entry = byProject.get(row.projectId) ?? { tenantId: row.tenantId, siteIds: [] };
      entry.siteIds.push(row.siteId);
      byProject.set(row.projectId, entry);
    }

    for (const [projectId, { tenantId, siteIds }] of byProject) {
      const open = new Set<string>();
      try {
        for (const siteId of siteIds) {
          const available = await this.deps.matomo.describeSiteMetadata(tenantId, siteId);
          const health = await this.deps.semantics.checkBindingDrift(projectId, available);
          for (const binding of health.filter((entry) => entry.siteId === siteId)) {
            if (binding.state !== 'review_required') continue;
            const groupKey = `mapping_review:${projectId}:${siteId}:${binding.requirementKey}`;
            open.add(groupKey);
            raised += 1;
            await this.deps.attention.raise({
              tenantId,
              projectId,
              kind: 'mapping_review',
              severity: 'warning',
              groupKey,
              audienceCapability: 'semantic.manage',
              messageKey: 'attention.mapping_review',
              messageParams: { requirement: binding.requirementKey },
              href: `/projects/${projectId}/semantics`,
            });
          }
        }
      } catch (error) {
        this.deps.logger.warn({ err: error, projectId }, 'Mapping drift scan skipped a project');
        continue;
      }
      await this.deps.attention.resolveAllExcept(tenantId, 'mapping_review', open, { projectId });
    }
    return raised;
  }

  private async resolveElsewhere(
    kind: 'share_expiring' | 'inactivity_review',
    open: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    const tenantRows = await this.deps.db.select({ id: tenants.id }).from(tenants);
    for (const tenant of tenantRows) {
      await this.deps.attention.resolveAllExcept(tenant.id, kind, open.get(tenant.id) ?? new Set());
    }
  }
}
