import { and, desc, eq } from 'drizzle-orm';
import {
  AppError,
  type Breakpoint,
  BREAKPOINTS,
  type DashboardLifecycle,
  type DashboardRef,
  type DashboardSnapshot,
  type DashboardVersionRef,
  type EditorLease,
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
  users,
} from '@axp/db';
import type { Clock } from '../clock';
import type { AuditService } from '../audit/audit-service';
import type { SemanticService } from '../semantic/semantic-service';
import { decideLease, holdsLease, isHeldByOther, type LeaseSnapshot } from './draft-lease';
import { overlaps, resolveLayout } from './layout';

export interface DashboardServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly semantics: SemanticService;
  readonly leasePolicy: {
    readonly ttlSeconds: number;
    readonly heartbeatSeconds: number;
  };
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
  /** Who is editing, when a live lease exists. */
  readonly lease: EditorLease | null;
  /** How often the editor should refresh its lease, in seconds. */
  readonly heartbeatSeconds: number;
}

export interface LeaseResult {
  readonly acquired: boolean;
  readonly lease: EditorLease;
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
      lease: null,
      heartbeatSeconds: this.deps.leasePolicy.heartbeatSeconds,
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

  async getDraft(
    tenantId: string,
    dashboardId: string,
    callerUserId?: string,
  ): Promise<DraftState> {
    const dashboard = await this.requireDashboard(tenantId, dashboardId);
    const draft = await this.requireDraft(dashboardId);

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
      lease: await this.describeLease(leaseOf(draft), callerUserId),
      heartbeatSeconds: this.deps.leasePolicy.heartbeatSeconds,
    };
  }

  // --- editor lease --------------------------------------------------------

  /**
   * Claims the draft for one editor (Master Spec §21, D3).
   *
   * Returns rather than throws when somebody else holds it: the caller is told
   * who and until when, so the UI can offer a takeover instead of a dead end.
   * `force` performs that takeover and is audited, because it ends someone
   * else's editing session.
   */
  async acquireLease(params: {
    tenantId: string;
    dashboardId: string;
    userId: string;
    force?: boolean;
  }): Promise<LeaseResult> {
    await this.requireDashboard(params.tenantId, params.dashboardId);
    const now = this.deps.clock.now();

    const decision = await this.deps.db.transaction(async (tx) => {
      // FOR UPDATE: two editors arriving at the same instant must not both be
      // told they got it.
      const [row] = await tx
        .select({
          leaseUserId: dashboardDrafts.leaseUserId,
          leaseExpiresAt: dashboardDrafts.leaseExpiresAt,
        })
        .from(dashboardDrafts)
        .where(eq(dashboardDrafts.dashboardId, params.dashboardId))
        .for('update')
        .limit(1);

      if (!row) {
        throw new AppError('not_found', {
          code: 'draft_not_found',
          internalMessage: `Dashboard ${params.dashboardId} has no draft row.`,
        });
      }

      const current: LeaseSnapshot = { userId: row.leaseUserId, expiresAt: row.leaseExpiresAt };
      const outcome = decideLease({
        current,
        requesterId: params.userId,
        now,
        ttlSeconds: this.deps.leasePolicy.ttlSeconds,
        ...(params.force ? { force: true } : {}),
      });

      if (outcome.kind === 'granted') {
        await tx
          .update(dashboardDrafts)
          .set({ leaseUserId: params.userId, leaseExpiresAt: outcome.expiresAt })
          .where(eq(dashboardDrafts.dashboardId, params.dashboardId));
      }

      return { outcome, previousUserId: current.userId };
    });

    if (decision.outcome.kind === 'held_by_other') {
      return {
        acquired: false,
        lease: {
          userId: decision.outcome.userId,
          userName: await this.userName(decision.outcome.userId),
          expiresAt: decision.outcome.expiresAt.toISOString(),
          heldByCaller: false,
        },
      };
    }

    if (decision.outcome.reason === 'taken_over' && decision.previousUserId) {
      await this.deps.audit.success('dashboard.editor_takeover', {
        actorUserId: params.userId,
        tenantId: params.tenantId,
        targetType: 'dashboard',
        targetId: params.dashboardId,
        metadata: { fromUserId: decision.previousUserId },
      });
    }

    return {
      acquired: true,
      lease: {
        userId: params.userId,
        userName: await this.userName(params.userId),
        expiresAt: decision.outcome.expiresAt.toISOString(),
        heldByCaller: true,
      },
    };
  }

  /** Releases the lease, but only for the editor who holds it. */
  async releaseLease(params: {
    tenantId: string;
    dashboardId: string;
    userId: string;
  }): Promise<void> {
    await this.requireDashboard(params.tenantId, params.dashboardId);

    await this.deps.db
      .update(dashboardDrafts)
      .set({ leaseUserId: null, leaseExpiresAt: null })
      .where(
        and(
          eq(dashboardDrafts.dashboardId, params.dashboardId),
          eq(dashboardDrafts.leaseUserId, params.userId),
        ),
      );
  }

  // --- version history and rollback ----------------------------------------

  async listVersions(tenantId: string, dashboardId: string): Promise<DashboardVersionRef[]> {
    const dashboard = await this.requireDashboard(tenantId, dashboardId);

    const rows = await this.deps.db
      .select()
      .from(dashboardVersions)
      .where(eq(dashboardVersions.dashboardId, dashboardId))
      .orderBy(desc(dashboardVersions.version));

    return rows.map((row) => ({
      version: row.version,
      status: row.status,
      publishedAt: row.createdAt.toISOString(),
      publishedByUserId: row.publishedByUserId,
      rolledBackFromVersion: row.rolledBackFromVersion,
      isCurrent: row.id === dashboard.publishedVersionId,
      widgetCount: (row.snapshot as unknown as DashboardSnapshot).widgets.length,
    }));
  }

  /**
   * Rolls back by publishing a NEW version from an older snapshot.
   *
   * Never by resurrecting the old row. A published version is immutable and
   * history is append-only, so "we went back to version 2" stays visible as
   * exactly that (Master Spec §21).
   *
   * The draft is left alone: an editor's work in progress is not somebody
   * else's to discard.
   */
  async rollbackTo(params: {
    tenantId: string;
    dashboardId: string;
    version: number;
    actorUserId: string;
  }): Promise<PublishedState> {
    await this.requireDashboard(params.tenantId, params.dashboardId);

    const [source] = await this.deps.db
      .select()
      .from(dashboardVersions)
      .where(
        and(
          eq(dashboardVersions.dashboardId, params.dashboardId),
          eq(dashboardVersions.version, params.version),
        ),
      )
      .limit(1);

    if (!source) {
      throw new AppError('not_found', {
        code: 'dashboard_version_not_found',
        messageKey: 'dashboard.version_not_found',
        messageParams: { version: params.version },
        internalMessage: `Dashboard ${params.dashboardId} has no version ${params.version}.`,
      });
    }

    const snapshot = source.snapshot as unknown as DashboardSnapshot;
    const nextVersion = (await this.latestVersionNumber(params.dashboardId)) + 1;
    const versionId = newId();

    await this.deps.db.transaction(async (tx) => {
      await tx.insert(dashboardVersions).values({
        id: versionId,
        dashboardId: params.dashboardId,
        version: nextVersion,
        status: 'published',
        snapshot: snapshot as unknown as Record<string, unknown>,
        pinnedSemanticVersionIds: source.pinnedSemanticVersionIds,
        rolledBackFromVersion: params.version,
        publishedByUserId: params.actorUserId,
      });

      await tx
        .update(dashboards)
        .set({ publishedVersionId: versionId, lifecycle: 'published' })
        .where(eq(dashboards.id, params.dashboardId));
    });

    await this.deps.audit.success('dashboard.rolled_back', {
      actorUserId: params.actorUserId,
      tenantId: params.tenantId,
      targetType: 'dashboard',
      targetId: params.dashboardId,
      metadata: { toVersion: nextVersion, fromVersion: params.version },
    });

    return {
      dashboardId: params.dashboardId,
      version: nextVersion,
      snapshot,
      publishedAt: this.deps.clock.now().toISOString(),
    };
  }

  // --- archive and trash ---------------------------------------------------

  /**
   * Moves a dashboard between draft/published and archived/trash.
   *
   * Nothing is deleted. An archived dashboard is out of the way but intact; a
   * trashed one is out of sight and still recoverable. Hard deletion is a
   * separate, later decision and never a side effect of tidying up
   * (Master Spec §21).
   */
  async changeLifecycle(params: {
    tenantId: string;
    dashboardId: string;
    to: Extract<DashboardLifecycle, 'archived' | 'trash'> | 'restore';
    actorUserId: string;
  }): Promise<DashboardLifecycle> {
    const dashboard = await this.requireDashboard(params.tenantId, params.dashboardId);
    const now = this.deps.clock.now();

    const next: DashboardLifecycle =
      params.to === 'restore' ? (dashboard.publishedVersionId ? 'published' : 'draft') : params.to;

    if (
      params.to === 'restore' &&
      dashboard.lifecycle !== 'archived' &&
      dashboard.lifecycle !== 'trash'
    ) {
      throw new AppError('conflict', {
        code: 'dashboard_not_restorable',
        messageKey: 'dashboard.not_restorable',
        internalMessage: `Dashboard ${params.dashboardId} is ${dashboard.lifecycle}.`,
      });
    }

    await this.deps.db
      .update(dashboards)
      .set({
        lifecycle: next,
        archivedAt: next === 'archived' ? now : null,
        trashedAt: next === 'trash' ? now : null,
      })
      .where(eq(dashboards.id, params.dashboardId));

    const action =
      params.to === 'archived'
        ? 'dashboard.archived'
        : params.to === 'trash'
          ? 'dashboard.trashed'
          : 'dashboard.restored';

    await this.deps.audit.success(action, {
      actorUserId: params.actorUserId,
      tenantId: params.tenantId,
      targetType: 'dashboard',
      targetId: params.dashboardId,
      metadata: { from: dashboard.lifecycle, to: next },
    });

    return next;
  }

  /**
   * Autosaves the draft.
   *
   * Two independent guards, because they catch different mistakes:
   *
   *   - the editor lease stops a second editor from starting at all, and says
   *     who is already in there;
   *   - optimistic concurrency on `revisionId` catches everything the lease
   *     cannot - a stale tab, a retried request, a takeover that happened
   *     mid-edit - by refusing a write against a revision that has moved on.
   *
   * Saving on a free draft claims the lease implicitly. Someone who is typing
   * is evidently editing, and making them press a button first would only
   * teach them to press it without reading it.
   */
  async saveDraft(params: {
    tenantId: string;
    dashboardId: string;
    expectedRevisionId: string;
    snapshot: DashboardSnapshot;
    actorUserId: string;
  }): Promise<DraftState> {
    await this.requireDashboard(params.tenantId, params.dashboardId);
    await this.assertMayWriteDraft(params.dashboardId, params.actorUserId);

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

    // A save is a heartbeat: someone who is typing has not gone away.
    await this.deps.db
      .update(dashboardDrafts)
      .set({
        leaseUserId: params.actorUserId,
        leaseExpiresAt: new Date(
          this.deps.clock.now().getTime() + this.deps.leasePolicy.ttlSeconds * 1000,
        ),
      })
      .where(eq(dashboardDrafts.dashboardId, params.dashboardId));

    return this.getDraft(params.tenantId, params.dashboardId, params.actorUserId);
  }

  /**
   * Refuses a write while another editor holds a live lease.
   *
   * `conflict` rather than `permission_denied`: the caller is allowed to edit
   * this dashboard, just not at this moment, and the two situations must not
   * look the same to a user (D10).
   */
  private async assertMayWriteDraft(dashboardId: string, userId: string): Promise<void> {
    const draft = await this.requireDraft(dashboardId);
    const current = leaseOf(draft);
    if (!isHeldByOther(current, userId, this.deps.clock.now())) return;

    throw new AppError('conflict', {
      code: 'draft_locked',
      messageKey: 'dashboard.draft_locked',
      messageParams: { userName: await this.userName(current.userId!) },
      internalMessage: `Draft of ${dashboardId} is leased by ${current.userId}.`,
    });
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

      // Publishing ends an editing session: the draft is clean, so the lease
      // is released rather than left to expire on an empty desk. An editor
      // who carries on editing re-acquires it implicitly on the next save.
      await tx
        .update(dashboardDrafts)
        .set({ hasUnpublishedChanges: 0, leaseUserId: null, leaseExpiresAt: null })
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

  private async requireDraft(dashboardId: string) {
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
    return draft;
  }

  /** The lease as the API describes it, or null when nobody is editing. */
  private async describeLease(
    current: LeaseSnapshot,
    callerUserId?: string,
  ): Promise<EditorLease | null> {
    const now = this.deps.clock.now();
    if (!current.userId || !current.expiresAt || current.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    return {
      userId: current.userId,
      userName: await this.userName(current.userId),
      expiresAt: current.expiresAt.toISOString(),
      heldByCaller: callerUserId !== undefined && holdsLease(current, callerUserId, now),
    };
  }

  /** A display name for the lease holder. Never an email address. */
  private async userName(userId: string): Promise<string> {
    const [row] = await this.deps.db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return row ? `${row.firstName} ${row.lastName}`.trim() : 'Unbekannt';
  }

  private async latestVersionNumber(dashboardId: string): Promise<number> {
    const [latest] = await this.deps.db
      .select({ version: dashboardVersions.version })
      .from(dashboardVersions)
      .where(eq(dashboardVersions.dashboardId, dashboardId))
      .orderBy(desc(dashboardVersions.version))
      .limit(1);

    return latest?.version ?? 0;
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

/** Reads the lease columns off a draft row. */
function leaseOf(draft: {
  leaseUserId: string | null;
  leaseExpiresAt: Date | null;
}): LeaseSnapshot {
  return { userId: draft.leaseUserId, expiresAt: draft.leaseExpiresAt };
}

/**
 * Structural validation of a layout (D3).
 *
 * Checks what makes a layout impossible rather than merely ugly, and checks it
 * at every breakpoint - a dashboard that is valid on a desktop and broken on a
 * phone is broken. The rules come from the grid engine rather than being
 * restated here, so validation and the editor can never drift apart.
 *
 * Overlap is a blocking error. The engine cannot produce one, so an overlap in
 * a draft means the snapshot came from somewhere else - an import, an older
 * client, a hand-edited payload - and publishing it would put a broken layout
 * in front of viewers.
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

  issues.push(...findOverlaps(widgets));
  return issues;
}

/** Overlapping pairs at any breakpoint, reported once per widget. */
function findOverlaps(widgets: readonly WidgetConfig[]): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const reported = new Set<string>();

  for (const breakpoint of BREAKPOINTS as readonly Breakpoint[]) {
    const layout = [...resolveLayout(widgets, breakpoint).entries()];

    for (let i = 0; i < layout.length; i += 1) {
      for (let j = i + 1; j < layout.length; j += 1) {
        const [idA, a] = layout[i]!;
        const [idB, b] = layout[j]!;
        if (!overlaps(a, b)) continue;

        const key = `${breakpoint}:${idA}:${idB}`;
        if (reported.has(key)) continue;
        reported.add(key);

        issues.push({
          widgetId: idA,
          messageKey: 'dashboard.publish.widgets_overlap',
          messageParams: { breakpoint, other: idB },
        });
      }
    }
  }

  return issues;
}
