import type { AuthContext, DashboardRef } from '@axp/contracts';
import type { Container } from '@axp/core';

export interface AccessibleDashboard extends DashboardRef {
  readonly projectName: string;
  readonly tenantName: string;
}

/**
 * Every dashboard this caller may open, across all their projects.
 *
 * One definition of "may open", shared by the library and the product search,
 * so the two can never disagree about what exists: a dashboard that the
 * library hides must not turn up in a search result (D1, D5).
 *
 * A viewer sees published dashboards only; a draft that was never published is
 * an editor's working copy. Trash is gone for everyone, and an archive is an
 * editor's shelf.
 */
export async function listAccessibleDashboards(
  container: Container,
  auth: AuthContext,
): Promise<{
  projects: Awaited<ReturnType<Container['projects']['listAccessible']>>;
  dashboards: AccessibleDashboard[];
  catalogProjectIds: Set<string>;
}> {
  const projects = await container.projects.listAccessible({
    tenantIds: auth.tenantIds,
    projectIds: auth.projectIds,
  });

  const dashboards: AccessibleDashboard[] = [];
  const catalogProjectIds = new Set<string>();

  for (const project of projects) {
    const target = { type: 'project' as const, projectId: project.id };
    const [canEdit, canRead, canReadCatalog] = await Promise.all([
      container.authorization.can(auth, 'dashboard.edit_draft', target),
      container.authorization.can(auth, 'dashboard.read_published', target),
      container.authorization.can(auth, 'semantic.read', target),
    ]);

    if (canReadCatalog) catalogProjectIds.add(project.id);
    if (!canEdit && !canRead) continue;

    for (const dashboard of await container.dashboards.listForProject(
      project.tenantId,
      project.id,
    )) {
      if (dashboard.lifecycle === 'trash') continue;
      if (!canEdit && (dashboard.publishedVersion === null || dashboard.lifecycle === 'archived')) {
        continue;
      }
      dashboards.push({ ...dashboard, projectName: project.name, tenantName: project.tenantName });
    }
  }

  return { projects, dashboards, catalogProjectIds };
}
