import { and, desc, eq } from 'drizzle-orm';
import {
  AppError,
  type DashboardRef,
  type DashboardSnapshot,
  GRID_COLUMNS,
  type PublishImpact,
  type PublishIssue,
  type WidgetConfig,
  WIDGET_SIZE_RULES,
} from '@axp/contracts';
import {
  affectedRows,
  type Database,
  dashboardDrafts,
  dashboards,
  dashboardVersions,
  newId,
  projects,
} from '@axp/db';
import type { Clock } from '../clock';
import type { AuditService } from '../audit/audit-service';
import type { SemanticService } from '../semantic/semantic-service';

export interface DashboardServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly semantics: SemanticService;
}

export interface CreateDashboardInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly siteId: string;
  readonly name: string;
  readonly description?: string;
  readonly actorUserId: string;
}

export interface DraftState {
  readonly dashboardId: string;
  readonly revisionId: string;
  readonly snapshot: DashboardSnapshot;
  readonly hasUnpublishedChanges: boolean;
  readonly publishedVersion: number | null;
  readonly updatedAt: string;
}

export interface PublishedState {
  readonly dashboardId: string;
  readonly version: number;
  readonly snapshot: DashboardSnapshot;
  readonly publishedAt: string;
}

/**
 * Dashboard lifecycle (Master Spec §21).
 *
 * The rule everything here serves: a published dashboard is an immutable
 * snapshot, and editing happens in a separate draft. Save is not publish; the
 * two never touch the same row.
 */
