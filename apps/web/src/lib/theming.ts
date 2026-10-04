import 'server-only';
import type {
  EntitlementState,
  FeatureFlagState,
  SystemOverview,
  ThemeOverview,
  ThemeValidation,
} from '@axp/contracts';
import { apiRequest } from './api-client';
import { shareHeaders } from './sharing';

/**
 * Reads for themes, entitlements and the system surface (Phase 9).
 *
 * The theme stylesheet comes from the API, which builds it from allowlisted
 * tokens with validated values only; the web app adds nothing to it.
 */

export async function getThemeCss(context: {
  readonly projectId?: string;
  readonly dashboardId?: string;
}): Promise<string> {
  const query = new URLSearchParams({
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.dashboardId ? { dashboardId: context.dashboardId } : {}),
  }).toString();
  try {
    const result = await apiRequest<{ css: string }>(
      `/theme/effective${query ? `?${query}` : ''}`,
      {
        authenticated: true,
      },
    );
    return result.css;
  } catch {
    // Not signed in: the platform's theme. Unreachable: the product defaults.
    return apiRequest<{ css: string }>('/theme/platform')
      .then((result) => result.css)
      .catch(() => '');
  }
}

export async function getSharedThemeCss(token: string): Promise<string> {
  return apiRequest<{ css: string }>('/public/share/theme', { headers: await shareHeaders(token) })
    .then((result) => result.css)
    .catch(() => '');
}

export type ThemeScopePath = 'platform' | `tenants/${string}` | `projects/${string}`;

export async function getTheme(path: ThemeScopePath): Promise<ThemeOverview> {
  return apiRequest<ThemeOverview>(`/themes/${path}`, { authenticated: true });
}

export async function getEntitlements(
  tenantId: string,
): Promise<{ entitlements: EntitlementState[]; featureFlags: FeatureFlagState[] }> {
  return apiRequest(`/admin/platform/tenants/${encodeURIComponent(tenantId)}/entitlements`, {
    authenticated: true,
  });
}

export async function getSystemOverview(): Promise<SystemOverview> {
  return apiRequest<SystemOverview>('/admin/platform/system', { authenticated: true });
}

export type { ThemeValidation };
