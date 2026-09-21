'use server';

import { revalidatePath } from 'next/cache';
import type { DashboardSnapshot, EditorLease, PublishImpact } from '@axp/contracts';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';

/**
 * Editor writes (Master Spec §21, D3).
 *
 * Every one of these is a Server Action rather than a browser fetch, for the
 * same reason the rest of the app is: the session token lives in an httpOnly
 * cookie the browser cannot read, and the API is never called from a page.
 *
 * Failures come back as values, not exceptions. An autosave that throws would
 * replace the editor with an error page and lose the work in progress, which
 * is the opposite of what autosave is for.
 */

export interface SaveOutcome {
  readonly status: 'saved' | 'conflict' | 'locked' | 'error';
  readonly revisionId?: string;
  readonly savedAt?: string;
  readonly message?: string;
  /** Present when another editor holds the draft. */
  readonly lease?: EditorLease | null;
}

interface DraftResponse {
  readonly revisionId: string;
  readonly updatedAt: string;
  readonly snapshot: DashboardSnapshot;
  readonly lease: EditorLease | null;
}

export async function saveDraftAction(
  dashboardId: string,
  expectedRevisionId: string,
  snapshot: DashboardSnapshot,
): Promise<SaveOutcome> {
  try {
    const draft = await apiRequest<DraftResponse>(
      `/dashboards/${encodeURIComponent(dashboardId)}/draft`,
      { method: 'PUT', body: { expectedRevisionId, snapshot }, authenticated: true },
    );

    return { status: 'saved', revisionId: draft.revisionId, savedAt: draft.updatedAt };
  } catch (error) {
    const resolved = await resolveError(error);
    const code = codeOf(error);

    // Three different situations, three different recoveries: somebody else is
    // in there, somebody else already saved, or something broke (D10).
    if (code === 'draft_locked') {
      return { status: 'locked', message: resolved.message };
    }
    if (code === 'stale_revision') {
      return { status: 'conflict', message: resolved.message };
    }
    return { status: 'error', message: resolved.message };
  }
}

export async function acquireLeaseAction(
  dashboardId: string,
  force = false,
): Promise<{ acquired: boolean; lease: EditorLease }> {
  return apiRequest(`/dashboards/${encodeURIComponent(dashboardId)}/lease`, {
    method: 'POST',
    body: { force },
    authenticated: true,
  });
}

export async function releaseLeaseAction(dashboardId: string): Promise<void> {
  try {
    await apiRequest(`/dashboards/${encodeURIComponent(dashboardId)}/lease`, {
      method: 'DELETE',
      authenticated: true,
    });
  } catch {
    // Releasing is a courtesy to the next editor; the lease expires anyway.
  }
}

export async function publishImpactAction(dashboardId: string): Promise<PublishImpact> {
  return apiRequest(`/dashboards/${encodeURIComponent(dashboardId)}/publish-impact`, {
    authenticated: true,
  });
}

export interface PublishOutcome {
  readonly status: 'published' | 'blocked' | 'error';
  readonly version?: number;
  readonly message?: string;
}

export async function publishAction(dashboardId: string): Promise<PublishOutcome> {
  try {
    const result = await apiRequest<{ version: number }>(
      `/dashboards/${encodeURIComponent(dashboardId)}/publish`,
      { method: 'POST', authenticated: true },
    );

    revalidatePath(`/dashboards/${dashboardId}`);
    revalidatePath('/projects', 'layout');
    return { status: 'published', version: result.version };
  } catch (error) {
    const resolved = await resolveError(error);
    return {
      status: codeOf(error) === 'publish_blocked' ? 'blocked' : 'error',
      message: resolved.message,
    };
  }
}

function codeOf(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'body' in error &&
    typeof (error as { body?: { code?: unknown } }).body?.code === 'string'
    ? (error as { body: { code: string } }).body.code
    : null;
}
