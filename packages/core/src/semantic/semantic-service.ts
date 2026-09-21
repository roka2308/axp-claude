import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  AppError,
  type BindingHealth,
  CORE_NATIVE_METRICS,
  type DriftState,
  type NativeMetricDefinition,
  type SemanticDefinitionBody,
  type SemanticDefinitionRef,
  type SemanticLifecycle,
  type SemanticType,
  type SemanticVersionRef,
  type SourceBindingDescriptor,
  type SourceBindingRef,
} from '@axp/contracts';
import {
  type Database,
  newId,
  semanticDefinitions,
  semanticVersions,
  sourceBindings,
} from '@axp/db';
import type { Clock } from '../clock';
import { NORMALIZED_METRICS } from '../matomo/connector';
import type { AuditService } from '../audit/audit-service';
import { assertFormulaValid, referencedVersionIds } from './formula';
import { assertScoreValid, scoreComponentVersionIds } from './score';

export interface SemanticServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
}

/**
 * Semantic catalog (Master Spec §13).
 *
 * Phase 1 covers what the first vertical slice needs: native metrics with
 * immutable versions, and resolution of a pinned version into something the
 * connector can execute. Custom metrics, formulas, scores and the visual
 * builders arrive with Phase 3 - the version and pinning model is already the
 * final one, so nothing has to be migrated then.
 */
export class SemanticService {
  constructor(private readonly deps: SemanticServiceDeps) {}

  /**
   * Seeds the native metrics the slice needs, idempotently.
   *
   * These are product-global definitions: `visits` and `pageviews` mean the
   * same thing everywhere, which is exactly why they belong in the shared
   * catalog rather than being redefined per project.
   */
  async ensureCoreNativeMetrics(): Promise<SemanticDefinitionRef[]> {
    const specs: { portableId: string; name: string; body: NativeMetricDefinition }[] = [
      {
        portableId: CORE_NATIVE_METRICS.visits,
        name: 'Besuche',
        body: {
          kind: 'native',
          sourceMetric: NORMALIZED_METRICS.visits,
          unit: 'count',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 0,
        },
      },
      {
        portableId: CORE_NATIVE_METRICS.pageviews,
        name: 'Seitenaufrufe',
        body: {
          kind: 'native',
          sourceMetric: NORMALIZED_METRICS.pageviews,
          unit: 'count',
          scope: 'action',
          direction: 'higher_is_better',
          decimals: 0,
        },
      },
    ];

    const refs: SemanticDefinitionRef[] = [];
    for (const spec of specs) {
      refs.push(await this.ensureGlobalDefinition(spec.portableId, spec.name, spec.body));
    }
    return refs;
  }

  private async ensureGlobalDefinition(
    portableId: string,
    name: string,
    body: SemanticDefinitionBody,
  ): Promise<SemanticDefinitionRef> {
    const [existing] = await this.deps.db
      .select()
      .from(semanticDefinitions)
      .where(
        and(
          eq(semanticDefinitions.portableId, portableId),
          isNull(semanticDefinitions.tenantId),
          isNull(semanticDefinitions.projectId),
        ),
      )
      .limit(1);

    if (existing?.currentVersionId) {
      return {
        id: existing.id,
        portableId: existing.portableId,
        type: existing.type,
        name: existing.name,
        currentVersionId: existing.currentVersionId,
      };
    }

    const definitionId = existing?.id ?? newId();
    const versionId = newId();

    await this.deps.db.transaction(async (tx) => {
      if (!existing) {
        await tx.insert(semanticDefinitions).values({
          id: definitionId,
          portableId,
          tenantId: null,
          projectId: null,
          type: 'native_metric',
          name,
        });
      }

      await tx.insert(semanticVersions).values({
        id: versionId,
        definitionId,
        version: 1,
        status: 'active',
        body: body as unknown as Record<string, unknown>,
        dependencyVersionIds: [],
      });

      await tx
        .update(semanticDefinitions)
        .set({ currentVersionId: versionId })
        .where(eq(semanticDefinitions.id, definitionId));
    });

    return {
      id: definitionId,
      portableId,
      type: 'native_metric',
      name,
      currentVersionId: versionId,
    };
  }

