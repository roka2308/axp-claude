import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  type FormulaNode,
  type SemanticDefinitionBody,
  type SemanticVersionRef,
  type ValueEnvelope,
} from '@axp/contracts';
import { type Container, evaluateFormula, evaluateScore, type TraceEntry } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireProjectScope, requireProjectSite } from '../lib/project-scope';

/**
 * Semantic catalog (Master Spec §13, D6).
 *
 * Two capabilities, deliberately apart: `semantic.read` to see what a number
 * means, `semantic.manage` to change it. Seeing a definition is not being able
 * to redefine it, and neither implies access to the data itself.
 */

const projectParams = z.object({ projectId: z.string().min(1) });
const definitionParams = z.object({ definitionId: z.string().min(1) });

/** The formula AST, as a schema. Recursive, and closed: no other node exists. */
const formulaNodeSchema: z.ZodType<FormulaNode> = z.lazy(() =>
  z.union([
    z.strictObject({ type: z.literal('constant'), value: z.number().finite() }),
    z.strictObject({ type: z.literal('reference'), semanticVersionId: z.string().min(1) }),
    z.strictObject({
      type: z.literal('binary'),
      op: z.enum(['+', '-', '*', '/']),
      left: formulaNodeSchema,
      right: formulaNodeSchema,
    }),
    z.strictObject({
      type: z.literal('function'),
      name: z.enum(['MIN', 'MAX', 'AVG', 'ROUND', 'COALESCE']),
      // A bound the builder cannot exceed either: a formula nobody can read is
      // not a formula anybody should be able to store.
      args: z.array(formulaNodeSchema).min(1).max(8),
    }),
  ]),
);

const unitSchema = z.enum(['count', 'percent', 'ratio', 'seconds', 'currency', 'score']);
const scopeSchema = z.enum(['visit', 'action', 'event', 'site']);
const directionSchema = z.enum(['higher_is_better', 'lower_is_better', 'neutral']);

const normalisationSchema = z.union([
  z.strictObject({
    kind: z.literal('linear'),
    worst: z.number().finite(),
    best: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal('bands'),
    bands: z
      .array(z.strictObject({ atLeast: z.number().finite(), points: z.number().min(0).max(100) }))
      .min(1)
      .max(10),
  }),
]);

/*
 * Every object here is strict.
 *
 * Unknown keys are refused rather than stripped. A formula is stored as
 * structure and executed by walking it, so a stray field would be dropped
 * either way - but a schema whose job is to be closed should say so, instead
 * of accepting a payload and silently keeping a different one (Gate F3).
 */
const bodySchema = z.union([
  z.strictObject({
    kind: z.literal('custom'),
    requirementKey: z.string().min(1).max(128),
    unit: unitSchema,
    scope: scopeSchema,
    direction: directionSchema,
    decimals: z.number().int().min(0).max(6),
  }),
  z.strictObject({
    kind: z.literal('formula'),
    ast: formulaNodeSchema,
    unit: unitSchema,
    scope: scopeSchema,
    direction: directionSchema,
    decimals: z.number().int().min(0).max(6),
  }),
  z.strictObject({
    kind: z.literal('score'),
    components: z
      .array(
        z.strictObject({
          semanticVersionId: z.string().min(1),
          weight: z.number().positive().max(1000),
          normalisation: normalisationSchema,
          label: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(12),
    evaluation: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(64),
          atLeast: z.number().min(0).max(100),
          band: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
        }),
      )
      .max(6),
    unit: z.literal('score'),
    scope: scopeSchema,
    direction: directionSchema,
    decimals: z.number().int().min(0).max(6),
  }),
]);

const bindingSchema = z.union([
  z.object({ kind: z.literal('native_metric'), sourceMetric: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal('event'),
    category: z.string().min(1).max(128),
    action: z.string().max(128).optional(),
  }),
  z.object({ kind: z.literal('custom_dimension'), index: z.number().int().min(1).max(50) }),
  z.object({ kind: z.literal('goal'), goalId: z.number().int().positive() }),
  z.object({ kind: z.literal('site_search') }),
  z.object({ kind: z.literal('not_available') }),
]);

