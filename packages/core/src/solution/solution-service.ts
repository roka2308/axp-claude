import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { PRODUCT_VERSION } from '@axp/config';
import {
  AppError,
  type ConflictResolution,
  type DashboardSnapshot,
  type DashboardTemplateSpec,
  type MappingCandidate,
  type PackageAnalysis,
  type PackageConflict,
  type PackageIssue,
  type PortableDefinition,
  type RequirementMapping,
  type SemanticDefinitionRef,
  type SolutionCatalogEntry,
  type SolutionInstallationSummary,
  type SolutionInstallRequest,
  type SolutionInstallResult,
  type SolutionPackage,
  type SourceBindingDescriptor,
  type TemplateKind,
  type TemplateReadiness,
  type TemplateSummary,
  type WidgetConfig,
  type WidgetTemplateSpec,
} from '@axp/contracts';
import {
  type Database,
  matomoCapabilitySnapshots,
  newId,
  semanticDefinitions,
  semanticVersions,
  solutionInstallations,
  templates,
  users,
} from '@axp/db';
import type { Clock } from '../clock';
import type { AuditService } from '../audit/audit-service';
import type { DashboardService } from '../dashboard/dashboard-service';
import type { MatomoConnectionService } from '../matomo/connection-service';
import type { SemanticService } from '../semantic/semantic-service';
import type { ProjectService } from '../tenancy/project-service';
import { SOLUTION_CATALOG } from './catalog/pulse';
import { installOrder, validatePackage } from './package-validation';
import { canonicalJson, compareVersions, toLocalBody, toPortableBody } from './portable';

export interface SolutionServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly audit: AuditService;
  readonly semantics: SemanticService;
  readonly matomo: MatomoConnectionService;
  readonly dashboards: DashboardService;
  readonly projects: ProjectService;
}

/** Where a package comes from: the first-party catalogue, or an upload. */
export type PackageSource =
  | { readonly catalog: { readonly packageId: string; readonly packageVersion?: string } }
  | { readonly upload: unknown };

interface Visible {
  readonly ref: SemanticDefinitionRef;
  readonly projectScoped: boolean;
}

interface Prepared {
  readonly analysis: PackageAnalysis;
  readonly pkg: SolutionPackage | null;
  readonly siteId: string | null;
  readonly visible: ReadonlyMap<string, Visible>;
  readonly templateRows: ReadonlyMap<string, typeof templates.$inferSelect>;
  readonly definitionConflicts: ReadonlyMap<string, PackageConflict>;
}

/**
 * Solution packages and templates (Master Spec §14, Gate F6).
 *
 * The install flow is the one the spec prescribes - validate, compatibility,
 * dependencies, mapping, conflict analysis, preview, import - and `analyze`
 * runs all of it without writing anything. `install` runs it again (the client
 * is never trusted to have analysed the same thing) and only then writes.
 *
 * Nothing is overwritten in place. A changed definition becomes a new version,
 * and only if the installer chose that; published dashboards keep the
 * versions they pinned. A changed template gets a new template version, and
 * dashboards created from the old one never notice, because a dashboard is a
 * copy, not a reference (copy-on-insert).
 */
export class SolutionService {
  constructor(private readonly deps: SolutionServiceDeps) {}

  catalog(): SolutionCatalogEntry[] {
    return SOLUTION_CATALOG.map((entry) => ({
      packageId: entry.manifest.packageId,
      packageVersion: entry.manifest.packageVersion,
      name: entry.manifest.name,
      description: entry.manifest.description ?? null,
      publisher: entry.manifest.publisher,
    }));
  }

  resolveSource(source: PackageSource): unknown {
    if ('upload' in source) return source.upload;
    const match = SOLUTION_CATALOG.find(
      (entry) =>
        entry.manifest.packageId === source.catalog.packageId &&
        (!source.catalog.packageVersion ||
          entry.manifest.packageVersion === source.catalog.packageVersion),
    );
    if (!match) {
      throw new AppError('not_found', {
        code: 'solution_not_found',
        messageKey: 'solution.not_found',
      });
    }
    return match;
  }

  async analyze(
    tenantId: string,
    projectId: string,
    source: PackageSource,
  ): Promise<PackageAnalysis> {
    return (await this.prepare(tenantId, projectId, this.resolveSource(source))).analysis;
  }

  // --- analysis ------------------------------------------------------------------

