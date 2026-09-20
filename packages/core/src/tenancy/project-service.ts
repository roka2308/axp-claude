import { and, eq, inArray } from 'drizzle-orm';
import { AppError, type SetupReadiness } from '@axp/contracts';
import {
  dashboards,
  type Database,
  matomoConnections,
  matomoSites,
  projects,
  projectSites,
  tenants,
} from '@axp/db';

export interface ProjectServiceDeps {
  readonly db: Database;
}

export interface ProjectSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly timezone: string;
  readonly setupState: SetupReadiness;
}

export const SETUP_STEP_STATES = [
  'open',
  'in_progress',
  'done',
  'review_required',
  'not_relevant',
] as const;
export type SetupStepState = (typeof SETUP_STEP_STATES)[number];

export interface SetupStep {
  readonly key: string;
  readonly state: SetupStepState;
  /** Core steps block readiness; optional ones do not. */
  readonly required: boolean;
  readonly detail?: string;
}

export interface ProjectSetupStatus {
  readonly projectId: string;
  readonly readiness: SetupReadiness;
  readonly steps: readonly SetupStep[];
}

/**
 * Project context and setup state (Master Spec §13).
 *
 * The setup checklist is resumable and non-linear, so its state is DERIVED from
 * what is actually configured rather than from a stored wizard position. A
 * developer seeding data directly, or a solution package installing pieces, is
 * then reflected correctly without anyone having to remember to tick a box.
 */
export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  /**
   * Projects a caller may see.
   *
   * The ids come from the authorization context, which was resolved from the
   * database - never from the request.
   */
  async listAccessible(scope: {
    tenantIds: readonly string[];
    projectIds: readonly string[];
  }): Promise<ProjectSummary[]> {
    if (scope.tenantIds.length === 0 && scope.projectIds.length === 0) return [];

    const rows = await this.deps.db
      .select({
        id: projects.id,
        tenantId: projects.tenantId,
        tenantName: tenants.name,
        name: projects.name,
        slug: projects.slug,
        description: projects.description,
        timezone: projects.timezone,
        setupState: projects.setupState,
      })
      .from(projects)
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(
        scope.tenantIds.length > 0
          ? inArray(projects.tenantId, [...scope.tenantIds])
          : inArray(projects.id, [...scope.projectIds]),
      );

    // A tenant-scoped role covers all of the tenant's projects; a
    // project-scoped one covers only its own.
    const projectIdSet = new Set(scope.projectIds);
    const tenantIdSet = new Set(scope.tenantIds);

    return rows
      .filter((row) => tenantIdSet.has(row.tenantId) || projectIdSet.has(row.id))
      .map((row) => ({ ...row, setupState: toReadiness(row.setupState) }));
  }

  async getProject(tenantId: string, projectId: string): Promise<ProjectSummary> {
    const [row] = await this.deps.db
      .select({
        id: projects.id,
        tenantId: projects.tenantId,
        tenantName: tenants.name,
        name: projects.name,
        slug: projects.slug,
        description: projects.description,
        timezone: projects.timezone,
        setupState: projects.setupState,
      })
      .from(projects)
      .innerJoin(tenants, eq(tenants.id, projects.tenantId))
      .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)))
      .limit(1);

    if (!row) {
      throw new AppError('not_found', {
        code: 'project_not_found',
        messageKey: 'project.not_found',
        internalMessage: `Project ${projectId} not found for tenant ${tenantId}.`,
      });
    }

    return { ...row, setupState: toReadiness(row.setupState) };
  }

  /**
   * Derives the setup checklist from actual configuration.
   *
   * `ready_with_limitations` is a real outcome, not a rounding of "almost
   * ready": the core steps are done, but something optional is still open.
   */
  async getSetupStatus(tenantId: string, projectId: string): Promise<ProjectSetupStatus> {
    await this.getProject(tenantId, projectId);

    const [connectionCount, siteRows, dashboardRows] = await Promise.all([
      this.deps.db
        .select({ id: matomoConnections.id })
        .from(matomoConnections)
        .where(eq(matomoConnections.tenantId, tenantId)),
      this.deps.db
        .select({ id: matomoSites.id, name: matomoSites.name })
        .from(projectSites)
        .innerJoin(matomoSites, eq(matomoSites.id, projectSites.siteId))
        .where(eq(projectSites.projectId, projectId)),
      this.deps.db
        .select({ id: dashboards.id, publishedVersionId: dashboards.publishedVersionId })
        .from(dashboards)
        .where(eq(dashboards.projectId, projectId)),
    ]);

    const steps: SetupStep[] = [
      {
        key: 'setupStep.matomo_connection',
        state: connectionCount.length > 0 ? 'done' : 'open',
        required: true,
      },
      {
        key: 'setupStep.site_assignment',
        state: siteRows.length > 0 ? 'done' : 'open',
        required: true,
        ...(siteRows[0] ? { detail: siteRows[0].name } : {}),
      },
      {
        key: 'setupStep.first_dashboard',
        state: dashboardRows.some((row) => row.publishedVersionId)
          ? 'done'
          : dashboardRows.length > 0
            ? 'in_progress'
            : 'open',
        required: true,
      },
      {
        key: 'setupStep.context_profile',
        state: 'open',
        required: false,
      },
      {
        key: 'setupStep.reporting',
        // Reporting arrives in Phase 8; marking it "not relevant" now would be
        // dishonest, so it stays open and non-blocking.
        state: 'open',
        required: false,
      },
    ];

    const requiredOpen = steps.filter((step) => step.required && step.state !== 'done');
    const optionalOpen = steps.filter((step) => !step.required && step.state !== 'done');

    const readiness: SetupReadiness =
      requiredOpen.length > 0
        ? 'setup_required'
        : optionalOpen.length > 0
          ? 'ready_with_limitations'
          : 'ready';

    return { projectId, readiness, steps };
  }

  /** Keeps the stored coarse state in step with the derived checklist. */
  async refreshSetupState(tenantId: string, projectId: string): Promise<SetupReadiness> {
    const status = await this.getSetupStatus(tenantId, projectId);
    const stored =
      status.readiness === 'ready'
        ? 'ready'
        : status.readiness === 'ready_with_limitations'
          ? 'ready_with_limitations'
          : 'setup_required';

    await this.deps.db
      .update(projects)
      .set({ setupState: stored })
      .where(eq(projects.id, projectId));

    return status.readiness;
  }
}

function toReadiness(stored: string): SetupReadiness {
  switch (stored) {
    case 'ready':
      return 'ready';
    case 'ready_with_limitations':
      return 'ready_with_limitations';
    default:
      return 'setup_required';
  }
}