export function registerSemanticRoutes(app: FastifyInstance, container: Container): void {
  app.get(
    '/projects/:projectId/semantic-definitions',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');

      const definitions = await container.semantics.listForProject(scope.tenantId, scope.projectId);
      return { definitions };
    },
  );

  app.post(
    '/projects/:projectId/semantic-definitions',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const input = z
        .object({
          portableId: z.string().min(1).max(128),
          type: z.enum(['custom_metric', 'formula', 'score']),
          name: z.string().min(1).max(200),
          description: z.string().max(1000).optional(),
          body: bodySchema,
        })
        .parse(request.body);

      const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');

      const created = await container.semantics.createDefinition({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        portableId: input.portableId,
        type: input.type,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        body: input.body as SemanticDefinitionBody,
        actorUserId: auth.userId,
      });

      void reply.status(201);
      return created;
    },
  );

  app.get(
    '/projects/:projectId/semantic-definitions/:definitionId/versions',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const { definitionId } = definitionParams.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');

      const versions = await container.semantics.listVersions(scope.tenantId, definitionId);
      return { versions };
    },
  );

  app.post(
    '/projects/:projectId/semantic-definitions/:definitionId/versions',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const { definitionId } = definitionParams.parse(request.params);
      const { body } = z.object({ body: bodySchema }).parse(request.body);

      const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');

      const version = await container.semantics.addVersion({
        tenantId: scope.tenantId,
        definitionId,
        body: body as SemanticDefinitionBody,
        actorUserId: auth.userId,
      });

      void reply.status(201);
      // Wrapped, like every other read on this resource. A route that
      // sometimes returns a bare object and sometimes a named one is a trap
      // for the next caller.
      return { version };
    },
  );

  /**
   * Moves a version through its lifecycle.
   *
   * Activation is where validation bites: a formula that cannot be evaluated
   * must not become what a definition currently means.
   */
  app.post(
    '/projects/:projectId/semantic-definitions/:definitionId/versions/:versionId/status',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const { definitionId, versionId } = z
        .object({ definitionId: z.string().min(1), versionId: z.string().min(1) })
        .parse(request.params);
      const { to } = z
        .object({ to: z.enum(['draft', 'active', 'deprecated', 'archived']) })
        .parse(request.body);

      const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');

      return container.semantics.changeVersionStatus({
        tenantId: scope.tenantId,
        definitionId,
        versionId,
        to,
        actorUserId: auth.userId,
      });
    },
  );

  /**
   * Evaluates a candidate definition without storing it (D6).
   *
   * The builder needs to answer "what would this produce?" before anyone
   * commits to it. Nothing is written: the inputs are fetched through the
   * normal analytics path and the candidate is evaluated over them here.
   */
  app.post(
    '/projects/:projectId/semantic-definitions/preview',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const input = z
        .object({
          body: bodySchema,
          siteId: z.string().min(1),
          timeRange: z.string().default('last_30_days'),
        })
        .parse(request.body);

      const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');
      const site = await requireProjectSite(container, scope, input.siteId);

      const body = input.body as SemanticDefinitionBody;
      const inputIds = dependencyIdsOf(body);
      if (inputIds.length === 0) {
        throw new AppError('validation_failed', {
          code: 'preview_without_inputs',
          messageKey: 'semantic.preview.no_inputs',
          internalMessage: 'A preview needs at least one referenced version.',
        });
      }

      const versions = await container.semantics.resolveVersions(inputIds);
      const result = await container.analytics.execute({
        kind: 'scalar',
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        siteId: site.id,
        semanticVersionIds: inputIds,
        timeRangePreset: input.timeRange as never,
        comparisonMode: 'none',
        permissionContextId: scope.permissionContextId,
      });

      const values = new Map<string, ValueEnvelope>(
        result.kind === 'scalar'
          ? result.metrics.map((metric) => [metric.semanticVersionId, metric.value])
          : [],
      );
      const described = await container.semantics.describeVersions(inputIds);
      const names = new Map([...described].map(([id, entry]) => [id, entry.name]));

      const evaluated = evaluate(body, values, names);

      return {
        value: evaluated.value,
        trace: evaluated.trace,
        inputs: versions.map((version: SemanticVersionRef) => ({
          semanticVersionId: version.id,
          name: names.get(version.id) ?? version.id,
          value: values.get(version.id) ?? null,
        })),
      };
    },
  );

  // --- source bindings -----------------------------------------------------

  app.get(
    '/projects/:projectId/source-bindings',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');

      const bindings = await container.semantics.listSourceBindings(scope.projectId);
      return { bindings };
    },
  );

  /**
   * Records or corrects a mapping.
   *
   * Deliberately not a semantic version: pointing a requirement at the right
   * custom dimension is a technical fix, and the business definition did not
   * change because somebody fixed a wiring mistake (Gate F3).
   */
  app.put(
    '/projects/:projectId/source-bindings',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const input = z
        .object({
          requirementKey: z.string().min(1).max(128),
          siteId: z.string().min(1).nullable().default(null),
          binding: bindingSchema,
        })
        .parse(request.body);

      const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');
      if (input.siteId) await requireProjectSite(container, scope, input.siteId);

      return container.semantics.setSourceBinding({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        siteId: input.siteId,
        requirementKey: input.requirementKey,
        binding: input.binding,
        actorUserId: auth.userId,
      });
    },
  );

  /** What the site currently offers versus what the bindings point at. */
  app.get(
    '/projects/:projectId/source-bindings/health',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const { siteId } = z.object({ siteId: z.string().optional() }).parse(request.query);

      const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');

      const sites = await container.matomo.listProjectSites(scope.projectId);
      const target = siteId ? sites.find((site) => site.id === siteId) : sites[0];
      if (!target) return { health: [], available: { metrics: [], dimensions: [] } };

      const available = await container.matomo.describeSiteMetadata(scope.tenantId, target.id);
      const health = await container.semantics.checkBindingDrift(scope.projectId, available);

      return { health, available };
    },
  );

  /**
   * Records that somebody looked at a drifting mapping and accepted it.
   *
   * A write to the mapping's review state only. No semantic version is
   * created, because acknowledging a technical fact is not a change to what a
   * number means (Gate F3).
   */
  app.post(
    '/projects/:projectId/source-bindings/:requirementKey/review',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId, requirementKey } = z
        .object({ projectId: z.string().uuid(), requirementKey: z.string().min(1).max(128) })
        .parse(request.params);
      const { siteId } = z.object({ siteId: z.string().optional() }).parse(request.body ?? {});

      const scope = await requireProjectScope(container, auth, projectId, 'semantic.manage');

      const sites = await container.matomo.listProjectSites(scope.projectId);
      const target = siteId ? sites.find((site) => site.id === siteId) : sites[0];
      const available = target
        ? await container.matomo.describeSiteMetadata(scope.tenantId, target.id)
        : { metrics: [], dimensions: [] };

      const health = await container.semantics.reviewSourceBinding({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        requirementKey,
        available,
        actorUserId: auth.userId,
      });

      return { health };
    },
  );

  /** Where each definition is used, which is the question before every change. */
  app.get(
    '/projects/:projectId/semantic-definitions/usage',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = projectParams.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'semantic.read');

      const usage = await container.semantics.describeUsage(scope.projectId);
      return { usage };
    },
  );
}

