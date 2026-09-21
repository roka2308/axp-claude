import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import {
  AppError,
  CORE_NATIVE_METRICS,
  type FormulaDefinition,
  type ScoreDefinition,
  type SemanticVersionRef,
} from '@axp/contracts';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

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
  let pageviewsVersionId: string;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();

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

    await ctx.container.semantics.ensureCoreNativeMetrics();
    visitsVersionId = (await activeVersionOf(CORE_NATIVE_METRICS.visits)).id;
    pageviewsVersionId = (await activeVersionOf(CORE_NATIVE_METRICS.pageviews)).id;
  });

  afterAll(async () => {
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
      expect(version.dependencyVersionIds.sort()).toEqual(
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

      expect(version!.dependencyVersionIds.sort()).toEqual(
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
