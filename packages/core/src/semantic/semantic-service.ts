import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  AppError,
  CORE_NATIVE_METRICS,
  type NativeMetricDefinition,
  type SemanticDefinitionBody,
  type SemanticDefinitionRef,
  type SemanticVersionRef,
} from '@axp/contracts';
import { type Database, newId, semanticDefinitions, semanticVersions } from '@axp/db';
import type { Clock } from '../clock';
import { NORMALIZED_METRICS } from '../matomo/connector';
import type { AuditService } from '../audit/audit-service';

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
