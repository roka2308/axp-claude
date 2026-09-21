import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import type { DashboardSnapshot, WidgetConfig } from '@axp/contracts';
import { seedReferenceDashboard } from '@axp/fixtures';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * Dashboard authoring (Master Spec §21, D2/D3, Gate F2).
 *
 * The properties under test are the ones that only exist against a real
 * database: that two editors cannot both hold the draft, that a takeover is
 * deliberate and audited, that rollback appends rather than resurrects, and
 * that archiving never deletes anything.
 */
describe('dashboard authoring', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  let tenantId: string;
  let projectId: string;
  let dashboardId: string;
  let siteId: string;

  /** Two editors in the same project: the whole point of a lease. */
  let anna: string;
  let ben: string;
  let annaId: string;
  let viewer: string;

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

    const seeder = await user('seeder@example.invalid', 'dashboard_editor');
    const seeded = await seedReferenceDashboard(ctx.container, {
      tenantId,
      projectId,
      actorUserId: seeder.userId,
    });
    dashboardId = seeded.dashboardId;
    siteId = seeded.siteId;

    const annaAccount = await user('anna@example.invalid', 'dashboard_editor');
    annaId = annaAccount.userId;
    anna = await signIn('anna@example.invalid');
    ben = await signIn((await user('ben@example.invalid', 'dashboard_editor')).email);
    viewer = await signIn((await user('viewer@example.invalid', 'viewer')).email);
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- scenario helpers ----------------------------------------------------

  async function user(email: string, role: 'viewer' | 'dashboard_editor') {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: email.split('@')[0]!,
      lastName: 'Tester',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role,
      scopeType: 'project',
      scopeId: projectId,
    });
    return { userId, email };
  }

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

  const acquire = (token: string, force = false) =>
    app.inject({
      method: 'POST',
      url: `/dashboards/${dashboardId}/lease`,
      headers: as(token),
      payload: { force },
    });

  const draftOf = (token: string) =>
    app.inject({ method: 'GET', url: `/dashboards/${dashboardId}/draft`, headers: as(token) });

  async function save(token: string, mutate: (snapshot: DashboardSnapshot) => DashboardSnapshot) {
    const draft = (await draftOf(token)).json();
    return app.inject({
      method: 'PUT',
      url: `/dashboards/${dashboardId}/draft`,
      headers: as(token),
      payload: {
        expectedRevisionId: draft.revisionId,
        snapshot: mutate(draft.snapshot as DashboardSnapshot),
      },
    });
  }

  const rename = (name: string) => (snapshot: DashboardSnapshot) => ({ ...snapshot, name });

  // --- the lease -----------------------------------------------------------

  describe('one editor at a time', () => {
    it('grants a free draft and says the caller holds it', async () => {
      const response = await acquire(anna);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        acquired: true,
        lease: { heldByCaller: true, userId: annaId },
      });
      // A name, not an email address: the banner says who, not how to contact
      // them.
      expect(response.json().lease.userName).toMatch(/anna/i);
      expect(JSON.stringify(response.json())).not.toContain('@example.invalid');
    });

    it('tells the second editor who has it rather than failing', async () => {
      await acquire(anna);
      const response = await acquire(ben);

      // 200, not 409: "Anna is editing" is what the UI needs in order to offer
      // a takeover. A bare error would be a dead end (D10).
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        acquired: false,
        lease: { userId: annaId, heldByCaller: false },
      });
    });

    it('refuses a write while someone else is editing', async () => {
      await acquire(anna);
      const response = await save(ben, rename('Bens Fassung'));

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'draft_locked' } });
      // The refusal names the person, because "locked" alone is unactionable.
      expect(JSON.stringify(response.json())).toMatch(/anna/i);
    });

    it('claims a free draft implicitly on save', async () => {
      // Someone who is typing is evidently editing. Making them press a button
      // first would only teach them to press it without reading it.
      expect((await save(anna, rename('Ohne Klick'))).statusCode).toBe(200);
      expect((await draftOf(anna)).json().lease).toMatchObject({ heldByCaller: true });
    });

    it('renews rather than blocks the editor who already holds it', async () => {
      await acquire(anna);
      const again = await acquire(anna);
      expect(again.json()).toMatchObject({ acquired: true, lease: { heldByCaller: true } });
    });

    it('frees the draft when the holder releases it', async () => {
      await acquire(anna);
      const released = await app.inject({
        method: 'DELETE',
        url: `/dashboards/${dashboardId}/lease`,
        headers: as(anna),
      });
      expect(released.statusCode).toBe(204);

      expect((await acquire(ben)).json()).toMatchObject({ acquired: true });
    });

    it('ignores a release from someone who does not hold it', async () => {
      await acquire(anna);
      await app.inject({
        method: 'DELETE',
        url: `/dashboards/${dashboardId}/lease`,
        headers: as(ben),
      });

      // Anna still has it: releasing is not a way to evict somebody.
      expect((await draftOf(anna)).json().lease).toMatchObject({ heldByCaller: true });
    });

    it('releases the lease when the draft is published', async () => {
      await save(anna, rename('Fertig'));
      const published = await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/publish`,
        headers: as(anna),
      });
      expect(published.statusCode).toBe(200);

      // Publishing ends an editing session, so the next person is not waiting
      // for a lease on an empty desk.
      expect((await acquire(ben)).json()).toMatchObject({ acquired: true });
    });

    it('needs the edit capability before a lease is even considered', async () => {
      // The lease is not a permission. Whether a viewer may edit is answered
      // first, and the answer is no.
      expect((await acquire(viewer)).statusCode).toBe(403);
    });
  });

  describe('takeover', () => {
    it('ends the other session deliberately and records it', async () => {
      await acquire(anna);

      const taken = await acquire(ben, true);
      expect(taken.json()).toMatchObject({ acquired: true, lease: { heldByCaller: true } });

      // Anna finds out by being refused, not by silent overwriting.
      expect((await save(anna, rename('Zu spät'))).statusCode).toBe(409);

      const [events] = await ctx.handle.pool.query<RowDataPacket[]>(
        "SELECT action, metadata FROM audit_events WHERE action = 'dashboard.editor_takeover'",
      );
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]!.metadata)).toContain(annaId);
    });

    it('does not record a takeover when the draft was free anyway', async () => {
      // `force` states intent, not outcome. An audit trail that claimed a
      // takeover here would be describing something that did not happen.
      await acquire(ben, true);

      const [events] = await ctx.handle.pool.query<RowDataPacket[]>(
        "SELECT action FROM audit_events WHERE action = 'dashboard.editor_takeover'",
      );
      expect(events).toHaveLength(0);
    });
  });

  // --- version history -----------------------------------------------------

  describe('version history and rollback', () => {
    async function publishNamed(name: string) {
      await save(anna, rename(name));
      const response = await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/publish`,
        headers: as(anna),
      });
      expect(response.statusCode, name).toBe(200);
      return response.json().version as number;
    }

    it('lists what was published, newest first', async () => {
      await publishNamed('Zweite');

      const response = await app.inject({
        method: 'GET',
        url: `/dashboards/${dashboardId}/versions`,
        headers: as(viewer),
      });

      expect(response.statusCode).toBe(200);
      const versions = response.json().versions as { version: number; isCurrent: boolean }[];
      expect(versions.map((entry) => entry.version)).toEqual([2, 1]);
      expect(versions[0]!.isCurrent).toBe(true);
      expect(versions[1]!.isCurrent).toBe(false);
    });

    it('rolls back by appending a new version, never by resurrecting one', async () => {
      await publishNamed('Zweite Fassung');
      expect(await publishNamed('Dritte Fassung')).toBe(3);

      const rolled = await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/rollback`,
        headers: as(anna),
        payload: { version: 1 },
      });

      // Version 4, carrying version 1's content. History stays append-only, so
      // "we went back" remains visible as exactly that (Master Spec §21).
      expect(rolled.json()).toMatchObject({ version: 4 });

      const versions = (
        await app.inject({
          method: 'GET',
          url: `/dashboards/${dashboardId}/versions`,
          headers: as(viewer),
        })
      ).json().versions as { version: number; rolledBackFromVersion: number | null }[];

      expect(versions.map((entry) => entry.version)).toEqual([4, 3, 2, 1]);
      expect(versions[0]!.rolledBackFromVersion).toBe(1);

      const viewed = await app.inject({
        method: 'GET',
        url: `/dashboards/${dashboardId}/presentation`,
        headers: as(viewer),
      });
      expect(viewed.json().dashboard.publishedVersion).toBe(4);
      expect(viewed.json().dashboard.name).toBe('Portal Overview');
    });

    it('leaves the draft alone when rolling back', async () => {
      await publishNamed('Veröffentlicht');
      await save(anna, rename('Arbeit im Gange'));

      await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/rollback`,
        headers: as(anna),
        payload: { version: 1 },
      });

      // Someone's work in progress is not somebody else's to discard.
      expect((await draftOf(anna)).json().snapshot.name).toBe('Arbeit im Gange');
    });

    it('refuses a version that does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/rollback`,
        headers: as(anna),
        payload: { version: 99 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('refuses a rollback from a caller who may not publish', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/rollback`,
        headers: as(viewer),
        payload: { version: 1 },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('the listing shows what is published', () => {
    const listed = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/dashboards`,
        headers: as(viewer),
      });
      expect(response.statusCode).toBe(200);
      return (response.json().dashboards as { id: string; name: string }[]).find(
        (entry) => entry.id === dashboardId,
      )!;
    };

    it('keeps the published name while the draft carries another one', async () => {
      // Renaming a draft must not rename the thing everyone else is looking
      // at. The same rule as the presentation, applied to the listing
      // (Master Spec §21).
      const before = await listed();
      await save(anna, rename('Arbeitstitel'));

      const after = await listed();
      expect(after.name).toBe(before.name);
      expect(after).toMatchObject({ hasUnpublishedChanges: true });
    });

    it('shows the draft name before anything has been published', async () => {
      const created = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/dashboards`,
        headers: as(anna),
        payload: { name: 'Noch unveröffentlicht', siteId },
      });
      expect(created.statusCode).toBe(201);

      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/dashboards`,
        headers: as(viewer),
      });
      const entry = (response.json().dashboards as { id: string; name: string }[]).find(
        (candidate) => candidate.id === created.json().dashboardId,
      );

      // Nothing is published yet, so the draft name is all there is - and a
      // dashboard nobody can find is worse than one named provisionally.
      expect(entry?.name).toBe('Noch unveröffentlicht');
    });

    it('follows the new name once it is published', async () => {
      await save(anna, rename('Endgültig'));
      await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/publish`,
        headers: as(anna),
      });

      expect((await listed()).name).toBe('Endgültig');
    });
  });

  // --- archive and trash ---------------------------------------------------

  describe('archive and trash', () => {
    const setLifecycle = (to: string, token = anna) =>
      app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/lifecycle`,
        headers: as(token),
        payload: { to },
      });

    it('archives and restores without losing anything', async () => {
      expect((await setLifecycle('archived')).json()).toMatchObject({ lifecycle: 'archived' });

      const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(
        'SELECT lifecycle, archived_at FROM dashboards WHERE id = ?',
        [dashboardId],
      );
      expect(rows[0]!.lifecycle).toBe('archived');
      expect(rows[0]!.archived_at).not.toBeNull();

      // Restoring returns it to published, because a published version exists.
      expect((await setLifecycle('restore')).json()).toMatchObject({ lifecycle: 'published' });
    });

    it('trashes without deleting a single row', async () => {
      const countRows = async (table: string) => {
        const [rows] = await ctx.handle.pool.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM \`${table}\``,
        );
        return Number(rows[0]!.n);
      };

      const before = {
        dashboards: await countRows('dashboards'),
        drafts: await countRows('dashboard_drafts'),
        versions: await countRows('dashboard_versions'),
      };

      expect((await setLifecycle('trash')).json()).toMatchObject({ lifecycle: 'trash' });

      // Trash is a state, not a delete. Nothing is recoverable if it is gone.
      expect(await countRows('dashboards')).toBe(before.dashboards);
      expect(await countRows('dashboard_drafts')).toBe(before.drafts);
      expect(await countRows('dashboard_versions')).toBe(before.versions);
    });

    it('refuses to restore something that was never archived', async () => {
      expect((await setLifecycle('restore')).statusCode).toBe(409);
    });

    it('records who archived and who trashed', async () => {
      await setLifecycle('archived');
      await setLifecycle('restore');
      await setLifecycle('trash');

      const [events] = await ctx.handle.pool.query<RowDataPacket[]>(
        "SELECT action FROM audit_events WHERE action LIKE 'dashboard.%' ORDER BY occurred_at",
      );
      const actions = events.map((row) => String(row.action));
      expect(actions).toEqual(
        expect.arrayContaining(['dashboard.archived', 'dashboard.restored', 'dashboard.trashed']),
      );
    });
  });

  // --- publish validation --------------------------------------------------

  describe('publish validation', () => {
    const impact = (token = anna) =>
      app.inject({
        method: 'GET',
        url: `/dashboards/${dashboardId}/publish-impact`,
        headers: as(token),
      });

    it('separates what blocks a publish from what merely warns', async () => {
      // An empty dashboard is publishable and odd; an invalid one is not
      // publishable at all (D3).
      await save(anna, (snapshot) => ({ ...snapshot, widgets: [] }));

      const response = await impact();
      expect(response.json()).toMatchObject({ canPublish: true, blockingErrors: [] });
      expect(response.json().warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ messageKey: 'dashboard.publish.empty' }),
        ]),
      );
    });

    it('blocks a publish when two widgets overlap', async () => {
      // The grid engine cannot produce an overlap, so one in a draft came from
      // somewhere else - an import, an older client, a hand-edited payload.
      await save(anna, (snapshot) => ({
        ...snapshot,
        widgets: [widgetAt('a', 0, 0), widgetAt('b', 1, 1)],
      }));

      const response = await impact();
      expect(response.json().canPublish).toBe(false);
      expect(response.json().blockingErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ messageKey: 'dashboard.publish.widgets_overlap' }),
        ]),
      );

      const blocked = await app.inject({
        method: 'POST',
        url: `/dashboards/${dashboardId}/publish`,
        headers: as(anna),
      });
      expect(blocked.statusCode).toBe(422);
    });

    it('blocks a widget that leaves the raster', async () => {
      await save(anna, (snapshot) => ({ ...snapshot, widgets: [widgetAt('wide', 10, 0, 4)] }));

      expect(impactKeys(await impact())).toContain('dashboard.publish.widget_out_of_grid');
    });

    it('blocks a widget below its family minimum', async () => {
      await save(anna, (snapshot) => ({
        ...snapshot,
        widgets: [{ ...widgetAt('tiny', 0, 0), family: 'time_series' as const }],
      }));

      expect(impactKeys(await impact())).toContain('dashboard.publish.widget_too_small');
    });

    it('reports what publishing would change', async () => {
      await save(anna, (snapshot) => ({
        ...snapshot,
        widgets: [...snapshot.widgets.slice(1), widgetAt('neu', 0, 20)],
      }));

      const body = (await impact()).json();
      expect(body.addedWidgetIds).toContain('neu');
      expect(body.removedWidgetIds).toContain('kpi-visits');
    });
  });

  function widgetAt(id: string, x: number, y: number, w = 3, h = 3): WidgetConfig {
    return {
      id,
      family: 'card',
      title: id,
      placement: { desktop: { x, y, w, h } },
      data: { semanticVersionIds: [], fixedFilters: [] },
      presentation: { showComparison: false },
      context: { showDefinition: false },
    };
  }

  function impactKeys(response: { json: () => { blockingErrors: { messageKey: string }[] } }) {
    return response.json().blockingErrors.map((issue) => issue.messageKey);
  }

  it('keeps the site the dashboard was created with', () => {
    // Guards the fixture rather than the product: every case above assumes the
    // reference dashboard reads from the seeded site.
    expect(siteId).toBeTruthy();
  });
});