export class DashboardService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  async createDashboard(input: CreateDashboardInput): Promise<DraftState> {
    const [project] = await this.deps.db
      .select({ tenantId: projects.tenantId })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);

    if (!project || project.tenantId !== input.tenantId) {
      throw new AppError('permission_denied', {
        code: 'cross_tenant_dashboard',
        messageKey: 'errors.permission_denied.capability',
        internalMessage: `Project ${input.projectId} does not belong to tenant ${input.tenantId}.`,
      });
    }

    const dashboardId = newId();
    const revisionId = newId();

    const snapshot: DashboardSnapshot = {
      schemaVersion: 1,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      siteId: input.siteId,
      // A new dashboard opens on the last 30 days with the previous period
      // beside it: enough history to see a shape, and a comparison that is
      // always the same length as the range.
      defaultTimeRange: { preset: 'last_30_days', from: '1970-01-01', to: '1970-01-01' },
      defaultComparison: { mode: 'previous_period' },
      fixedFilters: [],
      widgets: [],
    };

    await this.deps.db.transaction(async (tx) => {
      await tx.insert(dashboards).values({
        id: dashboardId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        siteId: input.siteId,
        name: input.name,
        description: input.description ?? null,
        lifecycle: 'draft',
        createdByUserId: input.actorUserId,
      });

      await tx.insert(dashboardDrafts).values({
        id: newId(),
        dashboardId,
        revisionId,
        snapshot: snapshot as unknown as Record<string, unknown>,
        hasUnpublishedChanges: 1,
        updatedByUserId: input.actorUserId,
      });
    });

    await this.deps.audit.success('dashboard.created', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      targetType: 'dashboard',
      targetId: dashboardId,
      metadata: { name: input.name },
    });

    return {
      dashboardId,
      revisionId,
      snapshot,
      hasUnpublishedChanges: true,
      publishedVersion: null,
      updatedAt: this.deps.clock.now().toISOString(),
    };
  }

  async listForProject(tenantId: string, projectId: string): Promise<DashboardRef[]> {
    const rows = await this.deps.db
      .select({
        id: dashboards.id,
        tenantId: dashboards.tenantId,
        projectId: dashboards.projectId,
        name: dashboards.name,
        lifecycle: dashboards.lifecycle,
        publishedVersionId: dashboards.publishedVersionId,
        updatedAt: dashboards.updatedAt,
        hasUnpublishedChanges: dashboardDrafts.hasUnpublishedChanges,
      })
      .from(dashboards)
      .leftJoin(dashboardDrafts, eq(dashboardDrafts.dashboardId, dashboards.id))
      .where(and(eq(dashboards.tenantId, tenantId), eq(dashboards.projectId, projectId)));

    const refs: DashboardRef[] = [];
    for (const row of rows) {
      const published = row.publishedVersionId
        ? await this.versionById(row.publishedVersionId)
        : null;
      refs.push({
        id: row.id,
        tenantId: row.tenantId,
        projectId: row.projectId,
        name: row.name,
        lifecycle: row.lifecycle,
        publishedVersion: published?.version ?? null,
        hasUnpublishedChanges: (row.hasUnpublishedChanges ?? 0) === 1,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return refs;
  }

  async getDraft(tenantId: string, dashboardId: string): Promise<DraftState> {
    const dashboard = await this.requireDashboard(tenantId, dashboardId);
    const [draft] = await this.deps.db
      .select()
      .from(dashboardDrafts)
      .where(eq(dashboardDrafts.dashboardId, dashboardId))
      .limit(1);

    if (!draft) {
      throw new AppError('not_found', {
        code: 'draft_not_found',
        internalMessage: `Dashboard ${dashboardId} has no draft row.`,
      });
    }

    const published = dashboard.publishedVersionId
      ? await this.versionById(dashboard.publishedVersionId)
      : null;

    return {
      dashboardId,
      revisionId: draft.revisionId,
      snapshot: draft.snapshot as unknown as DashboardSnapshot,
      hasUnpublishedChanges: draft.hasUnpublishedChanges === 1,
      publishedVersion: published?.version ?? null,
      updatedAt: draft.updatedAt.toISOString(),
    };
  }

  /**
   * Autosaves the draft.
   *
   * Optimistic concurrency on `revisionId`: writing against a stale revision is
   * rejected rather than silently overwriting whatever someone else saved. The
   * editor lease and authorized takeover arrive with Phase 2; this is the
   * safety net underneath them.
   */
  async saveDraft(params: {
    tenantId: string;
    dashboardId: string;
    expectedRevisionId: string;
    snapshot: DashboardSnapshot;
    actorUserId: string;
  }): Promise<DraftState> {
    await this.requireDashboard(params.tenantId, params.dashboardId);

    const nextRevisionId = newId();
    const result = await this.deps.db
      .update(dashboardDrafts)
      .set({
        revisionId: nextRevisionId,
        snapshot: params.snapshot as unknown as Record<string, unknown>,
        hasUnpublishedChanges: 1,
        updatedByUserId: params.actorUserId,
      })
      .where(
        and(
          eq(dashboardDrafts.dashboardId, params.dashboardId),
          eq(dashboardDrafts.revisionId, params.expectedRevisionId),
        ),
      );

    if (affectedRows(result) === 0) {
      throw new AppError('conflict', {
        code: 'stale_revision',
        messageKey: 'dashboard.stale_revision',
        internalMessage:
          `Draft of ${params.dashboardId} was modified by someone else ` +
          `(expected revision ${params.expectedRevisionId}).`,
      });
    }

    // The dashboard name follows the draft so listings stay meaningful before
    // the first publish.
    await this.deps.db
      .update(dashboards)
      .set({ name: params.snapshot.name })
      .where(eq(dashboards.id, params.dashboardId));

    return this.getDraft(params.tenantId, params.dashboardId);
  }

  /**
   * What publishing this draft would change (D3).
   *
   * Blocking errors and warnings stay separate: an invalid widget size stops
   * the publish, an empty dashboard only warns.
   */
  async analysePublish(tenantId: string, dashboardId: string): Promise<PublishImpact> {
    const draft = await this.getDraft(tenantId, dashboardId);
    const dashboard = await this.requireDashboard(tenantId, dashboardId);
    const published = dashboard.publishedVersionId
      ? await this.versionById(dashboard.publishedVersionId)
      : null;

    const previousWidgets = new Map(
      (published?.snapshot.widgets ?? []).map((widget) => [widget.id, widget]),
    );
    const currentWidgets = new Map(draft.snapshot.widgets.map((widget) => [widget.id, widget]));

    const addedWidgetIds = [...currentWidgets.keys()].filter((id) => !previousWidgets.has(id));
    const removedWidgetIds = [...previousWidgets.keys()].filter((id) => !currentWidgets.has(id));
    const changedWidgetIds = [...currentWidgets.entries()]
      .filter(([id, widget]) => {
        const previous = previousWidgets.get(id);
        return previous && JSON.stringify(previous) !== JSON.stringify(widget);
      })
      .map(([id]) => id);

    const blockingErrors = validateWidgets(draft.snapshot.widgets);
    const warnings: PublishIssue[] = [];

    if (draft.snapshot.widgets.length === 0) {
      warnings.push({ messageKey: 'dashboard.publish.empty' });
    }
    for (const widget of draft.snapshot.widgets) {
      if (widget.data.semanticVersionIds.length === 0 && widget.family !== 'context_text') {
        warnings.push({ widgetId: widget.id, messageKey: 'dashboard.publish.widget_without_data' });
      }
    }

    return {
      changedWidgetIds,
      addedWidgetIds,
      removedWidgetIds,
      // Semantic version drift is reported from Phase 3, when definitions can
      // actually gain new versions.
      semanticVersionChanges: [],
      blockingErrors,
      warnings,
      canPublish: blockingErrors.length === 0,
    };
  }

  /**
   * Publishes the draft as a new immutable version.
   *
   * One transaction: insert the version, point the dashboard at it, mark the
   * draft clean. Either all of it happens or none of it does, which is what
   * "publish is atomic" means in practice.
   */
  async publish(params: {
    tenantId: string;
    dashboardId: string;
    actorUserId: string;
  }): Promise<PublishedState> {
    const impact = await this.analysePublish(params.tenantId, params.dashboardId);
    if (!impact.canPublish) {
      throw new AppError('validation_failed', {
        code: 'publish_blocked',
        messageKey: 'dashboard.publish.blocked',
        internalMessage: `Publish blocked by ${impact.blockingErrors.length} error(s).`,
      });
    }

    const draft = await this.getDraft(params.tenantId, params.dashboardId);
    const versionId = newId();

    const [latest] = await this.deps.db
      .select({ version: dashboardVersions.version })
      .from(dashboardVersions)
      .where(eq(dashboardVersions.dashboardId, params.dashboardId))
      .orderBy(desc(dashboardVersions.version))
      .limit(1);

    const nextVersion = (latest?.version ?? 0) + 1;
    const pinned = [
      ...new Set(draft.snapshot.widgets.flatMap((widget) => widget.data.semanticVersionIds)),
    ];

    await this.deps.db.transaction(async (tx) => {
      await tx.insert(dashboardVersions).values({
        id: versionId,
        dashboardId: params.dashboardId,
        version: nextVersion,
        status: 'published',
        snapshot: draft.snapshot as unknown as Record<string, unknown>,
        pinnedSemanticVersionIds: pinned,
        publishedByUserId: params.actorUserId,
      });

      await tx
        .update(dashboards)
        .set({ publishedVersionId: versionId, lifecycle: 'published' })
        .where(eq(dashboards.id, params.dashboardId));

      await tx
        .update(dashboardDrafts)
        .set({ hasUnpublishedChanges: 0 })
        .where(eq(dashboardDrafts.dashboardId, params.dashboardId));
    });

    await this.deps.audit.success('dashboard.published', {
      actorUserId: params.actorUserId,
      tenantId: params.tenantId,
      targetType: 'dashboard',
      targetId: params.dashboardId,
      metadata: {
        version: nextVersion,
        widgetCount: draft.snapshot.widgets.length,
        addedWidgets: impact.addedWidgetIds.length,
        removedWidgets: impact.removedWidgetIds.length,
      },
    });

    return {
      dashboardId: params.dashboardId,
      version: nextVersion,
      snapshot: draft.snapshot,
      publishedAt: this.deps.clock.now().toISOString(),
    };
  }

  /** The published snapshot, or null when nothing has been published yet. */
  async getPublished(tenantId: string, dashboardId: string): Promise<PublishedState | null> {
    const dashboard = await this.requireDashboard(tenantId, dashboardId);
    if (!dashboard.publishedVersionId) return null;

    const version = await this.versionById(dashboard.publishedVersionId);
    if (!version) return null;

    return {
      dashboardId,
      version: version.version,
      snapshot: version.snapshot,
      publishedAt: version.createdAt,
    };
  }

  private async versionById(versionId: string) {
    const [row] = await this.deps.db
      .select()
      .from(dashboardVersions)
      .where(eq(dashboardVersions.id, versionId))
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      snapshot: row.snapshot as unknown as DashboardSnapshot,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async requireDashboard(tenantId: string, dashboardId: string) {
    const [row] = await this.deps.db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.id, dashboardId), eq(dashboards.tenantId, tenantId)))
      .limit(1);

    if (!row) {
      throw new AppError('not_found', {
        code: 'dashboard_not_found',
        messageKey: 'dashboard.not_found',
        internalMessage: `Dashboard ${dashboardId} not found for tenant ${tenantId}.`,
      });
    }
    return row;
  }
}

/**
 * Structural validation of widget placement.
 *
 * Phase 1 checks what makes a layout impossible rather than merely ugly: sizes
 * below the family minimum, and placements that leave the 12-column raster.
 * Collision handling and minimal displacement are the grid engine's job in
 * Phase 2.
 */
export function validateWidgets(widgets: readonly WidgetConfig[]): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const seenIds = new Set<string>();

  for (const widget of widgets) {
    if (seenIds.has(widget.id)) {
      issues.push({ widgetId: widget.id, messageKey: 'dashboard.publish.duplicate_widget_id' });
    }
    seenIds.add(widget.id);

    const rules = WIDGET_SIZE_RULES[widget.family];
    const placement = widget.placement.desktop;

    if (placement.w < rules.minW || placement.h < rules.minH) {
      issues.push({
        widgetId: widget.id,
        messageKey: 'dashboard.publish.widget_too_small',
        messageParams: { minW: rules.minW, minH: rules.minH },
      });
    }

    if (placement.x + placement.w > GRID_COLUMNS.desktop) {
      issues.push({
        widgetId: widget.id,
        messageKey: 'dashboard.publish.widget_out_of_grid',
        messageParams: { columns: GRID_COLUMNS.desktop },
      });
    }
  }

  return issues;
}