function dependencyIdsOf(body: SemanticDefinitionBody): string[] {
  if (body.kind === 'score') {
    return [...new Set(body.components.map((component) => component.semanticVersionId))];
  }
  if (body.kind !== 'formula') return [];

  const found = new Set<string>();
  const visit = (node: FormulaNode): void => {
    if (node.type === 'reference') found.add(node.semanticVersionId);
    else if (node.type === 'binary') {
      visit(node.left);
      visit(node.right);
    } else if (node.type === 'function') node.args.forEach(visit);
  };
  visit(body.ast);
  return [...found];
}

function evaluate(
  body: SemanticDefinitionBody,
  values: ReadonlyMap<string, ValueEnvelope>,
  names: ReadonlyMap<string, string>,
): { value: ValueEnvelope; trace: readonly TraceEntry[] } {
  if (body.kind === 'score') {
    const evaluated = evaluateScore(body, { values, names });
    return { value: evaluated.value, trace: evaluated.trace };
  }
  if (body.kind === 'formula') {
    return evaluateFormula(body.ast, { values, names });
  }

  throw new AppError('validation_failed', {
    code: 'preview_not_supported',
    messageKey: 'semantic.preview.not_supported',
    internalMessage: `Preview is not defined for definitions of kind "${body.kind}".`,
  });
}
