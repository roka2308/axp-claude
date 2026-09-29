import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { exportRequestSchema } from '@axp/contracts';
import type { Container } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { resolveView } from './dashboards';

/**
 * Manual exports (Master Spec §15).
 *
 * The request carries the viewer's current state - period and comparison -
 * and is resolved and authorized exactly like the screen it came from, with
 * one more right: `dashboard.export`, plus the view grant on the dashboard.
 * Exports always describe the published dashboard.
 */
export function registerExportRoutes(app: FastifyInstance, container: Container): void {
  app.post(
    '/dashboards/:dashboardId/exports',
    {
      onRequest: [app.authenticate],
      // Rendering a file is real work; a loop of requests is not a use case.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { dashboardId } = z.object({ dashboardId: z.string() }).parse(request.params);
      const body = exportRequestSchema.parse(request.body);

      const resolved = await resolveView(
        container,
        auth,
        dashboardId,
        {
          source: 'published',
          breakpoint: 'desktop',
          ...(body.timeRange ? { timeRange: body.timeRange } : {}),
          ...(body.from ? { from: body.from } : {}),
          ...(body.to ? { to: body.to } : {}),
          ...(body.comparison ? { comparison: body.comparison } : {}),
        },
        'dashboard.export',
      );

      const artifact = await container.exports.create({
        tenantId: resolved.scope.tenantId,
        dashboardId,
        format: body.format,
        ...(body.widgetId ? { widgetId: body.widgetId } : {}),
        view: resolved.input,
        requester: { kind: 'user', userId: auth.userId },
      });

      void reply.status(201);
      return artifact;
    },
  );

  /** The file itself - for the person who asked for it, until it expires. */
  app.get('/exports/:artifactId', { onRequest: [app.authenticate] }, async (request, reply) => {
    const auth = requireAuth(request);
    const { artifactId } = z
      .object({ artifactId: z.string().min(1).max(64) })
      .parse(request.params);
    const file = await container.exports.open(artifactId, { kind: 'user', userId: auth.userId });
    return sendFile(reply, file);
  });
}

/**
 * Sends a finished export as a download.
 *
 * Never cached anywhere on the way: the file holds analytics values, and its
 * only copy is supposed to be the one that expires.
 */
export function sendFile(
  reply: FastifyReply,
  file: { content: Buffer; fileName: string; contentType: string },
) {
  const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return reply
    .header('content-type', file.contentType)
    .header(
      'content-disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    )
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .send(file.content);
}
