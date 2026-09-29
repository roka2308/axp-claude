'use server';

import { revalidatePath } from 'next/cache';
import type {
  ComparisonMode,
  ExportArtifactSummary,
  ExportFormat,
  Locale,
  ShareCreateRequest,
  ShareCreated,
  ShareSummary,
  ShareUnlocked,
  TimeRangePreset,
} from '@axp/contracts';
import { getConfig } from '@axp/config';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import { shareHeaders, writeShareSessionCookie } from '@/lib/sharing';
import type { AdminOutcome as Outcome } from '@/app/admin/outcome';

/**
 * Sharing and exports (Master Spec §15): the writes.
 *
 * One API call each. The API decides who may do what; the share token of a
 * recipient is forwarded as a header, never put into an API URL.
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

const dashboard = (dashboardId: string) => `/dashboards/${encodeURIComponent(dashboardId)}`;

export interface ExportInput {
  readonly format: ExportFormat;
  readonly widgetId?: string;
  readonly timeRange?: TimeRangePreset;
  readonly comparison?: ComparisonMode;
}

/** An export of what the viewer shows right now. */
export async function exportDashboardAction(
  dashboardId: string,
  input: ExportInput,
): Promise<Outcome<ExportArtifactSummary & { downloadHref: string }>> {
  const outcome = await run(() =>
    apiRequest<ExportArtifactSummary>(`${dashboard(dashboardId)}/exports`, {
      method: 'POST',
      body: input,
      authenticated: true,
      // Rendering a large dashboard can take a moment.
      timeoutMs: 60_000,
    }),
  );
  if (outcome.status !== 'ok' || !outcome.data) return outcome as Outcome<never>;
  return {
    status: 'ok',
    data: { ...outcome.data, downloadHref: `/exports/${outcome.data.id}/download` },
  };
}

/** Creates a link. The token comes back once and is turned into the full URL here. */
export async function createShareAction(
  dashboardId: string,
  request: ShareCreateRequest,
): Promise<Outcome<ShareCreated & { url: string }>> {
  const outcome = await run(() =>
    apiRequest<ShareCreated>(`${dashboard(dashboardId)}/shares`, {
      method: 'POST',
      body: request,
      authenticated: true,
    }),
  );
  if (outcome.status !== 'ok' || !outcome.data) return outcome as Outcome<never>;
  revalidatePath(`/dashboards/${dashboardId}/share`);
  return {
    status: 'ok',
    data: { ...outcome.data, url: `${getConfig().web.publicUrl}/s/${outcome.data.token}` },
  };
}

export async function revokeShareAction(
  dashboardId: string,
  shareId: string,
): Promise<Outcome<ShareSummary>> {
  const outcome = await run(() =>
    apiRequest<ShareSummary>(
      `${dashboard(dashboardId)}/shares/${encodeURIComponent(shareId)}/revoke`,
      { method: 'POST', body: {}, authenticated: true },
    ),
  );
  revalidatePath(`/dashboards/${dashboardId}/share`);
  return outcome;
}

// --- the recipient's side ------------------------------------------------------

export async function unlockShareAction(
  token: string,
  password: string,
): Promise<Outcome<{ unlocked: true }>> {
  const outcome = await run(() =>
    apiRequest<ShareUnlocked>('/public/share/unlock', {
      method: 'POST',
      body: { password },
      headers: { 'x-share-token': token },
    }),
  );
  if (outcome.status !== 'ok' || !outcome.data) return outcome as Outcome<never>;
  await writeShareSessionCookie(token, outcome.data.sessionToken, new Date(outcome.data.expiresAt));
  return { status: 'ok', data: { unlocked: true } };
}

export async function sharedExportAction(
  token: string,
  locale: Locale,
  input: ExportInput,
): Promise<Outcome<ExportArtifactSummary & { downloadHref: string }>> {
  const outcome = await run(async () =>
    apiRequest<ExportArtifactSummary>(`/public/share/exports?locale=${locale}`, {
      method: 'POST',
      body: input,
      headers: await shareHeaders(token),
      timeoutMs: 60_000,
    }),
  );
  if (outcome.status !== 'ok' || !outcome.data) return outcome as Outcome<never>;
  return {
    status: 'ok',
    data: { ...outcome.data, downloadHref: `/s/${token}/exports/${outcome.data.id}` },
  };
}
