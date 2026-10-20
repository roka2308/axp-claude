import { and, eq, inArray } from 'drizzle-orm';
import {
  AppError,
  type ContextProfile,
  contextProfileComplete,
  contextProfileStarted,
  DISMISSABLE_SETUP_STEPS,
  type SetupReadiness,
  type SetupStep,
  type SetupStepKey,
} from '@axp/contracts';
import {
  dashboards,
  type Database,
  matomoConnections,
  matomoSites,
  projects,
  projectSites,
  tenants,
} from '@axp/db';
import type { AuditService } from '../audit/audit-service';
import type { MatomoConnectionService } from '../matomo/connection-service';
import type { SemanticService } from '../semantic/semantic-service';
import type { TenantService } from './tenant-service';

export interface ProjectServiceDeps {
  readonly db: Database;
  readonly audit: AuditService;
  readonly tenants: TenantService;
  readonly matomo: MatomoConnectionService;
  readonly semantics: SemanticService;
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
  readonly contextProfile: ContextProfile;
}

export interface ProjectSetupStatus {
  readonly projectId: string;
  readonly readiness: SetupReadiness;
  readonly steps: readonly SetupStep[];
}

/** Where a new project reads its data from, if already known (Master Spec §13). */
export type ProjectDataSource =
  /** A site another project of the tenant already reads. */
  | { readonly kind: 'existing_site'; readonly siteId: string }
  /** A site of an existing tenant connection, not yet imported. */
  | {
      readonly kind: 'connection_site';
      readonly connectionId: string;
      readonly matomoSiteId: number;
    }
  | { readonly kind: 'later' };

interface StoredChecklist {
  readonly notRelevant?: readonly SetupStepKey[];
}

