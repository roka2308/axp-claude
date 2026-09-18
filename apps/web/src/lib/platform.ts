import 'server-only';
import type { PlatformStatusResponse, VersionResponse } from '@axp/contracts';
import { apiRequest } from './api-client';

/**
 * Platform status for the shell.
 *
 * Returns `null` when the API cannot be reached rather than throwing, so the
 * surrounding page can render a "service unavailable" state instead of a blank
 * error screen - the distinction D10 asks for between a real failure and a
 * temporarily unavailable dependency.
 */
export async function getPlatformStatus(): Promise<PlatformStatusResponse | null> {
  try {
    return await apiRequest<PlatformStatusResponse>('/platform/status');
  } catch {
    return null;
  }
}

export async function getApiVersion(): Promise<VersionResponse | null> {
  try {
    return await apiRequest<VersionResponse>('/version');
  } catch {
    return null;
  }
}

export interface CurrentUser {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly status: string;
    readonly locale: 'de' | 'en';
  };
  readonly recentlyAuthenticated: boolean;
  readonly roleAssignments: readonly {
    readonly role: string;
    readonly scopeType: string;
    readonly scopeId: string;
    readonly viaGroup: boolean;
    readonly grantsAutomaticAnalyticsAccess: boolean;
  }[];
  readonly tenantIds: readonly string[];
  readonly projectIds: readonly string[];
}

/** The signed-in caller, or `null` when the session is missing or expired. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    return await apiRequest<CurrentUser>('/auth/me', { authenticated: true });
  } catch {
    return null;
  }
}
