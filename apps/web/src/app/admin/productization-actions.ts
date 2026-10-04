'use server';

import { revalidatePath } from 'next/cache';
import type {
  DiagnosticArtifactSummary,
  Entitlement,
  EntitlementState,
  ThemeOverview,
  ThemeValidation,
} from '@axp/contracts';
import { apiRequest, ApiError } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import type { ThemeScopePath } from '@/lib/theming';
import type { AdminOutcome } from './outcome';

/**
 * Themes, entitlements and diagnostics (Phase 9): the writes. One API call
 * each; the API authorizes and validates everything again.
 */

async function run<T>(call: () => Promise<T>): Promise<AdminOutcome<T>> {
  try {
    const data = await call();
    revalidatePath('/admin', 'layout');
    return { status: 'ok', data };
  } catch (error) {
    if (error instanceof ApiError && error.body.code === 'reauthentication_required') {
      return { status: 'reauth' };
    }
    const resolved = await resolveError(error);
    return {
      status: 'error',
      message: resolved.message,
      ...(resolved.fieldErrors ? { fieldErrors: resolved.fieldErrors } : {}),
    };
  }
}

const theme = (path: ThemeScopePath) => `/themes/${path}`;

export async function saveThemeDraftAction(
  path: ThemeScopePath,
  input: { name: string; tokens: Record<string, string>; darkTokens: Record<string, string> },
): Promise<AdminOutcome<ThemeOverview>> {
  return run(() =>
    apiRequest<ThemeOverview>(`${theme(path)}/draft`, {
      method: 'PUT',
      body: input,
      authenticated: true,
    }),
  );
}

export async function discardThemeDraftAction(
  path: ThemeScopePath,
): Promise<AdminOutcome<ThemeOverview>> {
  return run(() =>
    apiRequest<ThemeOverview>(`${theme(path)}/draft`, { method: 'DELETE', authenticated: true }),
  );
}

export async function validateThemeAction(
  path: ThemeScopePath,
): Promise<AdminOutcome<ThemeValidation>> {
  return run(() =>
    apiRequest<ThemeValidation>(`${theme(path)}/validate`, {
      method: 'POST',
      body: {},
      authenticated: true,
    }),
  );
}

export async function publishThemeAction(
  path: ThemeScopePath,
): Promise<AdminOutcome<ThemeOverview>> {
  return run(() =>
    apiRequest<ThemeOverview>(`${theme(path)}/publish`, {
      method: 'POST',
      body: {},
      authenticated: true,
    }),
  );
}

export async function rollbackThemeAction(
  path: ThemeScopePath,
  version: number,
): Promise<AdminOutcome<ThemeOverview>> {
  return run(() =>
    apiRequest<ThemeOverview>(`${theme(path)}/rollback`, {
      method: 'POST',
      body: { version },
      authenticated: true,
    }),
  );
}

export async function setEntitlementAction(
  tenantId: string,
  entitlement: Entitlement,
  enabled: boolean,
): Promise<AdminOutcome<{ entitlements: EntitlementState[] }>> {
  return run(() =>
    apiRequest<{ entitlements: EntitlementState[] }>(
      `/admin/platform/tenants/${encodeURIComponent(tenantId)}/entitlements/${entitlement}`,
      { method: 'PUT', body: { enabled }, authenticated: true },
    ),
  );
}

export async function generateDiagnosticsAction(): Promise<
  AdminOutcome<DiagnosticArtifactSummary>
> {
  return run(() =>
    apiRequest<DiagnosticArtifactSummary>('/admin/platform/diagnostics', {
      method: 'POST',
      body: {},
      authenticated: true,
    }),
  );
}
