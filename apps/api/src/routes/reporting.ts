import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { reportScheduleInputSchema } from '@axp/contracts';
import type { Container } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { requireProjectScope } from '../lib/project-scope';

/**
 * Scheduled reports (Master Spec §15: Projekt → Reports) and the Attention
 * Center.
 *
 * Managing a schedule needs `report.manage` in the project and a view grant on
 * the dashboard it sends: nobody schedules a dashboard they could not open
 * themselves (ADR 0006). The Attention Center is open to every signed-in
 * person; what they see is routed by their own capabilities.
 */
export function registerReportingRoutes(app: FastifyInstance, container: Container): void {
  const project = z.object({ projectId: z.string() });
  const schedule = z.object({ projectId: z.string(), scheduleId: z.string() });

  app.get('/projects/:projectId/reports', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { projectId } = project.parse(request.params);
    const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
    const [schedules, options] = await Promise.all([
      container.reports.list(scope.tenantId, scope.projectId),
      container.reports.options(scope.tenantId, scope.projectId, scope.timezone),
    ]);
    return { schedules, options };
  });

  app.get(
    '/projects/:projectId/reports/recipients',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId } = project.parse(request.params);
      const { dashboardId } = z.object({ dashboardId: z.string().min(1) }).parse(request.query);
      const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
      await container.access.assertDashboard(auth, dashboardId, 'view');
      return { recipients: await container.reports.recipientsFor(scope.tenantId, dashboardId) };
    },
  );

  app.post(
    '/projects/:projectId/reports',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId } = project.parse(request.params);
      const body = reportScheduleInputSchema.parse(request.body);
      const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
      await container.access.assertDashboard(auth, body.dashboardId, 'view');
      const created = await container.reports.create({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        actorUserId: auth.userId,
        request: body,
      });
      void reply.status(201);
      return created;
    },
  );

  app.put(
    '/projects/:projectId/reports/:scheduleId',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId, scheduleId } = schedule.parse(request.params);
      const body = reportScheduleInputSchema.parse(request.body);
      const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
      await container.access.assertDashboard(auth, body.dashboardId, 'view');
      return container.reports.update({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        scheduleId,
        actorUserId: auth.userId,
        request: body,
      });
    },
  );

  app.post(
    '/projects/:projectId/reports/:scheduleId/pause',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId, scheduleId } = schedule.parse(request.params);
      const { paused } = z.object({ paused: z.boolean() }).parse(request.body);
      const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
      return container.reports.setPaused({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        scheduleId,
        actorUserId: auth.userId,
        paused,
      });
    },
  );

  app.delete(
    '/projects/:projectId/reports/:scheduleId',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId, scheduleId } = schedule.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
      await container.reports.remove({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        scheduleId,
        actorUserId: auth.userId,
      });
      void reply.status(204);
    },
  );

  /** "Send now": queued like any run, checked like any run. */
  app.post(
    '/projects/:projectId/reports/:scheduleId/run',
    {
      onRequest: [app.authenticate],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { projectId, scheduleId } = schedule.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
      const run = await container.reports.runNow({
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        scheduleId,
      });
      void reply.status(202);
      return run;
    },
  );

  app.get(
    '/projects/:projectId/reports/:scheduleId/runs',
    { onRequest: [app.authenticate] },
    async (request) => {
      const auth = requireAuth(request);
      const { projectId, scheduleId } = schedule.parse(request.params);
      const scope = await requireProjectScope(container, auth, projectId, 'report.manage');
      return { runs: await container.reports.runs(scope.tenantId, scheduleId) };
    },
  );

  // --- Attention Center ------------------------------------------------------

  app.get('/attention', { onRequest: [app.authenticate] }, async (request) => {
    return container.attention.list(requireAuth(request));
  });

  app.post(
    '/attention/:itemId/acknowledge',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { itemId } = z.object({ itemId: z.string().min(1).max(64) }).parse(request.params);
      await container.attention.acknowledge(auth, itemId);
      void reply.status(204);
    },
  );
}
