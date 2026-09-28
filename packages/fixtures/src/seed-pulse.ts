import { type Container, MOCK_PULSE_METRICS, PULSE_PACKAGE } from '@axp/core';

/**
 * The Pulse reference solution in the canonical demo (Master Spec §14,
 * `06_Canonical_Demo_Data_Pulse_v1.0.md`).
 *
 * Installed through the ordinary install path - analysed, mapped onto the
 * site's reports, imported - by the semantic catalog manager, the role that
 * would do it; then both reference dashboards are created from their
 * templates and published by the editor. Idempotent: an installed solution is
 * reused, and existing dashboards of the same name are left alone.
 */

export const PULSE_DASHBOARDS = ['Executive Health Overview', 'Engagement & Participation Detail'];

export interface SeedPulseResult {
  readonly dashboardIds: readonly string[];
}

export async function seedPulseSolution(
  container: Container,
  params: { tenantId: string; projectId: string; installerUserId: string; editorUserId: string },
): Promise<SeedPulseResult> {
  const { tenantId, projectId } = params;
  const source = { catalog: { packageId: PULSE_PACKAGE.manifest.packageId } };

  const analysis = await container.solutions.analyze(tenantId, projectId, source);
  if (analysis.installedVersion !== PULSE_PACKAGE.manifest.packageVersion) {
    await container.solutions.install({
      tenantId,
      projectId,
      source,
      request: {
        mappings: {
          'pulse.active_users': MOCK_PULSE_METRICS.activeUsers,
          'pulse.engaged_users': MOCK_PULSE_METRICS.engagedUsers,
          'pulse.content_creators': MOCK_PULSE_METRICS.contentCreators,
          'pulse.registered_users': MOCK_PULSE_METRICS.registeredUsers,
        },
        resolutions: {},
        acceptWarnings: true,
      },
      actorUserId: params.installerUserId,
    });
  }

  const existing = await container.dashboards.listForProject(tenantId, projectId);
  const templates = await container.solutions.listTemplates(tenantId, projectId, 'dashboard');
  const dashboardIds: string[] = [];

  for (const name of PULSE_DASHBOARDS) {
    const present = existing.find((dashboard) => dashboard.name === name);
    if (present) {
      dashboardIds.push(present.id);
      continue;
    }
    const template = templates.find((entry) => entry.name === name);
    if (!template) throw new Error(`Pulse template "${name}" is missing after install.`);

    const { dashboardId } = await container.solutions.createDashboardFromTemplate({
      tenantId,
      projectId,
      templateId: template.id,
      actorUserId: params.editorUserId,
    });
    await container.dashboards.publish({ tenantId, dashboardId, actorUserId: params.editorUserId });
    dashboardIds.push(dashboardId);
  }

  return { dashboardIds };
}