  private async prepare(tenantId: string, projectId: string, raw: unknown): Promise<Prepared> {
    const validation = validatePackage(raw);
    const issues: PackageIssue[] = [...validation.issues];
    const empty = {
      definitionsNew: 0,
      definitionsReused: 0,
      definitionsConflicting: 0,
      widgetTemplates: 0,
      dashboardTemplates: 0,
    };

    if (!validation.package) {
      return {
        analysis: {
          manifest: null,
          installable: false,
          issues,
          compatibility: 'unsupported',
          mappings: [],
          conflicts: [],
          preview: empty,
        },
        pkg: null,
        siteId: null,
        visible: new Map(),
        templateRows: new Map(),
        definitionConflicts: new Map(),
      };
    }

    const pkg = validation.package;
    const issue = (
      stage: PackageIssue['stage'],
      severity: PackageIssue['severity'],
      messageKey: string,
      messageParams?: Record<string, string | number>,
    ) => issues.push({ stage, severity, messageKey, ...(messageParams ? { messageParams } : {}) });

    // --- compatibility ---
    const { min, max } = pkg.manifest.productCompatibility;
    if (
      compareVersions(PRODUCT_VERSION, min) < 0 ||
      (max && compareVersions(PRODUCT_VERSION, max) > 0)
    ) {
      issue('compatibility', 'error', 'solution.product_version', {
        version: PRODUCT_VERSION,
        range: max ? `${min} – ${max}` : `≥ ${min}`,
      });
    }

    const sites = await this.deps.matomo.listProjectSites(projectId);
    const site = sites[0] ?? null;
    if (!site) {
      issue('compatibility', 'error', 'solution.no_site');
    } else if (pkg.manifest.requiredCapabilities.length > 0) {
      const [snapshot] = await this.deps.db
        .select({ probes: matomoCapabilitySnapshots.probes })
        .from(matomoCapabilitySnapshots)
        .where(eq(matomoCapabilitySnapshots.connectionId, site.connectionId))
        .orderBy(desc(matomoCapabilitySnapshots.detectedAt))
        .limit(1);
      if (!snapshot) {
        issue('compatibility', 'warning', 'solution.capabilities_unknown');
      } else {
        const probes = snapshot.probes as { capability: string; state: string }[];
        for (const capability of pkg.manifest.requiredCapabilities) {
          const probe = probes.find((entry) => entry.capability === capability);
          if (probe?.state !== 'available') {
            issue('compatibility', 'error', 'solution.capability_missing', { capability });
          }
        }
      }
    }

    // --- dependencies ---
    const installed = await this.currentInstallations(projectId);
    for (const dependency of pkg.manifest.dependencies) {
      const present = installed.find((entry) => entry.packageId === dependency.packageId);
      if (!present || compareVersions(present.packageVersion, dependency.minVersion) < 0) {
        issue('dependencies', 'error', 'solution.dependency_missing', {
          packageId: dependency.packageId,
          version: dependency.minVersion,
        });
      }
    }

    // --- mapping ---
    const bindings = new Map(
      (await this.deps.semantics.listSourceBindings(projectId)).map((binding) => [
        binding.requirementKey,
        binding.binding,
      ]),
    );
    let candidates: MappingCandidate[] = [];
    if (site) {
      try {
        const metadata = await this.deps.matomo.describeSiteMetadata(tenantId, site.id);
        candidates = metadata.metrics.map((metric) => ({ sourceMetric: metric, label: metric }));
      } catch {
        issue('mapping', 'warning', 'solution.candidates_unavailable');
      }
    }
    const mappings: RequirementMapping[] = pkg.requirements.map((requirement) => {
      const existing = bindings.get(requirement.key);
      return {
        requirement,
        ...(existing ? { existing: describeExisting(existing) } : {}),
        candidates,
      };
    });

    // --- conflicts ---
    const visible = await this.visibleDefinitions(tenantId, projectId);
    const conflicts: PackageConflict[] = [];
    const definitionConflicts = new Map<string, PackageConflict>();
    let reused = 0;
    let fresh = 0;

    const portableOfVersion = await this.portableIdsOfVersions(
      [...visible.values()].flatMap((entry) =>
        entry.ref.currentVersionId ? [entry.ref.currentVersionId] : [],
      ),
    );
    const currentBodies = new Map(
      (
        await this.deps.semantics.resolveVersions(
          [...visible.values()].flatMap((entry) =>
            entry.ref.currentVersionId ? [entry.ref.currentVersionId] : [],
          ),
        )
      ).map((version) => [version.id, version.body]),
    );

    for (const definition of pkg.definitions) {
      const existing = visible.get(definition.portableId);
      if (!existing) {
        fresh += 1;
        continue;
      }
      const base = {
        objectType: 'semantic_definition' as const,
        portableId: definition.portableId,
      };
      if (existing.ref.type !== definition.type) {
        const conflict = { ...base, kind: 'foreign' as const, name: existing.ref.name };
        conflicts.push(conflict);
        definitionConflicts.set(definition.portableId, conflict);
        issue('conflicts', 'error', 'solution.conflict_foreign', { id: definition.portableId });
        continue;
      }
      const currentBody = existing.ref.currentVersionId
        ? currentBodies.get(existing.ref.currentVersionId)
        : undefined;
      const portable = currentBody ? toPortableBody(currentBody, portableOfVersion) : null;
      if (portable && canonicalJson(portable) === canonicalJson(definition.body)) {
        reused += 1;
        continue;
      }
      const conflict = { ...base, kind: 'changed' as const, name: existing.ref.name };
      conflicts.push(conflict);
      definitionConflicts.set(definition.portableId, conflict);
    }

    const templateRows = await this.projectTemplates(projectId);
    const templateSpecs: [TemplateKind, WidgetTemplateSpec | DashboardTemplateSpec][] = [
      ...pkg.widgetTemplates.map((spec) => ['widget', spec] as [TemplateKind, WidgetTemplateSpec]),
      ...pkg.dashboardTemplates.map(
        (spec) => ['dashboard', spec] as [TemplateKind, DashboardTemplateSpec],
      ),
    ];
    for (const [kind, spec] of templateSpecs) {
      const row = templateRows.get(`${kind}:${spec.portableId}`);
      if (row && canonicalJson(row.body) !== canonicalJson(spec)) {
        conflicts.push({
          objectType: kind === 'widget' ? 'widget_template' : 'dashboard_template',
          portableId: spec.portableId,
          kind: 'changed',
          name: row.name,
        });
      }
    }

    // --- references the package expects the project to have ---
    for (const reference of validation.externalReferences) {
      if (!visible.get(reference)?.ref.currentVersionId) {
        issue('dependencies', 'error', 'solution.unknown_reference', { id: reference });
      }
    }

    const current = installed.find((entry) => entry.packageId === pkg.manifest.packageId);
    if (current && compareVersions(current.packageVersion, pkg.manifest.packageVersion) > 0) {
      issue('dependencies', 'warning', 'solution.downgrade', {
        installed: current.packageVersion,
      });
    }

    const errors = issues.filter((entry) => entry.severity === 'error');
    const warnings = issues.filter(
      (entry) => entry.severity === 'warning' && entry.stage === 'compatibility',
    );
    const compatibilityErrors = errors.filter((entry) => entry.stage === 'compatibility');

    return {
      analysis: {
        manifest: pkg.manifest,
        installable: errors.length === 0,
        issues,
        compatibility:
          compatibilityErrors.length > 0
            ? 'unsupported'
            : warnings.length > 0
              ? 'supported_with_limitations'
              : 'supported',
        mappings,
        conflicts,
        preview: {
          definitionsNew: fresh,
          definitionsReused: reused,
          definitionsConflicting: definitionConflicts.size,
          widgetTemplates: pkg.widgetTemplates.length,
          dashboardTemplates: pkg.dashboardTemplates.length,
        },
        ...(current ? { installedVersion: current.packageVersion } : {}),
      },
      pkg,
      siteId: site?.id ?? null,
      visible,
      templateRows,
      definitionConflicts,
    };
  }

