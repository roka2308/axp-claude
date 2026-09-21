import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import {
  AppError,
  CORE_NATIVE_METRICS,
  type FormulaDefinition,
  type ScoreDefinition,
  type SemanticVersionRef,
} from '@axp/contracts';
import { seedReferenceDashboard } from '@axp/fixtures';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';
import { buildServer } from '../../apps/api/src/server';

/**
 * Semantic catalog (Master Spec §13, Gate F3).
 *
 * The properties that only exist against a real database: that an immutable
 * version really is immutable, that activating a new one leaves published
 * dashboards alone, that a cycle cannot be stored, and that correcting a
 * mapping does not quietly become a new business version.
 */
describe('semantic catalog', () => {
  let ctx: TestContext;
  let tenantId: string;
  let projectId: string;
  let actorUserId: string;

  let visitsVersionId: string;
  let visitsDefinitionId: string;
  let pageviewsVersionId: string;

  let app: FastifyInstance;
  let manager: string;
  let reader: string;
  let viewerToken: string;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();

    tenantId = (
      await ctx.container.tenants.createTenant({
        portableId: 'demo.tenant',
        name: 'Tenant',
        slug: 'tenant',
      })
    ).tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');

    projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: 'demo.project',
        name: 'Portal',
        slug: 'portal',
      })
    ).projectId;

    actorUserId = (
      await ctx.container.users.createLocalUser({
        email: 'semantik@example.invalid',
        firstName: 'Sina',
        lastName: 'Semantik',
        password: STRONG_TEST_PASSWORD,
        status: 'active',
      })
    ).userId;

    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: actorUserId,
      role: 'semantic_catalog_manager',
      scopeType: 'project',
      scopeId: projectId,
    });
    manager = await signIn('semantik@example.invalid');

    /*
     * A dashboard editor, not a viewer: `semantic.read` belongs to the
     * authoring roles. A viewer sees the definition behind a number on a
     * dashboard they may already read; browsing the catalog is a different
     * question with a different answer (Master Spec §7).
     */
    const readerId = (
      await ctx.container.users.createLocalUser({
        email: 'leser@example.invalid',
        firstName: 'Lena',
        lastName: 'Leser',
        password: STRONG_TEST_PASSWORD,
        status: 'active',
      })
    ).userId;
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: readerId,
      role: 'dashboard_editor',
      scopeType: 'project',
      scopeId: projectId,
    });
    reader = await signIn('leser@example.invalid');

    const viewerId = (
      await ctx.container.users.createLocalUser({
        email: 'betrachter@example.invalid',
        firstName: 'Bea',
        lastName: 'Betrachter',
        password: STRONG_TEST_PASSWORD,
        status: 'active',
      })
    ).userId;
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: viewerId,
      role: 'viewer',
      scopeType: 'project',
      scopeId: projectId,
    });
    viewerToken = await signIn('betrachter@example.invalid');

    await ctx.container.semantics.ensureCoreNativeMetrics();
    const visits = await ctx.container.semantics.getActiveVersionByPortableId(
      CORE_NATIVE_METRICS.visits,
    );
    visitsVersionId = (await activeVersionOf(CORE_NATIVE_METRICS.visits)).id;
    visitsDefinitionId = visits!.definition.id;
    pageviewsVersionId = (await activeVersionOf(CORE_NATIVE_METRICS.pageviews)).id;
  });

  async function signIn(email: string): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: STRONG_TEST_PASSWORD },
    });
    expect(response.statusCode, email).toBe(200);
    return response.json().token as string;
  }

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  async function activeVersionOf(portableId: string): Promise<SemanticVersionRef> {
    const found = await ctx.container.semantics.getActiveVersionByPortableId(portableId);
    if (!found) throw new Error(`No active version for ${portableId}`);
    return found.version;
  }

  /** Pages per visit: the smallest formula that is actually useful. */
  function pagesPerVisit(): FormulaDefinition {
    return {
      kind: 'formula',
      ast: {
        type: 'binary',
        op: '/',
        left: { type: 'reference', semanticVersionId: pageviewsVersionId },
        right: { type: 'reference', semanticVersionId: visitsVersionId },
      },
      unit: 'ratio',
      scope: 'visit',
      direction: 'higher_is_better',
      decimals: 2,
    };
  }

  const createFormula = (body = pagesPerVisit(), portableId = 'demo.pages-per-visit') =>
    ctx.container.semantics.createDefinition({
      tenantId,
      projectId,
      portableId,
      type: 'formula',
      name: 'Seiten pro Besuch',
      body,
      actorUserId,
    });

  // --- versions are immutable ----------------------------------------------

  describe('immutable versions', () => {
    it('starts a new definition as a draft, not as something dashboards can use', async () => {
      const { definition, version } = await createFormula();

      expect(version).toMatchObject({ version: 1, status: 'draft' });
      // Nothing points at it yet: a draft is not the definition's current
      // meaning until somebody says so.
      expect(definition.currentVersionId).toBeNull();
    });

    it('adds a version rather than editing the one that exists', async () => {
      const { definition, version } = await createFormula();
      await ctx.container.semantics.changeVersionStatus({
        tenantId,
        definitionId: definition.id,
        versionId: version.id,
        to: 'active',
        actorUserId,
      });

      const second = await ctx.container.semantics.addVersion({
        tenantId,
        definitionId: definition.id,
        body: { ...pagesPerVisit(), decimals: 3 },
        actorUserId,
      });

      expect(second.version).toBe(2);

      const versions = await ctx.container.semantics.listVersions(tenantId, definition.id);
      expect(versions.map((entry) => entry.version)).toEqual([2, 1]);

      // Version 1 still says what it said.
      const [first] = await ctx.container.semantics.resolveVersions([version.id]);
      expect((first!.body as FormulaDefinition).decimals).toBe(2);
    });

    it('deprecates the previous active version instead of deleting it', async () => {
      const { definition, version } = await createFormula();
      await activate(definition.id, version.id);

      const second = await ctx.container.semantics.addVersion({
        tenantId,
        definitionId: definition.id,
        body: { ...pagesPerVisit(), decimals: 3 },
        actorUserId,
      });
      await activate(definition.id, second.id);

      const versions = await ctx.container.semantics.listVersions(tenantId, definition.id);
      expect(versions.find((entry) => entry.version === 1)).toMatchObject({
        status: 'deprecated',
      });
      expect(versions.find((entry) => entry.version === 2)).toMatchObject({ status: 'active' });
    });

    it('records who activated what', async () => {
      const { definition, version } = await createFormula();
      await activate(definition.id, version.id);

      const [events] = await ctx.handle.pool.query<RowDataPacket[]>(
        "SELECT action, target_id FROM audit_events WHERE action = 'semantic.version_activated'",
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.target_id).toBe(version.id);
    });
  });

  // --- Gate F3: pinning ----------------------------------------------------

  describe('published dashboards pin a version', () => {
    it('keeps showing the pinned version after a newer one is activated', async () => {
      const { definition, version } = await createFormula();
      await activate(definition.id, version.id);

      // A dashboard pins version 1 of the formula.
      const pinned = version.id;

      const second = await ctx.container.semantics.addVersion({
        tenantId,
        definitionId: definition.id,
        body: { ...pagesPerVisit(), decimals: 0 },
        actorUserId,
      });
      await activate(definition.id, second.id);

      // The definition's current meaning moved on...
      const current = await ctx.container.semantics.getActiveVersionByPortableId(
        'demo.pages-per-visit',
        { tenantId, projectId },
      );
      expect(current?.version.id).toBe(second.id);

      // ...and the pinned one did not (Master Spec §13).
      const [resolved] = await ctx.container.semantics.resolveVersions([pinned]);
      expect(resolved!.id).toBe(pinned);
      expect((resolved!.body as FormulaDefinition).decimals).toBe(2);
      expect(resolved!.status).toBe('deprecated');
    });

    it('still resolves a deprecated version, because something pinned it', async () => {
      // Deprecating is not deleting. A published dashboard that pinned it must
      // keep rendering rather than breaking on the next view.
      const { definition, version } = await createFormula();
      await activate(definition.id, version.id);
      await ctx.container.semantics.changeVersionStatus({
        tenantId,
        definitionId: definition.id,
        versionId: version.id,
        to: 'deprecated',
        actorUserId,
      });

      const [resolved] = await ctx.container.semantics.resolveVersions([version.id]);
      expect(resolved).toBeTruthy();
    });

    it('refuses a pinned id that does not exist rather than rendering a gap', async () => {
      await expect(
        ctx.container.semantics.resolveVersions(['01a00000-0000-7000-8000-000000000000']),
      ).rejects.toThrow(AppError);
    });
  });

  // --- Gate F3: cycles -----------------------------------------------------

  describe('cycles cannot be stored', () => {
    it('refuses a formula that would depend on itself', async () => {
      const { definition, version } = await createFormula();
      await activate(definition.id, version.id);

      // A second version of the same definition referencing version 1 of
      // itself: legal as a tree, a cycle in the graph.
      await expect(
        ctx.container.semantics.addVersion({
          tenantId,
          definitionId: definition.id,
          body: {
            ...pagesPerVisit(),
            ast: {
              type: 'binary',
              op: '+',
              left: { type: 'reference', semanticVersionId: version.id },
              right: { type: 'constant', value: 1 },
            },
          },
          actorUserId,
        }),
      ).rejects.toMatchObject({ code: 'formula_invalid' });
    });

    it('refuses a formula referencing a version that does not exist', async () => {
      await expect(
        createFormula(
          {
            ...pagesPerVisit(),
            ast: {
              type: 'reference',
              semanticVersionId: '01a00000-0000-7000-8000-000000000000',
            },
          },
          'demo.dangling',
        ),
      ).rejects.toThrow(AppError);
    });

    it('stores the dependency graph so the next check can use it', async () => {
      const { version } = await createFormula();
      expect([...version.dependencyVersionIds].sort()).toEqual(
        [pageviewsVersionId, visitsVersionId].sort(),
      );
    });
  });

  // --- Gate F3: formulas are not code --------------------------------------

  describe('formulas are trees, not code', () => {
    it('refuses a formula whose units cannot combine', async () => {
      await expect(
        createFormula(
          {
            ...pagesPerVisit(),
            ast: {
              type: 'binary',
              op: '*',
              left: { type: 'reference', semanticVersionId: visitsVersionId },
              right: { type: 'reference', semanticVersionId: pageviewsVersionId },
            },
          },
          'demo.nonsense',
        ),
      ).rejects.toMatchObject({ code: 'formula_invalid' });
    });

    it('stores the AST as structure, with nothing to interpret', async () => {
      const { version } = await createFormula();

      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(
        'SELECT body FROM semantic_versions WHERE id = ?',
        [version.id],
      );
      const body = JSON.parse(JSON.stringify(rows[0]!.body)) as FormulaDefinition;

      // A tree of typed nodes. No expression string exists to be evaluated,
      // which is why there is nothing to sandbox (Gate F3).
      expect(body.ast).toMatchObject({ type: 'binary', op: '/' });
      expect(JSON.stringify(body)).not.toMatch(/eval|function\s*\(|=>/);
    });
  });

  // --- Gate F3: scores -----------------------------------------------------

  describe('scores', () => {
    async function createScore(): Promise<{ definitionId: string; versionId: string }> {
      const score: ScoreDefinition = {
        kind: 'score',
        unit: 'score',
        scope: 'visit',
        direction: 'higher_is_better',
        decimals: 1,
        components: [
          {
            semanticVersionId: visitsVersionId,
            weight: 60,
            normalisation: { kind: 'linear', worst: 0, best: 1000 },
          },
          {
            semanticVersionId: pageviewsVersionId,
            weight: 40,
            normalisation: { kind: 'linear', worst: 0, best: 3000 },
          },
        ],
        evaluation: [
          { key: 'weak', atLeast: 0, band: 1 },
          { key: 'good', atLeast: 60, band: 4 },
        ],
      };

      const { definition, version } = await ctx.container.semantics.createDefinition({
        tenantId,
        projectId,
        portableId: 'demo.portal-score',
        type: 'score',
        name: 'Portal Score',
        body: score,
        actorUserId,
      });

      return { definitionId: definition.id, versionId: version.id };
    }

    it('stores its components as dependencies', async () => {
      const { versionId } = await createScore();
      const [version] = await ctx.container.semantics.resolveVersions([versionId]);

      expect([...version!.dependencyVersionIds].sort()).toEqual(
        [pageviewsVersionId, visitsVersionId].sort(),
      );
    });

    it('refuses a score whose weights cannot express a share', async () => {
      await expect(
        ctx.container.semantics.createDefinition({
          tenantId,
          projectId,
          portableId: 'demo.broken-score',
          type: 'score',
          name: 'Kaputt',
          body: {
            kind: 'score',
            unit: 'score',
            scope: 'visit',
            direction: 'higher_is_better',
            decimals: 0,
            components: [],
            evaluation: [],
          },
          actorUserId,
        }),
      ).rejects.toMatchObject({ code: 'score_invalid' });
    });

    it('refuses a score pointing at a component that does not exist', async () => {
      await expect(
        ctx.container.semantics.createDefinition({
          tenantId,
          projectId,
          portableId: 'demo.dangling-score',
          type: 'score',
          name: 'Ins Leere',
          body: {
            kind: 'score',
            unit: 'score',
            scope: 'visit',
            direction: 'higher_is_better',
            decimals: 0,
            components: [
              {
                semanticVersionId: '01a00000-0000-7000-8000-000000000000',
                weight: 1,
                normalisation: { kind: 'linear', worst: 0, best: 1 },
              },
            ],
            evaluation: [],
          },
          actorUserId,
        }),
      ).rejects.toThrow(AppError);
    });
  });

  // --- Gate F3: mapping is not a business version --------------------------

  describe('source bindings', () => {
    it('records a mapping without creating a semantic version', async () => {
      const { definition, version } = await createFormula();
      await activate(definition.id, version.id);

      const before = await ctx.container.semantics.listVersions(tenantId, definition.id);

      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.engaged_users',
        binding: { kind: 'custom_dimension', index: 3 },
        actorUserId,
      });

      // The business definition did not change because somebody pointed it at
      // the right custom dimension (Gate F3).
      const after = await ctx.container.semantics.listVersions(tenantId, definition.id);
      expect(after.map((entry) => entry.version)).toEqual(before.map((entry) => entry.version));
      expect(after.map((entry) => entry.status)).toEqual(before.map((entry) => entry.status));
    });

    it('corrects a mapping in place rather than accumulating rows', async () => {
      const first = await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.engaged_users',
        binding: { kind: 'custom_dimension', index: 3 },
        actorUserId,
      });

      const corrected = await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.engaged_users',
        binding: { kind: 'custom_dimension', index: 5 },
        actorUserId,
      });

      expect(corrected.id).toBe(first.id);

      const bindings = await ctx.container.semantics.listSourceBindings(projectId);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.binding).toEqual({ kind: 'custom_dimension', index: 5 });
    });

    it('audits the correction, because it changes what a number means', async () => {
      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.engaged_users',
        binding: { kind: 'event', category: 'portal', action: 'like' },
        actorUserId,
      });

      const [events] = await ctx.handle.pool.query<RowDataPacket[]>(
        "SELECT action FROM audit_events WHERE action = 'source_binding.changed'",
      );
      expect(events).toHaveLength(1);
    });

    it('reports drift instead of silently remapping', async () => {
      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.engaged_users',
        binding: { kind: 'custom_dimension', index: 3 },
        actorUserId,
      });

      const healthy = await ctx.container.semantics.checkBindingDrift(projectId, {
        metrics: ['visits'],
        dimensions: ['dimension3'],
      });
      expect(healthy[0]).toMatchObject({ state: 'ok' });

      // The dimension disappeared. It may have been renamed, retired or
      // broken, and only a person can say which (Master Spec §13).
      const drifted = await ctx.container.semantics.checkBindingDrift(projectId, {
        metrics: ['visits'],
        dimensions: ['dimension1', 'dimension2'],
      });
      expect(drifted[0]).toMatchObject({ state: 'review_required' });
      expect(drifted[0]!.detailKey).toBeTruthy();
      expect(drifted[0]!.availableSample).toEqual(['dimension1', 'dimension2']);
    });

    it('remembers that somebody reviewed the drift, without touching a version', async () => {
      const { definition } = await ctx.container.semantics.createDefinition({
        tenantId,
        projectId,
        portableId: 'demo.reviewed',
        type: 'custom_metric',
        name: 'Engagement',
        body: {
          kind: 'custom',
          requirementKey: 'pulse.engaged_users',
          unit: 'count',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 0,
        },
        actorUserId,
      });
      const before = await ctx.container.semantics.listVersions(tenantId, definition.id);

      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.engaged_users',
        binding: { kind: 'custom_dimension', index: 3 },
        actorUserId,
      });

      const gone = { metrics: ['visits'], dimensions: ['dimension1'] };
      expect((await ctx.container.semantics.checkBindingDrift(projectId, gone))[0]).toMatchObject({
        state: 'review_required',
      });

      await ctx.container.semantics.reviewSourceBinding({
        tenantId,
        projectId,
        requirementKey: 'pulse.engaged_users',
        available: gone,
        actorUserId,
      });

      // Reviewed: somebody looked at exactly this situation and accepted it.
      // The mapping is not repaired - `unresolved` still says the number
      // cannot be produced here.
      const reviewed = await ctx.container.semantics.checkBindingDrift(projectId, gone);
      expect(reviewed[0]).toMatchObject({ state: 'unresolved' });
      expect(reviewed[0]!.review).toMatchObject({ current: true, reviewedBy: 'Sina Semantik' });

      // And the business definition is untouched (Gate F3).
      expect(await ctx.container.semantics.listVersions(tenantId, definition.id)).toEqual(before);
    });

    it('lets a review go stale when the site changes underneath it', async () => {
      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.engaged_users',
        binding: { kind: 'custom_dimension', index: 3 },
        actorUserId,
      });

      await ctx.container.semantics.reviewSourceBinding({
        tenantId,
        projectId,
        requirementKey: 'pulse.engaged_users',
        available: { metrics: [], dimensions: ['dimension1'] },
        actorUserId,
      });

      // dimension3 came back. The review was an answer to its absence, so it
      // no longer applies and the warning returns rather than staying signed
      // off.
      const health = await ctx.container.semantics.checkBindingDrift(projectId, {
        metrics: [],
        dimensions: ['dimension1', 'dimension3'],
      });
      expect(health[0]).toMatchObject({ state: 'ok' });
      expect(health[0]!.review).toMatchObject({ current: false });
    });

    it('drops the review when the mapping is pointed somewhere else', async () => {
      const bind = (index: number) =>
        ctx.container.semantics.setSourceBinding({
          tenantId,
          projectId,
          siteId: null,
          requirementKey: 'pulse.engaged_users',
          binding: { kind: 'custom_dimension', index },
          actorUserId,
        });

      await bind(3);
      await ctx.container.semantics.reviewSourceBinding({
        tenantId,
        projectId,
        requirementKey: 'pulse.engaged_users',
        available: { metrics: [], dimensions: [] },
        actorUserId,
      });

      // Repointing answers the question the review was about, so carrying the
      // old sign-off forward would be a lie about what was looked at.
      await bind(4);
      const health = await ctx.container.semantics.checkBindingDrift(projectId, {
        metrics: [],
        dimensions: [],
      });
      expect(health[0]!.review).toBeUndefined();
      expect(health[0]).toMatchObject({ state: 'review_required' });
    });

    it('treats a recorded "not available" as a decision, not as drift', async () => {
      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.downloads',
        binding: { kind: 'not_available' },
        actorUserId,
      });

      const health = await ctx.container.semantics.checkBindingDrift(projectId, {
        metrics: [],
        dimensions: [],
      });
      // `unresolved`, not `review_required`: the review already happened.
      expect(health[0]).toMatchObject({ state: 'unresolved' });
    });
  });

  // --- Gate F3: a custom metric needs a mapping to produce a number --------

  describe('custom metrics resolve through their source mapping', () => {
    let siteId: string;

    beforeEach(async () => {
      siteId = (await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId }))
        .siteId;
    });

    /** A custom metric whose requirement is whatever the caller says. */
    async function customMetric(portableId: string, requirementKey: string) {
      const created = await ctx.container.semantics.createDefinition({
        tenantId,
        projectId,
        portableId,
        type: 'custom_metric',
        name: portableId,
        body: {
          kind: 'custom',
          requirementKey,
          unit: 'count',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 0,
        },
        actorUserId,
      });
      await activate(created.definition.id, created.version.id);
      return created.version.id;
    }

    function read(versionId: string) {
      return ctx.container.analytics.execute({
        kind: 'scalar',
        tenantId,
        projectId,
        siteId,
        semanticVersionIds: [versionId],
        timeRangePreset: 'last_30_days',
        comparisonMode: 'none',
        permissionContextId: 'test',
      });
    }

    it('reports an unmapped requirement as missing, naming what it needs', async () => {
      const versionId = await customMetric('demo.unmapped', 'pulse.engaged_users');

      // Not an error, and certainly not zero: one unmapped input must not take
      // the surrounding query down with it (Master Spec §13).
      const result = await read(versionId);
      expect(result.kind).toBe('scalar');
      const value = result.kind === 'scalar' ? result.metrics[0]!.value : null;
      expect(value).toEqual({
        state: 'missing',
        cause: { kind: 'no_mapping', requirement: 'pulse.engaged_users' },
      });
    });

    it('produces a number once the requirement is mapped to a native metric', async () => {
      const versionId = await customMetric('demo.mapped', 'pulse.sessions');

      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.sessions',
        binding: { kind: 'native_metric', sourceMetric: 'visits' },
        actorUserId,
      });

      const result = await read(versionId);
      const value = result.kind === 'scalar' ? result.metrics[0]!.value : null;
      expect(value?.state === 'ready' || value?.state === 'zero').toBe(true);
    });

    it('reports a recorded "not available" as absent from this site', async () => {
      const versionId = await customMetric('demo.absent', 'pulse.downloads');

      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.downloads',
        binding: { kind: 'not_available' },
        actorUserId,
      });

      const result = await read(versionId);
      const value = result.kind === 'scalar' ? result.metrics[0]!.value : null;
      // A decision somebody made, not a gap nobody noticed.
      expect(value).toEqual({
        state: 'missing',
        cause: { kind: 'source_field_absent', requirement: 'pulse.downloads' },
      });
    });

    it('says so when a mapping is recorded but not yet fetchable', async () => {
      const versionId = await customMetric('demo.dimension', 'pulse.creators');

      await ctx.container.semantics.setSourceBinding({
        tenantId,
        projectId,
        siteId: null,
        requirementKey: 'pulse.creators',
        binding: { kind: 'custom_dimension', index: 3 },
        actorUserId,
      });

      const result = await read(versionId);
      const value = result.kind === 'scalar' ? result.metrics[0]!.value : null;
      // DEVIATIONS.md DEV-004: the mapping is legitimate and stored; the
      // connector call shape is not built yet, and the product says which.
      expect(value).toMatchObject({
        state: 'missing',
        cause: { kind: 'other', messageKey: 'analytics.binding_kind_not_executable' },
      });
    });

    it('does not hide a missing component by reweighting the score', async () => {
      const missing = await customMetric('demo.score-missing', 'pulse.nothing_here');

      const score: ScoreDefinition = {
        kind: 'score',
        unit: 'score',
        scope: 'visit',
        direction: 'higher_is_better',
        decimals: 1,
        components: [
          {
            semanticVersionId: visitsVersionId,
            weight: 50,
            label: 'Besuche',
            normalisation: { kind: 'linear', worst: 0, best: 1000 },
          },
          {
            semanticVersionId: missing,
            weight: 50,
            label: 'Nicht zugeordnet',
            normalisation: { kind: 'linear', worst: 0, best: 100 },
          },
        ],
        evaluation: [{ key: 'good', atLeast: 60, band: 4 }],
      };

      const created = await ctx.container.semantics.createDefinition({
        tenantId,
        projectId,
        portableId: 'demo.half-score',
        type: 'score',
        name: 'Halber Score',
        body: score,
        actorUserId,
      });
      await activate(created.definition.id, created.version.id);

      const result = await read(created.version.id);
      const value = result.kind === 'scalar' ? result.metrics[0]!.value : null;

      // Half the score was available. Renormalising to 100 % would have
      // produced a plausible number, which is exactly the failure mode the
      // rule exists to prevent (Gate F3).
      expect(value).toMatchObject({
        state: 'missing',
        cause: { kind: 'not_calculable' },
      });
      expect(
        value?.state === 'missing' && value.cause.kind === 'not_calculable'
          ? value.cause.missingInputs
          : [],
      ).toContain('Nicht zugeordnet');
    });
  });

  // --- Gate F3: usage ------------------------------------------------------

  describe('where a definition is used', () => {
    it('counts a published dashboard and names the version it pinned', async () => {
      const seeded = await seedReferenceDashboard(ctx.container, {
        tenantId,
        projectId,
        actorUserId,
      });
      expect(seeded.dashboardId).toBeTruthy();

      const usage = await ctx.container.semantics.describeUsage(projectId);
      const visits = usage.find((entry) => entry.definitionId === visitsDefinitionId);

      expect(visits).toMatchObject({ publishedDashboards: 1 });
      expect(visits!.pinnedVersions).toEqual([
        { versionId: visitsVersionId, version: 1, dashboards: 1 },
      ]);
    });

    it('keeps the published count on the old version when a newer one is activated', async () => {
      await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId });

      // The business changed its mind about what a visit means. The published
      // dashboard keeps the version it pinned until it is published again,
      // and the usage summary has to say so rather than quietly following the
      // new active version (Gate F3).
      const second = await ctx.container.semantics.addVersion({
        tenantId,
        definitionId: visitsDefinitionId,
        body: {
          kind: 'native',
          sourceMetric: 'visits',
          unit: 'count',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 1,
        },
        actorUserId,
      });
      await activate(visitsDefinitionId, second.id);

      const usage = await ctx.container.semantics.describeUsage(projectId);
      const visits = usage.find((entry) => entry.definitionId === visitsDefinitionId);

      expect(visits!.pinnedVersions).toEqual([
        { versionId: visitsVersionId, version: 1, dashboards: 1 },
      ]);
    });

    it('reports a definition nothing uses as unused, not as unknown', async () => {
      const { definition } = await createFormula();

      const usage = await ctx.container.semantics.describeUsage(projectId);
      expect(usage.find((entry) => entry.definitionId === definition.id)).toMatchObject({
        draftDashboards: 0,
        publishedDashboards: 0,
        pinnedVersions: [],
      });
    });
  });

  // --- the API surface -----------------------------------------------------

  describe('over the API', () => {
    const apiBody = () => ({
      kind: 'formula' as const,
      ast: {
        type: 'binary' as const,
        op: '/' as const,
        left: { type: 'reference' as const, semanticVersionId: pageviewsVersionId },
        right: { type: 'reference' as const, semanticVersionId: visitsVersionId },
      },
      unit: 'ratio' as const,
      scope: 'visit' as const,
      direction: 'higher_is_better' as const,
      decimals: 2,
    });

    const create = (token: string, portableId = 'demo.api-formula') =>
      app.inject({
        method: 'POST',
        url: `/projects/${projectId}/semantic-definitions`,
        headers: as(token),
        payload: { portableId, type: 'formula', name: 'Seiten pro Besuch', body: apiBody() },
      });

    const versionsOf = (definitionId: string, token: string) =>
      app.inject({
        method: 'GET',
        url: `/projects/${projectId}/semantic-definitions/${definitionId}/versions`,
        headers: as(token),
      });

    it('lets a catalog manager create and activate a definition', async () => {
      const created = await create(manager);
      expect(created.statusCode).toBe(201);

      const { definition, version } = created.json();
      const activated = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/semantic-definitions/${definition.id}/versions/${version.id}/status`,
        headers: as(manager),
        payload: { to: 'active' },
      });

      expect(activated.statusCode).toBe(200);
      expect(activated.json()).toMatchObject({ status: 'active' });
    });

    it('lets an editor read the catalog but not redefine it', async () => {
      // Seeing what a number means is not being able to change what it means.
      const listed = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/semantic-definitions`,
        headers: as(reader),
      });
      expect(listed.statusCode).toBe(200);

      expect((await create(reader, 'demo.reader-attempt')).statusCode).toBe(403);
    });

    it('keeps the catalog out of a plain viewer\u2019s reach', async () => {
      // The catalog is an authoring surface. A viewer still sees the
      // definition behind a number on a dashboard they may read.
      const listed = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/semantic-definitions`,
        headers: as(viewerToken),
      });
      expect(listed.statusCode).toBe(403);
    });

    it('refuses a formula that cannot combine, with a usable message', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/semantic-definitions`,
        headers: as(manager),
        payload: {
          portableId: 'demo.api-nonsense',
          type: 'formula',
          name: 'Unsinn',
          body: {
            ...apiBody(),
            ast: {
              type: 'binary',
              op: '*',
              left: { type: 'reference', semanticVersionId: visitsVersionId },
              right: { type: 'reference', semanticVersionId: pageviewsVersionId },
            },
          },
        },
      });

      expect(response.statusCode).toBe(422);
      // Visits are counted over visits and pageviews over actions, so the
      // scope rule bites before the unit rule does. Either way the message is
      // specific enough to act on.
      expect(response.json()).toMatchObject({
        error: { code: 'formula_invalid', messageKey: 'semantic.formula.scope_mismatch' },
      });
    });

    it('refuses a payload that is not a formula tree at all', async () => {
      // The schema is closed: no node type carries a string to be interpreted,
      // so an attempt to smuggle one in fails at the boundary (Gate F3).
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/semantic-definitions`,
        headers: as(manager),
        payload: {
          portableId: 'demo.api-injection',
          type: 'formula',
          name: 'Injektion',
          body: { ...apiBody(), ast: { type: 'expression', source: 'process.exit(1)' } },
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.category).toBe('validation_failed');
    });

    it('refuses a node carrying a field the schema does not know', async () => {
      // A valid reference with an extra key. Zod would strip it by default,
      // which stores something other than what was sent; a closed schema says
      // so instead (Gate F3).
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/semantic-definitions`,
        headers: as(manager),
        payload: {
          portableId: 'demo.api-extra-field',
          type: 'formula',
          name: 'Zusatzfeld',
          body: {
            ...apiBody(),
            ast: { type: 'reference', semanticVersionId: visitsVersionId, eval: '1+1' },
          },
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.category).toBe('validation_failed');
    });

    it('lists the version history', async () => {
      const { definition } = (await create(manager, 'demo.api-history')).json();

      const versions = await versionsOf(definition.id, reader);
      expect(versions.statusCode).toBe(200);
      expect(versions.json().versions).toHaveLength(1);
    });

    it('records a mapping without writing a semantic version', async () => {
      const { definition } = (await create(manager, 'demo.api-mapping')).json();
      const before = (await versionsOf(definition.id, manager)).json().versions;

      const bound = await app.inject({
        method: 'PUT',
        url: `/projects/${projectId}/source-bindings`,
        headers: as(manager),
        payload: {
          requirementKey: 'pulse.engaged_users',
          siteId: null,
          binding: { kind: 'custom_dimension', index: 4 },
        },
      });
      expect(bound.statusCode).toBe(200);

      const after = (await versionsOf(definition.id, manager)).json().versions;
      expect(after).toEqual(before);
    });

    it('lets a manager record a review, and refuses one from a reader', async () => {
      await app.inject({
        method: 'PUT',
        url: `/projects/${projectId}/source-bindings`,
        headers: as(manager),
        payload: {
          requirementKey: 'pulse.engaged_users',
          siteId: null,
          binding: { kind: 'custom_dimension', index: 9 },
        },
      });

      const denied = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/source-bindings/pulse.engaged_users/review`,
        headers: as(reader),
        payload: {},
      });
      expect(denied.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/source-bindings/pulse.engaged_users/review`,
        headers: as(manager),
        payload: {},
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().health).toMatchObject({ requirementKey: 'pulse.engaged_users' });
    });

    it('reports where a definition is used, published apart from draft', async () => {
      const usage = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/semantic-definitions/usage`,
        headers: as(reader),
      });

      expect(usage.statusCode).toBe(200);
      const visits = usage
        .json()
        .usage.find((entry: { definitionId: string }) => entry.definitionId);
      // Nothing is on a dashboard in this fixture, and that is a stated answer
      // rather than an absent one.
      expect(visits).toMatchObject({
        draftDashboards: 0,
        publishedDashboards: 0,
        pinnedVersions: [],
      });
    });

    it('refuses a mapping change from someone who may only read', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: `/projects/${projectId}/source-bindings`,
        headers: as(reader),
        payload: {
          requirementKey: 'pulse.engaged_users',
          siteId: null,
          binding: { kind: 'site_search' },
        },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  async function activate(definitionId: string, versionId: string) {
    return ctx.container.semantics.changeVersionStatus({
      tenantId,
      definitionId,
      versionId,
      to: 'active',
      actorUserId,
    });
  }
});
