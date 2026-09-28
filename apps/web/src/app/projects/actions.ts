'use server';

import { revalidatePath } from 'next/cache';
import type { ContextProfile, SetupStepKey } from '@axp/contracts';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import { listRemoteSites } from '@/lib/matomo';
import type { AdminOutcome as Outcome } from '@/app/admin/outcome';

/**
 * Project creation and setup (Master Spec §13).
 *
 * The tenant a project is created in comes from the browser, so the API
 * authorises it on its own; nothing here decides who may create what.
 */

async function run<T>(call: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { status: 'ok', data: await call() };
  } catch (error) {
    const resolved = await resolveError(error);
    return {
      status: 'error',
      message: resolved.message,
      ...(resolved.fieldErrors ? { fieldErrors: resolved.fieldErrors } : {}),
    };
  }
}

export type DataSourceInput =
  | { kind: 'existing_site'; siteId: string }
  | { kind: 'connection_site'; connectionId: string; matomoSiteId: number }
  | { kind: 'later' };

export async function createProjectAction(input: {
  tenantId: string;
  name: string;
  slug: string;
  description?: string;
  timezone: string;
  defaultLocale: 'de' | 'en';
  contextProfile: ContextProfile;
  source: DataSourceInput;
}): Promise<Outcome<{ projectId: string }>> {
  const outcome = await run(() =>
    apiRequest<{ projectId: string }>('/projects', {
      method: 'POST',
      body: input,
      authenticated: true,
    }),
  );
  if (outcome.status === 'ok') revalidatePath('/projects');
  return outcome;
}

/** Sites a tenant connection can see, for the "Datenquelle" step. Read live. */
export async function connectionSitesAction(
  tenantId: string,
  connectionId: string,
): Promise<Outcome<{ matomoSiteId: number; name: string; timezone: string }[]>> {
  return run(async () =>
    (await listRemoteSites(tenantId, connectionId)).map((site) => ({
      matomoSiteId: site.matomoSiteId,
      name: site.name,
      timezone: site.timezone,
    })),
  );
}

export async function saveContextProfileAction(
  projectId: string,
  profile: ContextProfile,
): Promise<Outcome<{ contextProfile: ContextProfile }>> {
  const outcome = await run(() =>
    apiRequest<{ contextProfile: ContextProfile }>(
      `/projects/${encodeURIComponent(projectId)}/context-profile`,
      { method: 'PUT', body: profile, authenticated: true },
    ),
  );
  if (outcome.status === 'ok') revalidatePath(`/projects/${projectId}`, 'layout');
  return outcome;
}

export async function setStepRelevanceAction(
  projectId: string,
  step: SetupStepKey,
  notRelevant: boolean,
): Promise<Outcome<unknown>> {
  const outcome = await run(() =>
    apiRequest(`/projects/${encodeURIComponent(projectId)}/setup-steps/${step}`, {
      method: 'PUT',
      body: { notRelevant },
      authenticated: true,
    }),
  );
  if (outcome.status === 'ok') revalidatePath(`/projects/${projectId}`, 'layout');
  return outcome;
}
