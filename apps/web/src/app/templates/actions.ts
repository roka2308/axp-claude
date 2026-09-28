'use server';

import { revalidatePath } from 'next/cache';
import type {
  PackageAnalysis,
  SolutionInstallRequest,
  SolutionInstallResult,
  SolutionPackage,
  ValueEnvelope,
  WidgetConfig,
} from '@axp/contracts';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import type { AdminOutcome as Outcome } from '@/app/admin/outcome';

/**
 * Solutions and templates (D7): writes and the install flow's questions.
 *
 * Each action is one API call. The package travels as data - an upload is the
 * parsed JSON the person chose, and the API validates it before looking at
 * anything inside. Nothing about it is trusted because it came from here.
 */

export type PackageSourceInput =
  { catalog: { packageId: string; packageVersion?: string } } | { upload: unknown };

const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

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

export async function analyzeSolutionAction(
  projectId: string,
  source: PackageSourceInput,
): Promise<Outcome<PackageAnalysis>> {
  return run(() =>
    apiRequest<PackageAnalysis>(`${project(projectId)}/solutions/analyze`, {
      method: 'POST',
      body: { source },
      authenticated: true,
    }),
  );
}

export async function installSolutionAction(
  projectId: string,
  source: PackageSourceInput,
  request: SolutionInstallRequest,
): Promise<Outcome<SolutionInstallResult>> {
  const outcome = await run(() =>
    apiRequest<SolutionInstallResult>(`${project(projectId)}/solutions/install`, {
      method: 'POST',
      body: { source, request },
      authenticated: true,
    }),
  );
  if (outcome.status === 'ok') {
    revalidatePath('/templates');
    revalidatePath(`/projects/${projectId}`, 'layout');
  }
  return outcome;
}

export async function mappingPreviewAction(
  projectId: string,
  sourceMetric: string,
): Promise<Outcome<{ value: ValueEnvelope | null }>> {
  return run(() =>
    apiRequest<{ value: ValueEnvelope | null }>(`${project(projectId)}/solutions/mapping-preview`, {
      method: 'POST',
      body: { sourceMetric },
      authenticated: true,
    }),
  );
}

export async function createDashboardFromTemplateAction(
  projectId: string,
  templateId: string,
  name?: string,
): Promise<Outcome<{ dashboardId: string }>> {
  const outcome = await run(() =>
    apiRequest<{ dashboardId: string }>(
      `${project(projectId)}/templates/${encodeURIComponent(templateId)}/dashboards`,
      {
        method: 'POST',
        body: name ? { name } : {},
        authenticated: true,
      },
    ),
  );
  if (outcome.status === 'ok') revalidatePath('/dashboards');
  return outcome;
}

export async function resolveWidgetTemplateAction(
  projectId: string,
  templateId: string,
): Promise<Outcome<{ widget: WidgetConfig }>> {
  return run(() =>
    apiRequest<{ widget: WidgetConfig }>(
      `${project(projectId)}/templates/${encodeURIComponent(templateId)}/widget`,
      { authenticated: true },
    ),
  );
}

export async function exportSolutionAction(
  projectId: string,
  input: {
    dashboardIds: string[];
    packageId: string;
    packageVersion: string;
    name: string;
    publisher: string;
  },
): Promise<Outcome<{ package: SolutionPackage }>> {
  return run(() =>
    apiRequest<{ package: SolutionPackage }>(`${project(projectId)}/solutions/export`, {
      method: 'POST',
      body: input,
      authenticated: true,
    }),
  );
}