  // --- install ---------------------------------------------------------------------

  async install(input: {
    tenantId: string;
    projectId: string;
    source: PackageSource;
    request: SolutionInstallRequest;
    actorUserId: string;
  }): Promise<SolutionInstallResult> {
    const prepared = await this.prepare(
      input.tenantId,
      input.projectId,
      this.resolveSource(input.source),
    );
    const { analysis, pkg, visible, templateRows, definitionConflicts } = prepared;
    const refuse = (code: string, params?: Record<string, string | number>) => {
      throw new AppError('validation_failed', {
        code,
        messageKey: `solution.${code}`,
        ...(params ? { messageParams: params } : {}),
      });
    };

    if (!pkg || !analysis.installable) return refuse('not_installable');
    if (
      analysis.issues.some((entry) => entry.severity === 'warning') &&
      !input.request.acceptWarnings
    ) {
      return refuse('warnings_not_accepted');
    }

    const unresolved = analysis.conflicts.filter(
      (conflict) => conflict.kind === 'changed' && !input.request.resolutions[conflict.portableId],
    );
    if (unresolved.length > 0) return refuse('conflicts_unresolved', { count: unresolved.length });

    // Every requirement is decided before anything is written.
    const newBindings: [string, SourceBindingDescriptor][] = [];
    for (const mapping of analysis.mappings) {
      if (mapping.existing) continue;
      const choice = input.request.mappings[mapping.requirement.key];
      if (!choice) return refuse('mapping_incomplete', { key: mapping.requirement.label });
      if (
        choice !== 'not_available' &&
        !mapping.candidates.some((candidate) => candidate.sourceMetric === choice)
      ) {
        return refuse('mapping_not_offered', { key: mapping.requirement.label });
      }
      newBindings.push([
        mapping.requirement.key,
        choice === 'not_available'
          ? { kind: 'not_available' }
          : { kind: 'native_metric', sourceMetric: choice },
      ]);
    }

    const undo: (() => Promise<unknown>)[] = [];
    const objectMap: Record<string, string> = {};
    let created = 0;
    let reusedCount = 0;
    let versionsAdded = 0;
    let templateCount = 0;

    try {
      for (const [requirementKey, binding] of newBindings) {
        await this.deps.semantics.setSourceBinding({
          tenantId: input.tenantId,
          projectId: input.projectId,
          siteId: null,
          requirementKey,
          binding,
          actorUserId: input.actorUserId,
        });
      }

      // portable id -> the version id references to it resolve to
      const versionOf = new Map<string, string>();
      for (const [portableId, entry] of visible) {
        if (entry.ref.currentVersionId) versionOf.set(portableId, entry.ref.currentVersionId);
      }

      for (const definition of installOrder(pkg.definitions)) {
        const existing = visible.get(definition.portableId);
        const conflict = definitionConflicts.get(definition.portableId);

        if (existing && !conflict) {
          reusedCount += 1;
          objectMap[`definition:${definition.portableId}`] = existing.ref.id;
          continue;
        }
        const resolution: ConflictResolution | undefined = conflict
          ? input.request.resolutions[definition.portableId]
          : undefined;
        if (existing && resolution === 'keep_existing') {
          objectMap[`definition:${definition.portableId}`] = existing.ref.id;
          continue;
        }

        const body = toLocalBody(definition.body, versionOf);
        if (existing && existing.projectScoped) {
          const previous = existing.ref.currentVersionId;
          const version = await this.deps.semantics.addVersion({
            tenantId: input.tenantId,
            definitionId: existing.ref.id,
            body,
            actorUserId: input.actorUserId,
          });
          await this.activate(input, existing.ref.id, version.id);
          undo.push(() => this.revertVersion(input, existing.ref.id, version.id, previous));
          versionOf.set(definition.portableId, version.id);
          objectMap[`definition:${definition.portableId}`] = existing.ref.id;
          versionsAdded += 1;
          continue;
        }

        // New - or a project-level refinement of a tenant or global definition,
        // which shadows it in this project without touching it anywhere else.
        const result = await this.deps.semantics.createDefinition({
          tenantId: input.tenantId,
          projectId: input.projectId,
          portableId: definition.portableId,
          type: definition.type,
          name: definition.name,
          ...(definition.description ? { description: definition.description } : {}),
          body,
          actorUserId: input.actorUserId,
        });
        undo.push(() =>
          this.deps.db
            .delete(semanticDefinitions)
            .where(eq(semanticDefinitions.id, result.definition.id)),
        );
        await this.activate(input, result.definition.id, result.version.id);
        versionOf.set(definition.portableId, result.version.id);
        objectMap[`definition:${definition.portableId}`] = result.definition.id;
        created += 1;
      }

      const installationId = newId();
      const now = this.deps.clock.now();
      await this.deps.db.insert(solutionInstallations).values({
        id: installationId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        packageId: pkg.manifest.packageId,
        packageVersion: pkg.manifest.packageVersion,
        name: pkg.manifest.name,
        publisher: pkg.manifest.publisher,
        content: pkg as unknown as Record<string, unknown>,
        objectMap: {},
        current: 1,
        installedByUserId: input.actorUserId,
        installedAt: now,
      });
      undo.push(() =>
        this.deps.db
          .delete(solutionInstallations)
          .where(eq(solutionInstallations.id, installationId)),
      );

      const specs: [TemplateKind, WidgetTemplateSpec | DashboardTemplateSpec][] = [
        ...pkg.widgetTemplates.map(
          (spec) => ['widget', spec] as [TemplateKind, WidgetTemplateSpec],
        ),
        ...pkg.dashboardTemplates.map(
          (spec) => ['dashboard', spec] as [TemplateKind, DashboardTemplateSpec],
        ),
      ];
      for (const [kind, spec] of specs) {
        const row = templateRows.get(`${kind}:${spec.portableId}`);
        const body = spec as unknown as Record<string, unknown>;
        if (row) {
          objectMap[`${kind}_template:${spec.portableId}`] = row.id;
          const changed = canonicalJson(row.body) !== canonicalJson(spec);
          if (!changed || input.request.resolutions[spec.portableId] === 'keep_existing') continue;
          await this.deps.db
            .update(templates)
            .set({
              body,
              name: spec.name,
              description: spec.description ?? null,
              version: row.version + 1,
              installationId,
            })
            .where(eq(templates.id, row.id));
          undo.push(() =>
            this.deps.db
              .update(templates)
              .set({ body: row.body, version: row.version, installationId: row.installationId })
              .where(eq(templates.id, row.id)),
          );
          templateCount += 1;
          continue;
        }
        const templateId = newId();
        await this.deps.db.insert(templates).values({
          id: templateId,
          kind,
          layer: 'solution',
          tenantId: input.tenantId,
          projectId: input.projectId,
          portableId: spec.portableId,
          name: spec.name,
          description: spec.description ?? null,
          body,
          installationId,
        });
        undo.push(() => this.deps.db.delete(templates).where(eq(templates.id, templateId)));
        objectMap[`${kind}_template:${spec.portableId}`] = templateId;
        templateCount += 1;
      }

      await this.deps.db
        .update(solutionInstallations)
        .set({ objectMap })
        .where(eq(solutionInstallations.id, installationId));
      // The installation just written is the current one for this package.
      await this.deps.db
        .update(solutionInstallations)
        .set({ current: 0 })
        .where(
          and(
            eq(solutionInstallations.projectId, input.projectId),
            eq(solutionInstallations.packageId, pkg.manifest.packageId),
            ne(solutionInstallations.id, installationId),
          ),
        );

      if (pkg.contextProfile) await this.adoptContextProfile(input, pkg.contextProfile);

      await this.deps.audit.success('solution.installed', {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        targetType: 'solution_installation',
        targetId: installationId,
        metadata: {
          packageId: pkg.manifest.packageId,
          packageVersion: pkg.manifest.packageVersion,
          created,
          reused: reusedCount,
          versionsAdded,
        },
      });

      await this.deps.projects.refreshSetupState(input.tenantId, input.projectId);

      return {
        installationId,
        packageId: pkg.manifest.packageId,
        packageVersion: pkg.manifest.packageVersion,
        definitionsCreated: created,
        definitionsReused: reusedCount,
        versionsAdded,
        templates: templateCount,
      };
    } catch (error) {
      // Leave nothing half-installed: undo in reverse order, best effort.
      for (const step of undo.reverse()) {
        await step().catch(() => undefined);
      }
      throw error;
    }
  }

