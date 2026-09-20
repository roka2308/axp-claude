'use server';

import { revalidatePath } from 'next/cache';
import { publishDashboard } from '@/lib/matomo';

/**
 * Publishes the current draft as a new immutable version (Master Spec §21).
 *
 * Its own module because it is reached from the project list rather than from
 * the setup form, and a Server Action file may only export actions.
 *
 * Publishing is the only way a viewer's dashboard changes. Failures are left to
 * propagate: a publish that silently did nothing would be worse than an error
 * page, because the editor would believe the new version is live.
 */
export async function publishDashboardAction(
  dashboardId: string,
  _formData?: FormData,
): Promise<void> {
  await publishDashboard(dashboardId);
  revalidatePath('/projects', 'layout');
  revalidatePath(`/dashboards/${dashboardId}`);
}