  /**
   * Definitions visible in a project: global, the tenant's, and the project's.
   *
   * A project-specific definition with the same portable id shadows a global
   * one, which is how a project refines a shipped definition without editing it.
   */
  async listForProject(tenantId: string, projectId: string): Promise<SemanticDefinitionRef[]> {
    const rows = await this.deps.db
      .select()
      .from(semanticDefinitions)
      .where(
        or(
          and(isNull(semanticDefinitions.tenantId), isNull(semanticDefinitions.projectId)),
          and(eq(semanticDefinitions.tenantId, tenantId), isNull(semanticDefinitions.projectId)),
          eq(semanticDefinitions.projectId, projectId),
        ),
      );

    const byPortableId = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const current = byPortableId.get(row.portableId);
      // Narrower scope wins: project over tenant over global.
      const specificity = (candidate: (typeof rows)[number]) =>
        candidate.projectId ? 2 : candidate.tenantId ? 1 : 0;
      if (!current || specificity(row) > specificity(current))
        byPortableId.set(row.portableId, row);
    }

    return [...byPortableId.values()].map((row) => ({
      id: row.id,
      portableId: row.portableId,
      type: row.type,
      name: row.name,
      currentVersionId: row.currentVersionId,
    }));
  }

  /** Resolves pinned version ids. Missing ids are an error, never a silent gap. */
  async resolveVersions(versionIds: readonly string[]): Promise<SemanticVersionRef[]> {
    if (versionIds.length === 0) return [];

    const rows = await this.deps.db
      .select()
      .from(semanticVersions)
      .where(inArray(semanticVersions.id, [...versionIds]));

    const byId = new Map(rows.map((row) => [row.id, row]));
    return versionIds.map((id) => {
      const row = byId.get(id);
      if (!row) {
        throw new AppError('invalid_configuration', {
          code: 'semantic_version_not_found',
          messageKey: 'semantic.version_not_found',
          internalMessage: `Pinned semantic version ${id} does not exist.`,
        });
      }
      return {
        id: row.id,
        definitionId: row.definitionId,
        version: row.version,
        status: row.status,
        body: row.body as unknown as SemanticDefinitionBody,
        dependencyVersionIds: row.dependencyVersionIds,
      };
    });
  }

  /** The active version of a definition, by portable id, honouring scope. */
  async getActiveVersionByPortableId(
    portableId: string,
    scope: { tenantId?: string; projectId?: string } = {},
  ): Promise<{ definition: SemanticDefinitionRef; version: SemanticVersionRef } | null> {
    const candidates = await this.deps.db
      .select()
      .from(semanticDefinitions)
      .where(eq(semanticDefinitions.portableId, portableId));

    const match =
      candidates.find((row) => scope.projectId && row.projectId === scope.projectId) ??
      candidates.find(
        (row) => scope.tenantId && row.tenantId === scope.tenantId && !row.projectId,
      ) ??
      candidates.find((row) => !row.tenantId && !row.projectId);

    if (!match?.currentVersionId) return null;

    const [version] = await this.resolveVersions([match.currentVersionId]);
    if (!version) return null;

    return {
      definition: {
        id: match.id,
        portableId: match.portableId,
        type: match.type,
        name: match.name,
        currentVersionId: match.currentVersionId,
      },
      version,
    };
  }

  // --- authoring -----------------------------------------------------------

  /**
   * Creates a definition and its first version, in draft.
   *
   * A definition is an identity; a version is content. Splitting them is what
   * makes "the business changed its mind about what Engagement means" a new
   * version rather than a silent edit to something dashboards already pin.
   */
  async createDefinition(input: {
    tenantId: string;
    projectId: string | null;
    portableId: string;
    type: SemanticType;
    name: string;
    description?: string;
    body: SemanticDefinitionBody;
    actorUserId: string;
  }): Promise<{ definition: SemanticDefinitionRef; version: SemanticVersionRef }> {
    await this.assertBodyIsValid(input.body);

    const definitionId = newId();
    const versionId = newId();
    const dependencies = dependenciesOf(input.body);

    await this.deps.db.transaction(async (tx) => {
      await tx.insert(semanticDefinitions).values({
        id: definitionId,
        portableId: input.portableId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        type: input.type,
        name: input.name,
        description: input.description ?? null,
      });

      await tx.insert(semanticVersions).values({
        id: versionId,
        definitionId,
        version: 1,
        // Draft, not active: a new definition is not something dashboards may
        // reach for until someone says it is ready.
        status: 'draft',
        body: input.body as unknown as Record<string, unknown>,
        dependencyVersionIds: dependencies,
        createdByUserId: input.actorUserId,
      });
    });

    return {
      definition: {
        id: definitionId,
        portableId: input.portableId,
        type: input.type,
        name: input.name,
        currentVersionId: null,
      },
      version: {
        id: versionId,
        definitionId,
        version: 1,
        status: 'draft',
        body: input.body,
        dependencyVersionIds: dependencies,
      },
    };
  }

  /**
   * Adds a new draft version to an existing definition.
   *
   * Never edits an existing one. A published dashboard pins a version id, and
   * that snapshot has to keep meaning what it meant when it was published
   * (Master Spec §13).
   */
  async addVersion(input: {
    tenantId: string;
    definitionId: string;
    body: SemanticDefinitionBody;
    actorUserId: string;
  }): Promise<SemanticVersionRef> {
    const definition = await this.requireDefinition(input.tenantId, input.definitionId);
    await this.assertBodyIsValid(input.body, definition.id);

    const [latest] = await this.deps.db
      .select({ version: semanticVersions.version })
      .from(semanticVersions)
      .where(eq(semanticVersions.definitionId, input.definitionId))
      .orderBy(desc(semanticVersions.version))
      .limit(1);

    const versionId = newId();
    const nextVersion = (latest?.version ?? 0) + 1;
    const dependencies = dependenciesOf(input.body);

    await this.deps.db.insert(semanticVersions).values({
      id: versionId,
      definitionId: input.definitionId,
      version: nextVersion,
      status: 'draft',
      body: input.body as unknown as Record<string, unknown>,
      dependencyVersionIds: dependencies,
      createdByUserId: input.actorUserId,
    });

    return {
      id: versionId,
      definitionId: input.definitionId,
      version: nextVersion,
      status: 'draft',
      body: input.body,
      dependencyVersionIds: dependencies,
    };
  }

  /**
   * Moves a version through its lifecycle (Master Spec §13).
   *
   * Activating one deprecates the previous active version rather than deleting
   * it: dashboards that pinned it keep working, and the catalog shows that it
   * has been superseded.
   */
  async changeVersionStatus(input: {
    tenantId: string;
    definitionId: string;
    versionId: string;
    to: SemanticLifecycle;
    actorUserId: string;
  }): Promise<SemanticVersionRef> {
    await this.requireDefinition(input.tenantId, input.definitionId);

    const [row] = await this.deps.db
      .select()
      .from(semanticVersions)
      .where(
        and(
          eq(semanticVersions.id, input.versionId),
          eq(semanticVersions.definitionId, input.definitionId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError('not_found', {
        code: 'semantic_version_not_found',
        messageKey: 'semantic.version_not_found',
        internalMessage: `Version ${input.versionId} does not belong to ${input.definitionId}.`,
      });
    }

    if (input.to === 'active') {
      await this.assertBodyIsValid(
        row.body as unknown as SemanticDefinitionBody,
        input.definitionId,
      );
    }

    await this.deps.db.transaction(async (tx) => {
      if (input.to === 'active') {
        await tx
          .update(semanticVersions)
          .set({ status: 'deprecated' })
          .where(
            and(
              eq(semanticVersions.definitionId, input.definitionId),
              eq(semanticVersions.status, 'active'),
            ),
          );
      }

      await tx
        .update(semanticVersions)
        .set({ status: input.to })
        .where(eq(semanticVersions.id, input.versionId));

      if (input.to === 'active') {
        await tx
          .update(semanticDefinitions)
          .set({ currentVersionId: input.versionId })
          .where(eq(semanticDefinitions.id, input.definitionId));
      }
    });

    await this.deps.audit.success(
      input.to === 'active' ? 'semantic.version_activated' : 'semantic.version_deprecated',
      {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        targetType: 'semantic_version',
        targetId: input.versionId,
        metadata: { definitionId: input.definitionId, version: row.version, to: input.to },
      },
    );

    return {
      id: row.id,
      definitionId: row.definitionId,
      version: row.version,
      status: input.to,
      body: row.body as unknown as SemanticDefinitionBody,
      dependencyVersionIds: row.dependencyVersionIds,
    };
  }

  /** Every version of a definition, newest first, for the history panel. */
  async listVersions(tenantId: string, definitionId: string): Promise<SemanticVersionRef[]> {
    await this.requireDefinition(tenantId, definitionId);

    const rows = await this.deps.db
      .select()
      .from(semanticVersions)
      .where(eq(semanticVersions.definitionId, definitionId))
      .orderBy(desc(semanticVersions.version));

    return rows.map((row) => ({
      id: row.id,
      definitionId: row.definitionId,
      version: row.version,
      status: row.status,
      body: row.body as unknown as SemanticDefinitionBody,
      dependencyVersionIds: row.dependencyVersionIds,
    }));
  }

  // --- source bindings -----------------------------------------------------

  /**
   * Records how a requirement is satisfied on a site.
   *
   * Deliberately does NOT touch any semantic version. Correcting a mapping is
   * a technical fix - the business definition of "Engagement" did not change
   * because someone pointed it at the right custom dimension (Gate F3).
   */
  async setSourceBinding(input: {
    tenantId: string;
    projectId: string | null;
    siteId: string | null;
    requirementKey: string;
    binding: SourceBindingDescriptor;
    actorUserId: string;
  }): Promise<SourceBindingRef> {
    const existing = await this.findBinding(input.projectId, input.siteId, input.requirementKey);
    const id = existing?.id ?? newId();

    if (existing) {
      await this.deps.db
        .update(sourceBindings)
        .set({ binding: input.binding as unknown as Record<string, unknown> })
        .where(eq(sourceBindings.id, id));
    } else {
      await this.deps.db.insert(sourceBindings).values({
        id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        siteId: input.siteId,
        requirementKey: input.requirementKey,
        binding: input.binding as unknown as Record<string, unknown>,
        createdByUserId: input.actorUserId,
      });
    }

    await this.deps.audit.success('source_binding.changed', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      targetType: 'source_binding',
      targetId: id,
      metadata: { requirementKey: input.requirementKey, kind: input.binding.kind },
    });

    return {
      id,
      requirementKey: input.requirementKey,
      siteId: input.siteId,
      binding: input.binding,
      updatedAt: this.deps.clock.now().toISOString(),
    };
  }

  async listSourceBindings(projectId: string): Promise<SourceBindingRef[]> {
    const rows = await this.deps.db
      .select()
      .from(sourceBindings)
      .where(eq(sourceBindings.projectId, projectId));

    return rows.map((row) => ({
      id: row.id,
      requirementKey: row.requirementKey,
      siteId: row.siteId,
      binding: row.binding as unknown as SourceBindingDescriptor,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * Compares what bindings point at against what the site currently offers.
   *
   * Reports, never repairs. A custom dimension that disappeared may have been
   * renamed, retired or broken, and only a person can say which - so this
   * produces a review state rather than a silent remap (Master Spec §13).
   */
  async checkBindingDrift(
    projectId: string,
    available: { metrics: readonly string[]; dimensions: readonly string[] },
  ): Promise<BindingHealth[]> {
    const bindings = await this.listSourceBindings(projectId);

    return bindings.map((binding) => {
      const state = driftOf(binding.binding, available);
      return {
        requirementKey: binding.requirementKey,
        siteId: binding.siteId,
        state,
        ...(state === 'ok'
          ? {}
          : {
              detailKey: `semantic.drift.${binding.binding.kind}`,
              availableSample: available.dimensions.slice(0, 8),
            }),
      };
    });
  }

  // --- shared --------------------------------------------------------------

  /**
   * Refuses a body that could not be evaluated.
   *
   * Formulas and scores are checked here rather than at query time: a broken
   * definition should fail while somebody is writing it, not hours later in
   * front of a viewer.
   */
  private async assertBodyIsValid(
    body: SemanticDefinitionBody,
    selfDefinitionId?: string,
  ): Promise<void> {
    if (body.kind === 'score') {
      assertScoreValid(body);
      await this.resolveVersions(scoreComponentVersionIds(body));
      return;
    }

    if (body.kind !== 'formula') return;

    const referenced = referencedVersionIds(body.ast);
    const versions = await this.resolveVersions(referenced);

    const inputs = new Map(versions.map((version) => [version.id, version.body]));
    const dependencies = new Map(
      versions.map((version) => [version.id, version.dependencyVersionIds]),
    );

    /*
     * The cycle check needs to know which versions *are* this definition.
     * Version 2 referencing version 1 of the same definition is the cycle,
     * even though the ids differ - so the whole set goes in. A brand-new
     * definition has no versions yet and cannot be part of one.
     */
    const selfVersionIds = selfDefinitionId ? await this.versionIdsOf(selfDefinitionId) : [];

    assertFormulaValid(body.ast, {
      inputs,
      dependencies,
      ...(selfVersionIds.length > 0 ? { selfVersionIds } : {}),
    });
  }

  /** Every version id belonging to a definition, for the cycle check. */
  private async versionIdsOf(definitionId: string): Promise<string[]> {
    const rows = await this.deps.db
      .select({ id: semanticVersions.id })
      .from(semanticVersions)
      .where(eq(semanticVersions.definitionId, definitionId));

    return rows.map((row) => row.id);
  }

  private async requireDefinition(tenantId: string, definitionId: string) {
    const [row] = await this.deps.db
      .select()
      .from(semanticDefinitions)
      .where(eq(semanticDefinitions.id, definitionId))
      .limit(1);

    if (!row || (row.tenantId !== null && row.tenantId !== tenantId)) {
      throw new AppError('not_found', {
        code: 'semantic_definition_not_found',
        messageKey: 'semantic.definition_not_found',
        internalMessage: `Definition ${definitionId} not visible to tenant ${tenantId}.`,
      });
    }
    return row;
  }

  private async findBinding(
    projectId: string | null,
    siteId: string | null,
    requirementKey: string,
  ) {
    const rows = await this.deps.db
      .select()
      .from(sourceBindings)
      .where(eq(sourceBindings.requirementKey, requirementKey));

    return rows.find((row) => row.projectId === projectId && row.siteId === siteId);
  }

  /** Names for display, keyed by version id. Used by the presentation layer. */
  async describeVersions(
    versionIds: readonly string[],
  ): Promise<Map<string, { name: string; body: SemanticDefinitionBody; version: number }>> {
    const versions = await this.resolveVersions(versionIds);
    if (versions.length === 0) return new Map();

    const definitions = await this.deps.db
      .select({ id: semanticDefinitions.id, name: semanticDefinitions.name })
      .from(semanticDefinitions)
      .where(
        inArray(
          semanticDefinitions.id,
          versions.map((version) => version.definitionId),
        ),
      );

    const namesByDefinition = new Map(definitions.map((row) => [row.id, row.name]));

    return new Map(
      versions.map((version) => [
        version.id,
        {
          name: namesByDefinition.get(version.definitionId) ?? 'Unbenannt',
          body: version.body,
          version: version.version,
        },
      ]),
    );
  }
}

/** Which versions a body depends on, whatever kind it is. */
function dependenciesOf(body: SemanticDefinitionBody): string[] {
  if (body.kind === 'formula') return referencedVersionIds(body.ast);
  if (body.kind === 'score') return scoreComponentVersionIds(body);
  return [];
}

/**
 * Whether what a binding points at still exists on the site.
 *
 * `not_available` is a deliberate statement - somebody recorded that this
 * requirement cannot be satisfied here - so it is `unresolved` rather than
 * drift, and it does not ask for a review that has already happened.
 */
function driftOf(
  binding: SourceBindingDescriptor,
  available: { metrics: readonly string[]; dimensions: readonly string[] },
): DriftState {
  switch (binding.kind) {
    case 'native_metric':
      return available.metrics.includes(binding.sourceMetric) ? 'ok' : 'review_required';
    case 'custom_dimension':
      return available.dimensions.includes(`dimension${binding.index}`) ? 'ok' : 'review_required';
    case 'event':
      return available.dimensions.includes('eventCategory') ? 'ok' : 'review_required';
    case 'goal':
      return available.metrics.includes('goals') ? 'ok' : 'review_required';
    case 'site_search':
      return available.dimensions.includes('searchKeyword') ? 'ok' : 'review_required';
    case 'not_available':
      return 'unresolved';
  }
}
