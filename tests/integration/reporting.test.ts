import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { DashboardSnapshot, ReportScheduleInput } from '@axp/contracts';
import { attentionItems, jobs, reportRuns } from '@axp/db';
import { seedReferenceDashboard } from '@axp/fixtures';
import { hours, JobRunner, MemoryMailTransport, minutes, resolveTimeRange } from '@axp/core';
import { buildServer } from '../../apps/api/src/server';
import { pdfText } from '../../packages/core/src/export/readers.test-helper';
import {
  closeDatabase,
  createTestContext,
  grantProjectAccess,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  TEST_NOW,
  type TestContext,
} from './harness';

/**
 * Scheduled reporting, the job queue and the Attention Center (D8, Gate F8).
 *
 * Mail goes to an in-memory outbox, so every test can say exactly who got
 * what: which file, which period, and who was left out and why.
 */
describe('scheduled reporting and the attention center', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let mail: MemoryMailTransport;
  let worker: JobRunner;

  let tenantId: string;
  let projectId: string;
  let dashboardId: string;
  let editorId: string;
  let viewerId: string;
  let colleagueId: string;
  let editor: string;
  let viewer: string;
  let admin: string;

  beforeEach(async () => {
    await resetDatabase();
    mail = new MemoryMailTransport();
    ctx = await createTestContext({ mailTransport: mail });
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();
    worker = new JobRunner({
      queue: ctx.container.jobs,
      logger: ctx.logger,
      handlers: { 'report.deliver': ctx.container.reportRunner.asJobHandler() },
      workerId: 'test-worker',
      pollMs: 1000,
    });

    tenantId = (
      await ctx.container.tenants.createTenant({
        portableId: 'demo.tenant',
        name: 'Kunde',
        slug: 'kunde',
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

    editorId = await user('editor@example.invalid', 'dashboard_editor', 'project');
    await grantProjectAccess(ctx, editorId, projectId, 'edit');
    viewerId = await user('viewer@example.invalid', 'viewer', 'project');
    await grantProjectAccess(ctx, viewerId, projectId, 'view');
    colleagueId = await user('colleague@example.invalid', 'viewer', 'project');
    await grantProjectAccess(ctx, colleagueId, projectId, 'view');
    await user('admin@example.invalid', 'tenant_admin', 'tenant');

    dashboardId = (
      await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId: editorId })
    ).dashboardId;

    editor = await signIn('editor@example.invalid');
    viewer = await signIn('viewer@example.invalid');
    admin = await signIn('admin@example.invalid');
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // --- the job queue -------------------------------------------------------------

  describe('job queue', () => {
    it('enqueues idempotently, claims under a lease, retries with backoff, then gives up', async () => {
      const queue = ctx.container.jobs;
      const first = await queue.enqueue({
        kind: 'report.deliver',
        payload: { runId: 'r-1' },
        dedupeKey: 'k-1',
      });
      const again = await queue.enqueue({
        kind: 'report.deliver',
        payload: { runId: 'r-1' },
        dedupeKey: 'k-1',
      });
      expect(again).toEqual({ id: first.id, created: false });

      const [claimed] = await queue.claim('w-1');
      expect(claimed).toMatchObject({ id: first.id, attempt: 1 });
      // Leased: nobody else gets it.
      expect(await queue.claim('w-2')).toHaveLength(0);

      const retry = await queue.fail(claimed!, {
        code: 'report.source_unavailable',
        retryable: true,
      });
      expect(retry.status).toBe('queued');
      expect(retry.retryAt!.getTime() - ctx.clock.now().getTime()).toBe(minutes(1));
      expect(await queue.claim('w-1')).toHaveLength(0); // not yet due

      ctx.clock.advance(minutes(1));
      const [second] = await queue.claim('w-1');
      expect(second!.attempt).toBe(2);
      await queue.fail(second!, { code: 'x', retryable: true });
      ctx.clock.advance(minutes(5));
      const [third] = await queue.claim('w-1');
      expect((await queue.fail(third!, { code: 'x', retryable: true })).status).toBe('dead');
    });

    it('returns a crashed worker’s job to the queue when its lease runs out', async () => {
      const queue = ctx.container.jobs;
      await queue.enqueue({ kind: 'report.deliver', payload: { runId: 'r-2' } });
      expect(await queue.claim('w-crashed')).toHaveLength(1);
      ctx.clock.advance(ctx.config.worker.jobLeaseSeconds * 1000 + 1);
      expect(await queue.reapExpiredLeases()).toBe(1);
      const [reclaimed] = await queue.claim('w-healthy');
      expect(reclaimed!.attempt).toBe(2);
    });

    it('refuses a payload that is not just ids', async () => {
      await expect(
        ctx.container.jobs.enqueue({
          kind: 'report.deliver',
          payload: { runId: 'r', values: [1, 2, 3] } as never,
        }),
      ).rejects.toThrow();
    });
  });

  // --- schedules -------------------------------------------------------------------

  describe('schedules', () => {
    it('refuses what cannot work: a foreign recipient, PPTX before its gate, a made-up zone', async () => {
      const outsider = await ctx.container.users.createLocalUser({
        email: 'outsider@example.invalid',
        firstName: 'Out',
        lastName: 'Sider',
        password: STRONG_TEST_PASSWORD,
        status: 'active',
      });
      const cases: [Parameters<typeof scheduleBody>[0], string][] = [
        [{ recipientUserIds: [outsider.userId] }, 'recipientUserIds'],
        [{ format: 'pptx' }, 'format'],
        [{ timezone: 'Mars/Olympus' }, 'timezone'],
      ];
      for (const [patch, field] of cases) {
        const response = await post(`/projects/${projectId}/reports`, editor, scheduleBody(patch));
        expect(response.statusCode, field).toBe(422);
        expect(response.json().error.fieldErrors[field], field).toBeTruthy();
      }
    });

    it('is managed by editors only, and computes the next run in its own time zone', async () => {
      expect(
        (await post(`/projects/${projectId}/reports`, viewer, scheduleBody())).statusCode,
      ).toBe(403);
      const created = await post(`/projects/${projectId}/reports`, editor, scheduleBody());
      expect(created.statusCode).toBe(201);
      // TEST_NOW is 2026-09-18 10:00 UTC; 07:00 Berlin the next day is 05:00 UTC.
      expect(created.json()).toMatchObject({
        status: 'active',
        nextRunAt: '2026-09-19T05:00:00.000Z',
      });
    });
  });

  // --- running reports --------------------------------------------------------------

  describe('a scheduled run', () => {
    it('reads the Published Runtime, covers the period relative to when it was due, and mails each recipient', async () => {
      const schedule = await createSchedule();
      // The editor keeps working on the draft: the report must not see it.
      await editDraft((snapshot) => ({ ...snapshot, name: 'ENTWURF-NICHT-SENDEN' }));

      ctx.clock.set(new Date('2026-09-19T05:00:30Z'));
      expect(await ctx.container.reportRunner.scheduleDue()).toEqual({ queued: 1, skipped: 0 });
      // The worker gets to it hours later - the period stays the one that was due.
      ctx.clock.set(new Date('2026-09-19T14:00:00Z'));
      expect(await worker.drain()).toBe(1);

      const expected = resolveTimeRange({
        preset: 'last_7_days',
        timezone: 'Europe/Berlin',
        now: new Date('2026-09-19T05:00:00Z'),
      });
      const [run] = await ctx.handle.db
        .select()
        .from(reportRuns)
        .where(eq(reportRuns.scheduleId, schedule.id));
      expect(run).toMatchObject({
        status: 'delivered',
        delivered: 2,
        publishedVersion: 1,
        periodFrom: expected.from,
        periodTo: expected.to,
      });

      expect(mail.outbox.map((message) => message.to.address).sort()).toEqual([
        'colleague@example.invalid',
        'viewer@example.invalid',
      ]);
      const [message] = mail.outbox;
      expect(message!.attachments).toHaveLength(1);
      expect(message!.attachments![0]!.filename).toMatch(/\.pdf$/);
      const text = (await pdfText(message!.attachments![0]!.content)).join('\n');
      expect(text).toContain('Portal Overview');
      expect(text).not.toContain('ENTWURF-NICHT-SENDEN');
      expect(text).toContain('Veröffentlichte Version 1');
      // One recipient per message: nobody learns who else got it.
      expect(message!.text).not.toContain('colleague@example.invalid');

      // Nothing of the report is kept.
      expect(JSON.stringify(await ctx.handle.db.select().from(jobs))).not.toMatch(/value|Besuche/);
    }, 60_000);

    it('sends a link instead of a file when asked, and stores nothing', async () => {
      await createSchedule({ deliveryMode: 'link', recipientUserIds: [viewerId] });
      ctx.clock.set(new Date('2026-09-19T05:01:00Z'));
      await ctx.container.reportRunner.scheduleDue();
      await worker.drain();
      const [message] = mail.outbox;
      expect(message!.attachments ?? []).toHaveLength(0);
      expect(message!.text).toContain(`/dashboards/${dashboardId}?timeRange=last_7_days`);
    });

    it('leaves out a recipient who lost access, and tells the owner', async () => {
      const schedule = await createSchedule();
      const grants = await ctx.container.access.listGrants(tenantId, { subjectIds: [colleagueId] });
      for (const grant of grants)
        await ctx.container.access.revoke({ tenantId, grantId: grant.id });

      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await worker.drain();

      const [run] = await ctx.handle.db.select().from(reportRuns);
      expect(run).toMatchObject({ status: 'partially_delivered', delivered: 1 });
      expect(run!.skipped).toEqual([{ userId: colleagueId, reason: 'no_access' }]);
      expect(mail.outbox.map((message) => message.to.address)).toEqual(['viewer@example.invalid']);

      const items = (await get('/attention', editor)).json().items;
      expect(items).toEqual([
        expect.objectContaining({ kind: 'report_recipient_without_access', severity: 'warning' }),
      ]);
    });

    it('retries a failed delivery with backoff and then delivers', async () => {
      const schedule = await createSchedule({ recipientUserIds: [viewerId] });
      mail.failNext = 1;
      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await worker.drain();

      let [run] = await ctx.handle.db.select().from(reportRuns);
      expect(run).toMatchObject({ status: 'queued', attempts: 1, errorKey: 'report.mail_failed' });

      ctx.clock.advance(minutes(1));
      await worker.drain();
      [run] = await ctx.handle.db.select().from(reportRuns);
      expect(run).toMatchObject({ status: 'delivered', attempts: 2 });
    }, 60_000);
  });

  // --- tenant lifecycle ----------------------------------------------------------------

  describe('a suspended tenant', () => {
    it('stops its reports: due ones are skipped, queued ones cancelled, nothing is sent', async () => {
      const schedule = await createSchedule();
      // One run queued before the suspension...
      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await ctx.container.tenants.changeLifecycle(tenantId, 'suspended');

      // ...and one falling due during it.
      ctx.clock.set(new Date('2026-09-19T05:00:30Z'));
      expect(await ctx.container.reportRunner.scheduleDue()).toEqual({ queued: 0, skipped: 1 });
      await worker.drain();

      const runs = await ctx.handle.db.select().from(reportRuns);
      expect(runs.map((run) => [run.trigger, run.status, run.errorKey]).sort()).toEqual([
        ['manual', 'skipped', 'report.tenant_inactive'],
        ['schedule', 'skipped', 'report.tenant_inactive'],
      ]);
      expect(mail.outbox).toHaveLength(0);
      const [job] = await ctx.handle.db.select().from(jobs);
      expect(job!.status).toBe('cancelled');

      // Reactivated, the next occurrence runs again.
      await ctx.container.tenants.changeLifecycle(tenantId, 'active');
      ctx.clock.set(new Date('2026-09-20T05:00:30Z'));
      expect(await ctx.container.reportRunner.scheduleDue()).toEqual({ queued: 1, skipped: 0 });
      await worker.drain();
      expect(mail.outbox).toHaveLength(2);
    }, 60_000);
  });

  // --- attention center ----------------------------------------------------------------------

  describe('attention center', () => {
    it('groups a repeated failure into one item, mails its owner once, and clears it on success', async () => {
      const schedule = await createSchedule({ recipientUserIds: [viewerId] });
      await ctx.container.dashboards.changeLifecycle({
        tenantId,
        dashboardId,
        to: 'archived',
        actorUserId: editorId,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        ctx.clock.advance(minutes(1));
        await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
        await worker.drain();
      }

      const items = await ctx.handle.db
        .select()
        .from(attentionItems)
        .where(eq(attentionItems.kind, 'report_failed'));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        severity: 'action_required',
        occurrences: 3,
        status: 'open',
      });
      // Selective mail: one notice to the owner, not one per failure.
      const notices = mail.outbox.filter(
        (message) => message.to.address === 'editor@example.invalid',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain('/attention');

      const runs = await ctx.handle.db.select().from(reportRuns);
      expect(
        runs.every(
          (run) => run.status === 'failed' && run.errorKey === 'report.dashboard_not_published',
        ),
      ).toBe(true);

      await ctx.container.dashboards.changeLifecycle({
        tenantId,
        dashboardId,
        to: 'restore',
        actorUserId: editorId,
      });
      ctx.clock.advance(minutes(1));
      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await worker.drain();
      const [cleared] = await ctx.handle.db
        .select()
        .from(attentionItems)
        .where(eq(attentionItems.kind, 'report_failed'));
      expect(cleared!.status).toBe('resolved');
    }, 60_000);

    it('routes items by role: report problems to editors, account reviews to administrators', async () => {
      const schedule = await createSchedule({ recipientUserIds: [viewerId] });
      await ctx.container.dashboards.changeLifecycle({
        tenantId,
        dashboardId,
        to: 'archived',
        actorUserId: editorId,
      });
      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await worker.drain();

      ctx.clock.advance(hours(24 * 200));
      await ctx.container.attentionScans.inactiveAccounts();
      // Two hundred days later every session has long expired.
      editor = await signIn('editor@example.invalid');
      admin = await signIn('admin@example.invalid');
      viewer = await signIn('viewer@example.invalid');

      const kinds = async (token: string) =>
        [
          ...new Set(
            (await get('/attention', token))
              .json()
              .items.map((item: { kind: string }) => item.kind),
          ),
        ].sort();
      expect(await kinds(editor)).toEqual(['report_failed']);
      expect(await kinds(admin)).toEqual(['inactivity_review']);
      expect(await kinds(viewer)).toEqual([]);
    });

    it('lets people acknowledge an item, and reopens it when the problem returns', async () => {
      const schedule = await createSchedule({ recipientUserIds: [viewerId] });
      await ctx.container.dashboards.changeLifecycle({
        tenantId,
        dashboardId,
        to: 'archived',
        actorUserId: editorId,
      });
      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await worker.drain();

      const [item] = (await get('/attention', editor)).json().items;
      expect((await post(`/attention/${item.id}/acknowledge`, editor, {})).statusCode).toBe(204);
      expect((await post(`/attention/${item.id}/acknowledge`, viewer, {})).statusCode).toBe(404);
      expect((await get('/attention', editor)).json().items[0].status).toBe('acknowledged');

      ctx.clock.advance(minutes(1));
      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await worker.drain();
      const [again] = (await get('/attention', editor)).json().items;
      expect(again).toMatchObject({ status: 'open', occurrences: 2 });
    });

    it('mentions a link close to its expiry to whoever created it', async () => {
      const created = await post(`/dashboards/${dashboardId}/shares`, editor, {
        label: 'Vorstand',
        expiresOn: '2026-09-19',
        rights: { timeRange: false, comparison: false, detail: false, export: false },
      });
      expect(created.statusCode).toBe(201);
      expect(await ctx.container.attentionScans.expiringShares()).toBe(1);
      const [item] = (await get('/attention', editor)).json().items;
      expect(item).toMatchObject({ kind: 'share_expiring', severity: 'warning' });
      expect(item.messageParams.label).toBe('Vorstand');

      await post(`/dashboards/${dashboardId}/shares/${created.json().share.id}/revoke`, editor, {});
      await ctx.container.attentionScans.expiringShares();
      expect((await get('/attention', editor)).json().items).toHaveLength(0);
    });

    it('carries no analytics values in what it stores', async () => {
      const schedule = await createSchedule({ recipientUserIds: [viewerId] });
      await ctx.container.dashboards.changeLifecycle({
        tenantId,
        dashboardId,
        to: 'archived',
        actorUserId: editorId,
      });
      await ctx.container.reports.runNow({ tenantId, projectId, scheduleId: schedule.id });
      await worker.drain();
      const [item] = await ctx.handle.db
        .select()
        .from(attentionItems)
        .where(and(eq(attentionItems.tenantId, tenantId)));
      expect(Object.keys(item!.messageParams).sort()).toEqual(['reason', 'report']);
    });
  });

  // --- helpers -------------------------------------------------------------------------

  function scheduleBody(patch: Partial<ReportScheduleInput> = {}): ReportScheduleInput {
    return {
      dashboardId,
      name: 'Wochenbericht',
      format: 'pdf',
      period: 'last_7_days',
      comparison: 'previous_period',
      rhythm: { frequency: 'daily', time: '07:00' },
      timezone: 'Europe/Berlin',
      deliveryMode: 'attachment',
      recipientUserIds: [viewerId, colleagueId],
      ...patch,
    };
  }

  async function createSchedule(patch: Partial<ReportScheduleInput> = {}) {
    const response = await post(`/projects/${projectId}/reports`, editor, scheduleBody(patch));
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string };
  }

  async function editDraft(change: (snapshot: DashboardSnapshot) => DashboardSnapshot) {
    const draft = await ctx.container.dashboards.getDraft(tenantId, dashboardId, editorId);
    await ctx.container.dashboards.saveDraft({
      tenantId,
      dashboardId,
      expectedRevisionId: draft.revisionId,
      snapshot: change(draft.snapshot),
      actorUserId: editorId,
    });
  }

  async function user(
    email: string,
    role: 'viewer' | 'dashboard_editor' | 'tenant_admin',
    scope: 'project' | 'tenant',
  ) {
    const { userId } = await ctx.container.users.createLocalUser({
      email,
      firstName: email.split('@')[0]!,
      lastName: 'Tester',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.tenants.addMembership(tenantId, userId);
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role,
      scopeType: scope,
      scopeId: scope === 'project' ? projectId : tenantId,
    });
    return userId;
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

  function get(url: string, token: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  }

  function post(url: string, token: string, payload: unknown) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as object,
    });
  }

  void TEST_NOW;
});