/**
 * Project context and setup state (Master Spec §13).
 *
 * The setup checklist is resumable and non-linear, so its state is DERIVED from
 * what is actually configured rather than from a stored wizard position. A
 * developer seeding data directly, or a solution package installing pieces, is
 * then reflected correctly without anyone having to remember to tick a box.
 * The one thing stored is a person's decision that an optional step does not
 * apply - that is a decision, not a configuration, and nothing could derive it.
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
        contextProfile: projects.contextProfile,
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
      .map((row) => toSummary(row));
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
        contextProfile: projects.contextProfile,
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

    return toSummary(row);
  }

  /**
   * Creates a project in the small four-step flow (Master Spec §13): basics,
   * context, data source, done. Everything after that is the checklist.
   *
   * A data source is optional: "later" is a legitimate answer, and the
   * checklist then says what is missing. An existing tenant connection is
   * reused rather than asked for again - connections belong to the tenant,
   * sites to projects.
   */
  async createProject(input: {
    tenantId: string;
    name: string;
    slug: string;
    description?: string;
    timezone: string;
    defaultLocale: 'de' | 'en';
    contextProfile: ContextProfile;
    source: ProjectDataSource;
    actorUserId: string;
  }): Promise<{ projectId: string }> {
    const [clash] = await this.deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.tenantId, input.tenantId), eq(projects.slug, input.slug)))
      .limit(1);
    if (clash) {
      throw new AppError('conflict', {
        code: 'project_slug_taken',
        messageKey: 'project.slug_taken',
        fieldErrors: { slug: 'project.slug_taken' },
      });
    }

    // The site is checked before anything is written, so a wrong choice
    // leaves no half-created project behind.
    let siteId: string | null = null;
    if (input.source.kind === 'existing_site') {
      const [site] = await this.deps.db
        .select({ id: matomoSites.id })
        .from(matomoSites)
        .innerJoin(matomoConnections, eq(matomoConnections.id, matomoSites.connectionId))
        .where(
          and(
            eq(matomoSites.id, input.source.siteId),
            eq(matomoConnections.tenantId, input.tenantId),
          ),
        )
        .limit(1);
      if (!site) {
        throw new AppError('not_found', {
          code: 'site_not_found',
          messageKey: 'project.site_not_found',
          internalMessage: `Site ${input.source.siteId} is not a site of tenant ${input.tenantId}.`,
        });
      }
      siteId = site.id;
    } else if (input.source.kind === 'connection_site') {
      ({ siteId } = await this.deps.matomo.importSite(
        input.tenantId,
        input.source.connectionId,
        input.source.matomoSiteId,
        input.actorUserId,
      ));
    }

    const { projectId } = await this.deps.tenants.createProject({
      tenantId: input.tenantId,
      portableId: `project.${input.slug}`,
      name: input.name,
      slug: input.slug,
      ...(input.description ? { description: input.description } : {}),
      timezone: input.timezone,
      defaultLocale: input.defaultLocale,
      actorUserId: input.actorUserId,
    });

    await this.deps.db
      .update(projects)
      .set({ contextProfile: cleanProfile(input.contextProfile) })
      .where(eq(projects.id, projectId));

    if (siteId) {
      await this.deps.matomo.assignSiteToProject(
        input.tenantId,
        projectId,
        siteId,
        input.actorUserId,
      );
    }

    await this.refreshSetupState(input.tenantId, projectId);
    return { projectId };
  }

  /** Replaces the Context Profile. Text only; the product never interprets it. */
  async updateContextProfile(input: {
    tenantId: string;
    projectId: string;
    profile: ContextProfile;
    actorUserId: string;
  }): Promise<ContextProfile> {
    await this.getProject(input.tenantId, input.projectId);
    const profile = cleanProfile(input.profile);

    await this.deps.db
      .update(projects)
      .set({ contextProfile: profile })
      .where(eq(projects.id, input.projectId));

    await this.deps.audit.success('project.context_updated', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      targetType: 'project',
      targetId: input.projectId,
      // Which fields were filled, never what they say.
      metadata: { fields: Object.keys(profile).join(',') },
    });

    await this.refreshSetupState(input.tenantId, input.projectId);
    return profile;
  }

  /**
   * Marks an optional step "not relevant", or takes that back.
   *
   * Only optional steps: a step readiness depends on cannot be waved away,
   * because "ready" would then stop meaning ready.
   */
  async setStepRelevance(input: {
    tenantId: string;
    projectId: string;
    step: SetupStepKey;
    notRelevant: boolean;
    actorUserId?: string;
  }): Promise<ProjectSetupStatus> {
    if (!DISMISSABLE_SETUP_STEPS.includes(input.step)) {
      throw new AppError('validation_failed', {
        code: 'step_not_dismissable',
        messageKey: 'project.step_not_dismissable',
      });
    }
    await this.getProject(input.tenantId, input.projectId);

    const [row] = await this.deps.db
      .select({ setupChecklist: projects.setupChecklist })
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);

    const stored = (row?.setupChecklist ?? {}) as StoredChecklist;
    const current = new Set(stored.notRelevant ?? []);
    if (input.notRelevant) current.add(input.step);
    else current.delete(input.step);

    await this.deps.db
      .update(projects)
      .set({ setupChecklist: { ...stored, notRelevant: [...current] } })
      .where(eq(projects.id, input.projectId));
    await this.deps.audit.success('project.updated', {
      actorUserId: input.actorUserId ?? null,
      tenantId: input.tenantId,
      targetType: 'project',
      targetId: input.projectId,
      metadata: { setupStep: input.step, notRelevant: input.notRelevant },
    });

    await this.refreshSetupState(input.tenantId, input.projectId);
    return this.getSetupStatus(input.tenantId, input.projectId);
  }

  /**
   * Derives the setup checklist from actual configuration.
   *
   * Three kinds of step (Requirements Baseline §15): core steps always block
   * readiness; conditional ones block it only when they apply - mapping only
   * matters once something needs mapping; optional ones never block it.
   * `ready_with_limitations` is a real outcome, not a rounding of "almost
   * ready": the core is done, but something optional is still open.
   */
  async getSetupStatus(tenantId: string, projectId: string): Promise<ProjectSetupStatus> {
    await this.getProject(tenantId, projectId);

    const [connectionRows, siteRows, dashboardRows, projectRows, mapping] = await Promise.all([
      this.deps.db
        .select({ id: matomoConnections.id, status: matomoConnections.status })
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
      this.deps.db
        .select({
          setupChecklist: projects.setupChecklist,
          contextProfile: projects.contextProfile,
        })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1),
      this.mappingState(tenantId, projectId),
    ]);

    const projectRow = projectRows[0];
    const notRelevant = new Set(
      ((projectRow?.setupChecklist ?? {}) as StoredChecklist).notRelevant ?? [],
    );
    const profile = (projectRow?.contextProfile ?? {}) as ContextProfile;

    const connectionState =
      connectionRows.length === 0
        ? 'open'
        : connectionRows.every((row) => row.status === 'failing')
          ? // Configured, but not answering: someone has to look.
            'review_required'
          : 'done';

    const steps: SetupStep[] = [
      dismissable('context_profile', 'optional', notRelevant, {
        state: contextProfileComplete(profile)
          ? 'done'
          : contextProfileStarted(profile)
            ? 'in_progress'
            : 'open',
      }),
      step('matomo_connection', 'core', { state: connectionState }),
      step('site_assignment', 'core', {
        state: siteRows.length > 0 ? 'done' : 'open',
        ...(siteRows[0] ? { detail: siteRows[0].name } : {}),
      }),
      step('mapping', 'conditional', {
        state:
          mapping.needed === 0
            ? 'not_relevant'
            : mapping.decided === mapping.needed
              ? 'done'
              : mapping.decided > 0
                ? 'in_progress'
                : 'open',
        ...(mapping.needed > 0 ? { detail: `${mapping.decided}/${mapping.needed}` } : {}),
      }),
      step('first_dashboard', 'core', {
        state: dashboardRows.some((row) => row.publishedVersionId)
          ? 'done'
          : dashboardRows.length > 0
            ? 'in_progress'
            : 'open',
      }),
      // Reporting arrives in Phase 8. It stays open and non-blocking until a
      // person says it does not apply - the product does not decide that.
      dismissable('reporting', 'optional', notRelevant, { state: 'open' }),
    ];

    const settled = (entry: SetupStep) => entry.state === 'done' || entry.state === 'not_relevant';
    const blocking = steps.filter((entry) => entry.required && !settled(entry));
    const optionalOpen = steps.filter((entry) => !entry.required && !settled(entry));

    const readiness: SetupReadiness =
      blocking.length > 0
        ? 'setup_required'
        : optionalOpen.length > 0
          ? 'ready_with_limitations'
          : 'ready';

    return { projectId, readiness, steps };
  }

  /**
   * How many of the requirements this project's definitions depend on have
   * been decided - mapped to a source, or consciously marked not available.
   */
  private async mappingState(
    tenantId: string,
    projectId: string,
  ): Promise<{ needed: number; decided: number }> {
    const definitions = await this.deps.semantics.listForProject(tenantId, projectId);
    const versionIds = definitions
      .filter((definition) => definition.type === 'custom_metric' && definition.currentVersionId)
      .map((definition) => definition.currentVersionId!);
    if (versionIds.length === 0) return { needed: 0, decided: 0 };

    const versions = await this.deps.semantics.resolveVersions(versionIds);
    const requirements = new Set(
      versions.flatMap((version) =>
        version.body.kind === 'custom' ? [version.body.requirementKey] : [],
      ),
    );
    const bound = new Set(
      (await this.deps.semantics.listSourceBindings(projectId)).map(
        (binding) => binding.requirementKey,
      ),
    );

    return {
      needed: requirements.size,
      decided: [...requirements].filter((key) => bound.has(key)).length,
    };
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

interface ProjectRow {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  slug: string;
  description: string | null;
  timezone: string;
  setupState: string;
  contextProfile: Record<string, string> | null;
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    ...row,
    setupState: toReadiness(row.setupState),
    contextProfile: (row.contextProfile ?? {}) as ContextProfile,
  };
}

/** Drops empty fields, so "filled" always means there is text. */
function cleanProfile(profile: ContextProfile): Record<string, string> {
  return Object.fromEntries(
    Object.entries(profile)
      .map(([field, value]) => [field, value?.trim() ?? ''] as const)
      .filter(([, value]) => value.length > 0),
  );
}

function step(
  key: SetupStepKey,
  category: SetupStep['category'],
  rest: Pick<SetupStep, 'state' | 'detail'>,
): SetupStep {
  return {
    key: `setupStep.${key}`,
    step: key,
    category,
    required: category === 'core' || (category === 'conditional' && rest.state !== 'not_relevant'),
    ...rest,
  };
}

function dismissable(
  key: SetupStepKey,
  category: SetupStep['category'],
  notRelevant: ReadonlySet<SetupStepKey>,
  rest: Pick<SetupStep, 'state' | 'detail'>,
): SetupStep {
  return notRelevant.has(key) && rest.state !== 'done'
    ? { ...step(key, category, { state: 'not_relevant' }), markedNotRelevant: true }
    : step(key, category, rest);
}