  private async activate(
    input: { tenantId: string; actorUserId: string },
    definitionId: string,
    versionId: string,
  ) {
    await this.deps.semantics.changeVersionStatus({
      tenantId: input.tenantId,
      definitionId,
      versionId,
      to: 'active',
      actorUserId: input.actorUserId,
    });
  }

  private async revertVersion(
    input: { tenantId: string; actorUserId: string },
    definitionId: string,
    versionId: string,
    previous: string | null,
  ) {
    if (previous) await this.activate(input, definitionId, previous);
    await this.deps.db.delete(semanticVersions).where(eq(semanticVersions.id, versionId));
  }

  /** Fills empty profile fields from the package's context template; never overwrites. */
  private async adoptContextProfile(
    input: { tenantId: string; projectId: string; actorUserId: string },
    template: NonNullable<SolutionPackage['contextProfile']>,
  ) {
    const project = await this.deps.projects.getProject(input.tenantId, input.projectId);
    const merged = { ...template, ...stripEmpty(project.contextProfile) };
    if (canonicalJson(merged) === canonicalJson(stripEmpty(project.contextProfile))) return;
    await this.deps.projects.updateContextProfile({
      tenantId: input.tenantId,
      projectId: input.projectId,
      profile: merged,
      actorUserId: input.actorUserId,
    });
  }

