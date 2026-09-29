import { eq } from 'drizzle-orm';
import {
  AppError,
  type AuthContext,
  type Capability,
  type DashboardSnapshot,
  type TimeRangePreset,
} from '@axp/contracts';
import { dashboards as dashboardsTable } from '@axp/db';
import type { Container } from '@axp/core';
import { requireProjectScope } from './project-scope';

/**
 * Resolves the project a dashboard belongs to, then authorizes against it.
 *
 * The dashboard id comes from the browser; its project and tenant are read
 * from the database before any capability check happens. The role is half of
 * it: reading a dashboard's data, exporting it or sharing it also needs an
 * object grant that covers the dashboard (ADR 0006). Only drafting and
 * publishing need `edit`; everything that works on the published dashboard
 * needs `view`.
 */
export async function scopeForDashboard(
  container: Container,
  auth: AuthContext,
  dashboardId: string,
  capability: Capability,
) {
  const [row] = await container.db
    .select({ projectId: dashboardsTable.projectId })
    .from(dashboardsTable)
    .where(eq(dashboardsTable.id, dashboardId))
    .limit(1);

  if (!row) {
    throw new AppError('not_found', {
      code: 'dashboard_not_found',
      messageKey: 'dashboard.not_found',
      internalMessage: `Dashboard ${dashboardId} does not exist.`,
    });
  }

  const scope = await requireProjectScope(container, auth, row.projectId, capability);

  // Checked after the scope, so a caller from another tenant still gets the
  // same answer as for a dashboard that does not exist.
  await container.access.assertDashboard(auth, dashboardId, grantNeededFor(capability));

  return scope;
}

function grantNeededFor(capability: Capability): 'view' | 'edit' {
  switch (capability) {
    case 'dashboard.read_published':
    case 'dashboard.export':
    case 'dashboard.share':
      return 'view';
    default:
      return 'edit';
  }
}

/**
 * The period a dashboard opens on when the URL names none: its own default,
 * as the author set it (D4). A stored custom range has no meaning without its
 * dates, so it falls back to the last 30 days.
 */
export function defaultPreset(snapshot: DashboardSnapshot): TimeRangePreset {
  const preset = snapshot.defaultTimeRange.preset;
  return preset === 'custom' ? 'last_30_days' : preset;
}
