'use server';

import { revalidatePath } from 'next/cache';
import type {
  ReportRecipient,
  ReportRunSummary,
  ReportScheduleInput,
  ReportScheduleSummary,
} from '@axp/contracts';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';
import type { AdminOutcome as Outcome } from '@/app/admin/outcome';

/**
 * Scheduled reports (Projekt → Reports): the writes. The API validates
 * everything - dashboard, time zone, every recipient's access - again on its
 * own; nothing here decides who may receive what.
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

const reports = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/reports`;
const page = (projectId: string) => `/projects/${projectId}/reports`;

export async function recipientsAction(
  projectId: string,
  dashboardId: string,
): Promise<Outcome<ReportRecipient[]>> {
  return run(async () => {
    const result = await apiRequest<{ recipients: ReportRecipient[] }>(
      `${reports(projectId)}/recipients?dashboardId=${encodeURIComponent(dashboardId)}`,
      { authenticated: true },
    );
    return result.recipients;
  });
}

export async function saveReportAction(
  projectId: string,
  scheduleId: string | null,
  input: ReportScheduleInput,
): Promise<Outcome<ReportScheduleSummary>> {
  const outcome = await run(() =>
    apiRequest<ReportScheduleSummary>(
      scheduleId ? `${reports(projectId)}/${encodeURIComponent(scheduleId)}` : reports(projectId),
      { method: scheduleId ? 'PUT' : 'POST', body: input, authenticated: true },
    ),
  );
  revalidatePath(page(projectId));
  return outcome;
}

export async function pauseReportAction(
  projectId: string,
  scheduleId: string,
  paused: boolean,
): Promise<Outcome<ReportScheduleSummary>> {
  const outcome = await run(() =>
    apiRequest<ReportScheduleSummary>(
      `${reports(projectId)}/${encodeURIComponent(scheduleId)}/pause`,
      {
        method: 'POST',
        body: { paused },
        authenticated: true,
      },
    ),
  );
  revalidatePath(page(projectId));
  return outcome;
}

export async function deleteReportAction(projectId: string, scheduleId: string): Promise<Outcome> {
  const outcome = await run(() =>
    apiRequest<void>(`${reports(projectId)}/${encodeURIComponent(scheduleId)}`, {
      method: 'DELETE',
      authenticated: true,
    }),
  );
  revalidatePath(page(projectId));
  return outcome.status === 'ok' ? { status: 'ok' } : outcome;
}

export async function runReportNowAction(
  projectId: string,
  scheduleId: string,
): Promise<Outcome<ReportRunSummary>> {
  const outcome = await run(() =>
    apiRequest<ReportRunSummary>(`${reports(projectId)}/${encodeURIComponent(scheduleId)}/run`, {
      method: 'POST',
      body: {},
      authenticated: true,
    }),
  );
  revalidatePath(page(projectId));
  return outcome;
}