  // --- listings ----------------------------------------------------------------------

  async listInstallations(projectId: string): Promise<SolutionInstallationSummary[]> {
    const rows = await this.deps.db
      .select({
        id: solutionInstallations.id,
        packageId: solutionInstallations.packageId,
        packageVersion: solutionInstallations.packageVersion,
        name: solutionInstallations.name,
        publisher: solutionInstallations.publisher,
        installedAt: solutionInstallations.installedAt,
        current: solutionInstallations.current,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(solutionInstallations)
      .leftJoin(users, eq(users.id, solutionInstallations.installedByUserId))
      .where(eq(solutionInstallations.projectId, projectId))
      // The current installation first, then history, newest first.
      .orderBy(desc(solutionInstallations.current), desc(solutionInstallations.installedAt));

    return rows.map((row) => ({
      id: row.id,
      packageId: row.packageId,
      packageVersion: row.packageVersion,
      name: row.name,
      publisher: row.publisher,
      installedAt: row.installedAt.toISOString(),
      installedBy: row.firstName ? `${row.firstName} ${row.lastName ?? ''}`.trim() : null,
      current: row.current === 1,
    }));
  }

  async listTemplates(
    tenantId: string,
    projectId: string,
    kind?: TemplateKind,
  ): Promise<TemplateSummary[]> {
    const rows = await this.deps.db
      .select()
      .from(templates)
      .where(
        and(
          kind ? eq(templates.kind, kind) : undefined,
          or(
            and(isNull(templates.tenantId), isNull(templates.projectId)),
            and(eq(templates.tenantId, tenantId), isNull(templates.projectId)),
            eq(templates.projectId, projectId),
          ),
        ),
      );

    const installationIds = [
      ...new Set(rows.flatMap((row) => (row.installationId ? [row.installationId] : []))),
    ];
    const installs = installationIds.length
      ? await this.deps.db
          .select()
          .from(solutionInstallations)
          .where(inArray(solutionInstallations.id, installationIds))
      : [];
    const readiness = await this.readinessChecker(tenantId, projectId);

    return rows
      .map((row) => {
        const spec = row.body as unknown as WidgetTemplateSpec | DashboardTemplateSpec;
        const metrics =
          row.kind === 'dashboard'
            ? (spec as DashboardTemplateSpec).widgets.flatMap((widget) => widget.metrics)
            : (spec as WidgetTemplateSpec).metrics;
        const status = readiness(metrics);
        const install = installs.find((entry) => entry.id === row.installationId);
        return {
          id: row.id,
          kind: row.kind,
          layer: row.layer,
          portableId: row.portableId,
          name: row.name,
          description: row.description,
          version: row.version,
          ...(install
            ? {
                solution: {
                  packageId: install.packageId,
                  name: install.name,
                  version: install.packageVersion,
                },
              }
            : {}),
          readiness: status.readiness,
          missing: status.missing,
          ...(row.kind === 'dashboard'
            ? { widgetCount: (spec as DashboardTemplateSpec).widgets.length }
            : { family: (spec as WidgetTemplateSpec).family }),
        } satisfies TemplateSummary;
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /**
   * Whether a template's metrics can be shown in this project: the
   * definitions exist and are active, and every requirement underneath them
   * is mapped (Ready / Setup Required / Not Fully Supported).
   */
  private async readinessChecker(tenantId: string, projectId: string) {
    const visible = await this.visibleDefinitions(tenantId, projectId);
    const bindings = new Map(
      (await this.deps.semantics.listSourceBindings(projectId)).map((binding) => [
        binding.requirementKey,
        binding.binding,
      ]),
    );

    // The requirements each active version depends on, transitively.
    const requirementsOf = new Map<string, Set<string>>();
    const versions = await this.closure(
      [...visible.values()].flatMap((entry) =>
        entry.ref.currentVersionId ? [entry.ref.currentVersionId] : [],
      ),
    );
    const collect = (versionId: string, seen = new Set<string>()): Set<string> => {
      const cached = requirementsOf.get(versionId);
      if (cached) return cached;
      const version = versions.get(versionId);
      const result = new Set<string>();
      if (!version || seen.has(versionId)) return result;
      seen.add(versionId);
      if (version.body.kind === 'custom') result.add(version.body.requirementKey);
      for (const dependency of version.dependencyVersionIds) {
        collect(dependency, seen).forEach((key) => result.add(key));
      }
      requirementsOf.set(versionId, result);
      return result;
    };

    return (metrics: readonly string[]): { readiness: TemplateReadiness; missing: string[] } => {
      const missing: string[] = [];
      let unsupported = false;
      for (const portableId of new Set(metrics)) {
        const entry = visible.get(portableId);
        if (!entry?.ref.currentVersionId) {
          missing.push(entry?.ref.name ?? portableId);
          continue;
        }
        for (const requirement of collect(entry.ref.currentVersionId)) {
          const binding = bindings.get(requirement);
          if (!binding) missing.push(requirement);
          else if (binding.kind === 'not_available') unsupported = true;
        }
      }
      const unique = [...new Set(missing)];
      return {
        readiness:
          unique.length > 0 ? 'setup_required' : unsupported ? 'not_fully_supported' : 'ready',
        missing: unique,
      };
    };
  }

  /**
   * A template, resolved into widgets for this project.
   *
   * Copy-on-insert: what comes back is plain widget configuration pinned to
   * today's active versions, with no link to the template it came from.
   */
  async resolveTemplate(
    tenantId: string,
    projectId: string,
    templateId: string,
  ): Promise<{
    template: typeof templates.$inferSelect;
    widgets: WidgetConfig[];
    spec: WidgetTemplateSpec | DashboardTemplateSpec;
  }> {
    const [row] = await this.deps.db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.id, templateId),
          or(
            and(isNull(templates.tenantId), isNull(templates.projectId)),
            and(eq(templates.tenantId, tenantId), isNull(templates.projectId)),
            eq(templates.projectId, projectId),
          ),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError('not_found', {
        code: 'template_not_found',
        messageKey: 'template.not_found',
      });
    }

    const visible = await this.visibleDefinitions(tenantId, projectId);
    const pin = (portableIds: readonly string[]) =>
      portableIds.map((portableId) => {
        const versionId = visible.get(portableId)?.ref.currentVersionId;
        if (!versionId) {
          throw new AppError('invalid_configuration', {
            code: 'template_definition_missing',
            messageKey: 'template.definition_missing',
            messageParams: { id: portableId },
          });
        }
        return versionId;
      });

    const spec = row.body as unknown as WidgetTemplateSpec | DashboardTemplateSpec;
    const widgetFrom = (
      id: string,
      title: string,
      source: WidgetTemplateSpec | DashboardTemplateSpec['widgets'][number],
      placement: { x: number; y: number; w: number; h: number },
    ): WidgetConfig => ({
      id,
      family: source.family,
      title,
      placement: { desktop: placement },
      data: {
        semanticVersionIds: pin(source.metrics),
        ...(source.dimension ? { dimension: source.dimension } : {}),
        ...(source.topN ? { topN: source.topN } : {}),
        fixedFilters: [],
      },
      presentation: {
        showComparison: source.showComparison,
        ...(source.variant ? { variant: source.variant } : {}),
        ...(source.showSparkline !== undefined ? { showSparkline: source.showSparkline } : {}),
      },
      context: {
        showDefinition: source.family !== 'context_text',
        ...(source.text ? { description: source.text } : {}),
      },
    });

    const widgets =
      row.kind === 'dashboard'
        ? (spec as DashboardTemplateSpec).widgets.map((widget) =>
            widgetFrom(widget.id, widget.title, widget, widget.placement),
          )
        : [
            widgetFrom('template', (spec as WidgetTemplateSpec).name, spec as WidgetTemplateSpec, {
              x: 0,
              y: 0,
              w: 3,
              h: 3,
            }),
          ];

    return { template: row, widgets, spec };
  }

  /** "Dashboard aus Vorlage": a new dashboard whose draft is a copy of the template. */
  async createDashboardFromTemplate(input: {
    tenantId: string;
    projectId: string;
    templateId: string;
    name?: string;
    actorUserId: string;
  }): Promise<{ dashboardId: string }> {
    const { template, widgets, spec } = await this.resolveTemplate(
      input.tenantId,
      input.projectId,
      input.templateId,
    );
    if (template.kind !== 'dashboard') {
      throw new AppError('validation_failed', {
        code: 'not_a_dashboard_template',
        messageKey: 'template.not_a_dashboard_template',
      });
    }
    const dashboardSpec = spec as DashboardTemplateSpec;

    const [site] = await this.deps.matomo.listProjectSites(input.projectId);
    if (!site) {
      throw new AppError('setup_required', {
        code: 'template_no_site',
        messageKey: 'template.no_site',
      });
    }

    const name = input.name?.trim() || template.name;
    const draft = await this.deps.dashboards.createDashboard({
      tenantId: input.tenantId,
      projectId: input.projectId,
      siteId: site.id,
      name,
      ...(template.description ? { description: template.description } : {}),
      actorUserId: input.actorUserId,
    });

    const snapshot: DashboardSnapshot = {
      ...draft.snapshot,
      name,
      ...(template.description ? { description: template.description } : {}),
      // A preset resolves at view time; the dates are placeholders, as for
      // every new dashboard.
      defaultTimeRange: {
        preset: dashboardSpec.defaultTimeRange,
        from: '1970-01-01',
        to: '1970-01-01',
      },
      defaultComparison: { mode: dashboardSpec.defaultComparison },
      widgets,
    };

    await this.deps.dashboards.saveDraft({
      tenantId: input.tenantId,
      dashboardId: draft.dashboardId,
      expectedRevisionId: draft.revisionId,
      snapshot,
      actorUserId: input.actorUserId,
    });

    return { dashboardId: draft.dashboardId };
  }

  // --- export -------------------------------------------------------------------------

  /**
   * Packages dashboards and every definition they rest on (Master Spec §14:
   * "package export for authorized authors").
   *
   * Built from the published versions, so what is exported is what viewers
   * see. The result is run through the same validation an upload gets: an
   * export this product cannot re-import is a bug, not a file.
   */
  async exportPackage(input: {
    tenantId: string;
    projectId: string;
    dashboardIds: readonly string[];
    packageId: string;
    packageVersion: string;
    name: string;
    publisher: string;
    actorUserId: string;
  }): Promise<SolutionPackage> {
    const published = await Promise.all(
      input.dashboardIds.map(async (dashboardId) => {
        const state = await this.deps.dashboards.getPublished(input.tenantId, dashboardId);
        if (!state) {
          throw new AppError('validation_failed', {
            code: 'export_unpublished',
            messageKey: 'solution.export_unpublished',
          });
        }
        return state;
      }),
    );

    const pinned = [
      ...new Set(
        published.flatMap((state) =>
          state.snapshot.widgets.flatMap((w) => w.data.semanticVersionIds),
        ),
      ),
    ];
    const versions = await this.closure(pinned);
    const portableOf = await this.portableIdsOfVersions([...versions.keys()]);
    const definitionRows = await this.definitionsOfVersions([...versions.keys()]);

    const definitions: PortableDefinition[] = [];
    const requirements = new Map<string, { key: string; label: string; description?: string }>();
    for (const [versionId, version] of versions) {
      const row = definitionRows.get(versionId)!;
      const body = toPortableBody(version.body, portableOf);
      if (!body) continue;
      if (definitions.some((entry) => entry.portableId === row.portableId)) continue;
      definitions.push({
        portableId: row.portableId,
        type: row.type,
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        body,
      });
      if (body.kind === 'custom') {
        requirements.set(body.requirementKey, {
          key: body.requirementKey,
          label: row.name,
          ...(row.description ? { description: row.description } : {}),
        });
      }
    }

    const dashboardTemplates = published.map((state, index) => ({
      portableId: `${input.packageId.split('.').slice(-1)[0]}.dashboard.${index + 1}`,
      name: state.snapshot.name,
      ...(state.snapshot.description ? { description: state.snapshot.description } : {}),
      defaultTimeRange:
        state.snapshot.defaultTimeRange.preset === 'custom'
          ? ('last_30_days' as const)
          : state.snapshot.defaultTimeRange.preset,
      defaultComparison:
        state.snapshot.defaultComparison.mode === 'custom'
          ? ('previous_period' as const)
          : state.snapshot.defaultComparison.mode,
      widgets: state.snapshot.widgets.map((widget) => ({
        id:
          widget.id
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/^-+/, '') || 'widget',
        title: widget.title,
        placement: widget.placement.desktop,
        family: widget.family,
        ...(widget.presentation.variant ? { variant: widget.presentation.variant } : {}),
        metrics: widget.data.semanticVersionIds.flatMap((id) => {
          const portableId = portableOf.get(id);
          return portableId ? [portableId] : [];
        }),
        ...(widget.data.dimension ? { dimension: widget.data.dimension } : {}),
        ...(widget.data.topN ? { topN: widget.data.topN } : {}),
        showComparison: widget.presentation.showComparison,
        ...(widget.context.description ? { text: widget.context.description } : {}),
      })),
    }));

    const pkg = {
      manifest: {
        packageId: input.packageId,
        packageVersion: input.packageVersion,
        packageSchemaVersion: '1',
        name: input.name,
        publisher: input.publisher,
        createdAt: this.deps.clock
          .now()
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z'),
        productCompatibility: { min: PRODUCT_VERSION },
        dependencies: [],
        requiredCapabilities: [],
        includedObjects: [
          ...[...requirements.keys()].map((portableId) => ({ type: 'requirement', portableId })),
          ...definitions.map((entry) => ({
            type: 'semantic_definition',
            portableId: entry.portableId,
          })),
          ...dashboardTemplates.map((entry) => ({
            type: 'dashboard_template',
            portableId: entry.portableId,
          })),
        ],
        origin: { kind: 'export' },
      },
      requirements: [...requirements.values()],
      definitions,
      widgetTemplates: [],
      dashboardTemplates,
    };

    const check = validatePackage(pkg);
    if (!check.package) {
      throw new AppError('internal_error', {
        code: 'export_invalid',
        messageKey: 'solution.export_invalid',
        internalMessage: `Export failed its own validation: ${check.issues
          .map((entry) => `${entry.messageKey} ${entry.path ?? ''}`)
          .join('; ')}`,
      });
    }

    await this.deps.audit.success('solution.exported', {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      targetType: 'solution_package',
      targetId: input.packageId,
      metadata: {
        packageVersion: input.packageVersion,
        dashboards: input.dashboardIds.length,
        definitions: definitions.length,
      },
    });

    return check.package;
  }

  // --- helpers --------------------------------------------------------------------------

  private async currentInstallations(projectId: string) {
    return this.deps.db
      .select({
        id: solutionInstallations.id,
        packageId: solutionInstallations.packageId,
        packageVersion: solutionInstallations.packageVersion,
      })
      .from(solutionInstallations)
      .where(
        and(eq(solutionInstallations.projectId, projectId), eq(solutionInstallations.current, 1)),
      );
  }

  /** Definitions visible in the project by portable id, narrowest scope winning. */
  private async visibleDefinitions(
    tenantId: string,
    projectId: string,
  ): Promise<Map<string, Visible>> {
    const refs = await this.deps.semantics.listForProject(tenantId, projectId);
    const projectScoped = new Set(
      (
        await this.deps.db
          .select({ id: semanticDefinitions.id })
          .from(semanticDefinitions)
          .where(eq(semanticDefinitions.projectId, projectId))
      ).map((row) => row.id),
    );
    return new Map(
      refs.map((ref) => [ref.portableId, { ref, projectScoped: projectScoped.has(ref.id) }]),
    );
  }

  private async projectTemplates(projectId: string) {
    const rows = await this.deps.db
      .select()
      .from(templates)
      .where(eq(templates.projectId, projectId));
    return new Map(rows.map((row) => [`${row.kind}:${row.portableId}`, row]));
  }

  /** Versions and everything they depend on, transitively. */
  private async closure(versionIds: readonly string[]) {
    const seen = new Map<string, Awaited<ReturnType<SemanticService['resolveVersions']>>[number]>();
    let queue = [...new Set(versionIds)];
    while (queue.length > 0) {
      const batch = queue.filter((id) => !seen.has(id));
      if (batch.length === 0) break;
      const resolved = await this.deps.semantics.resolveVersions(batch);
      resolved.forEach((version) => seen.set(version.id, version));
      queue = resolved.flatMap((version) => version.dependencyVersionIds);
    }
    return seen;
  }

  private async portableIdsOfVersions(versionIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.definitionsOfVersions(versionIds);
    return new Map([...rows].map(([versionId, row]) => [versionId, row.portableId]));
  }

  private async definitionsOfVersions(versionIds: readonly string[]) {
    if (versionIds.length === 0) return new Map<string, typeof semanticDefinitions.$inferSelect>();
    const rows = await this.deps.db
      .select({ versionId: semanticVersions.id, definition: semanticDefinitions })
      .from(semanticVersions)
      .innerJoin(semanticDefinitions, eq(semanticDefinitions.id, semanticVersions.definitionId))
      .where(inArray(semanticVersions.id, [...new Set(versionIds)]));
    return new Map(rows.map((row) => [row.versionId, row.definition]));
  }
}

function describeExisting(
  binding: SourceBindingDescriptor,
): NonNullable<RequirementMapping['existing']> {
  switch (binding.kind) {
    case 'native_metric':
      return { sourceMetric: binding.sourceMetric };
    case 'not_available':
      return { notAvailable: true };
    default:
      return { other: binding.kind };
  }
}

function stripEmpty(profile: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(profile).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  );
}
