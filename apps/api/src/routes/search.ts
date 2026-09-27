import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProductSearchResult } from '@axp/contracts';
import { type Container, searchProducts, type SearchCandidate } from '@axp/core';
import { requireAuth } from '../plugins/authentication';
import { listAccessibleDashboards } from '../lib/accessible-dashboards';

/**
 * Product search and the dashboard library (D1).
 *
 * Both start from the same question - what may this caller open? - answered
 * once, in `listAccessibleDashboards`, before any name is compared. A search
 * can therefore never reveal that a dashboard exists by listing it, and the
 * library and the search can never disagree.
 *
 * A basic index by design: product configuration is small, the names are
 * already in MySQL, and a separate search index would be one more store to
 * keep consistent with the permission model. Matching is in `searchProducts`.
 */
export function registerSearchRoutes(app: FastifyInstance, container: Container): void {
  app.get(
    '/search',
    { onRequest: [app.authenticate] },
    async (request): Promise<ProductSearchResult> => {
      const auth = requireAuth(request);
      const { q } = z.object({ q: z.string().trim().max(100).default('') }).parse(request.query);

      if (q.length < 2) return { query: q, hits: [] };

      const { projects, dashboards, catalogProjectIds } = await listAccessibleDashboards(
        container,
        auth,
      );

      const candidates: SearchCandidate[] = [];

      for (const project of projects) {
        candidates.push({
          kind: 'project',
          id: project.id,
          title: project.name,
          context: project.tenantName,
          href: `/projects/${project.id}`,
          ...(project.description ? { keywords: project.description } : {}),
        });
      }

      for (const dashboard of dashboards) {
        candidates.push({
          kind: 'dashboard',
          id: dashboard.id,
          title: dashboard.name,
          context: dashboard.projectName,
          href: `/dashboards/${dashboard.id}`,
        });
      }

      for (const project of projects) {
        if (!catalogProjectIds.has(project.id)) continue;
        for (const definition of await container.semantics.listForProject(
          project.tenantId,
          project.id,
        )) {
          candidates.push({
            kind: 'definition',
            id: definition.id,
            title: definition.name,
            context: project.name,
            href: `/projects/${project.id}/semantics`,
            ...(definition.description ? { keywords: definition.description } : {}),
          });
        }
      }

      return { query: q, hits: searchProducts(candidates, q) };
    },
  );

  /**
   * The dashboard library: every dashboard the caller may open, across
   * projects (D1 "Dashboards", D10 journey 1: Login → Library → Dashboard).
   */
  app.get('/dashboards', { onRequest: [app.authenticate] }, async (request) => {
    const auth = requireAuth(request);
    const { dashboards } = await listAccessibleDashboards(container, auth);

    return {
      dashboards: dashboards.sort(
        (a, b) =>
          a.projectName.localeCompare(b.projectName, 'de') || a.name.localeCompare(b.name, 'de'),
      ),
    };
  });
}
