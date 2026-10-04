import 'server-only';
import { cookies } from 'next/headers';
import type {
  ComparisonMode,
  DashboardPermissions,
  InternalAccessSummary,
  Locale,
  ShareAccess,
  SharedLayout,
  ShareExpiryWindow,
  ShareSummary,
  TimeRangePreset,
  WidgetDetailPresentation,
  WidgetPresentation,
} from '@axp/contracts';
import { getConfig } from '@axp/config';
import { apiRequest } from './api-client';

/**
 * Reads for sharing (Master Spec §15).
 *
 * Two audiences. Signed-in people manage shares with their session. A share
 * recipient has no session at all: their link token and, for a protected
 * share, a password session travel to the API as headers - never in an API
 * URL, where access logs would keep them.
 */

const dashboard = (dashboardId: string) => `/dashboards/${encodeURIComponent(dashboardId)}`;

export async function getDashboardPermissions(dashboardId: string): Promise<DashboardPermissions> {
  return apiRequest<DashboardPermissions>(`${dashboard(dashboardId)}/permissions`, {
    authenticated: true,
  });
}

export async function listShares(
  dashboardId: string,
): Promise<{ shares: ShareSummary[]; expiry: ShareExpiryWindow; entitled: boolean }> {
  return apiRequest<{ shares: ShareSummary[]; expiry: ShareExpiryWindow; entitled: boolean }>(
    `${dashboard(dashboardId)}/shares`,
    { authenticated: true },
  );
}

export async function getInternalAccess(dashboardId: string): Promise<InternalAccessSummary> {
  return apiRequest<InternalAccessSummary>(`${dashboard(dashboardId)}/internal-access`, {
    authenticated: true,
  });
}

// --- the recipient's side ----------------------------------------------------

/** The cookie that proves a share's password was given, scoped to that share's pages. */
export function shareSessionCookieName(): string {
  return 'axp_share_session';
}

export function shareCookiePath(token: string): string {
  return `/s/${token}`;
}

export async function shareHeaders(token: string): Promise<Record<string, string>> {
  const store = await cookies();
  const session = store.get(shareSessionCookieName())?.value;
  return {
    'x-share-token': token,
    ...(session ? { 'x-share-session': session } : {}),
  };
}

export async function writeShareSessionCookie(token: string, session: string, expiresAt: Date) {
  const store = await cookies();
  store.set({
    name: shareSessionCookieName(),
    value: session,
    httpOnly: true,
    sameSite: 'lax',
    secure: getConfig().web.publicUrl.startsWith('https://'),
    path: shareCookiePath(token),
    expires: expiresAt,
  });
}

export interface SharedViewQuery {
  readonly timeRange?: TimeRangePreset;
  readonly comparison?: ComparisonMode;
  readonly locale: Locale;
}

function sharedSearch(query: SharedViewQuery): string {
  return new URLSearchParams({
    ...(query.timeRange ? { timeRange: query.timeRange } : {}),
    ...(query.comparison ? { comparison: query.comparison } : {}),
    breakpoint: 'desktop',
    locale: query.locale,
  }).toString();
}

export async function getShareAccess(token: string): Promise<ShareAccess> {
  return apiRequest<ShareAccess>('/public/share', { headers: await shareHeaders(token) });
}

export async function getSharedLayout(
  token: string,
  query: SharedViewQuery,
): Promise<SharedLayout> {
  return apiRequest<SharedLayout>(`/public/share/layout?${sharedSearch(query)}`, {
    headers: await shareHeaders(token),
  });
}

export async function getSharedTile(
  token: string,
  widgetId: string,
  query: SharedViewQuery,
): Promise<WidgetPresentation> {
  return apiRequest<WidgetPresentation>(
    `/public/share/widgets/${encodeURIComponent(widgetId)}?${sharedSearch(query)}`,
    { headers: await shareHeaders(token) },
  );
}

export async function getSharedDetail(
  token: string,
  widgetId: string,
  query: SharedViewQuery,
): Promise<WidgetDetailPresentation> {
  return apiRequest<WidgetDetailPresentation>(
    `/public/share/widgets/${encodeURIComponent(widgetId)}/detail?${sharedSearch(query)}`,
    { headers: await shareHeaders(token) },
  );
}
