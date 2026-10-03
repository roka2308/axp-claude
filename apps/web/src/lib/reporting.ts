import 'server-only';
import type {
  AttentionOverview,
  ReportRecipient,
  ReportRunSummary,
  ReportScheduleOptions,
  ReportScheduleSummary,
} from '@axp/contracts';
import { apiRequest } from './api-client';

/** Reads for scheduled reports (Projekt → Reports) and the Attention Center. */

const reports = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/reports`;

export async function getReports(
  projectId: string,
): Promise<{ schedules: ReportScheduleSummary[]; options: ReportScheduleOptions }> {
  return apiRequest(reports(projectId), { authenticated: true });
}

export async function getReportRuns(
  projectId: string,
  scheduleId: string,
): Promise<ReportRunSummary[]> {
  const result = await apiRequest<{ runs: ReportRunSummary[] }>(
    `${reports(projectId)}/${encodeURIComponent(scheduleId)}/runs`,
    { authenticated: true },
  );
  return result.runs;
}

export async function getReportRecipients(
  projectId: string,
  dashboardId: string,
): Promise<ReportRecipient[]> {
  const result = await apiRequest<{ recipients: ReportRecipient[] }>(
    `${reports(projectId)}/recipients?dashboardId=${encodeURIComponent(dashboardId)}`,
    { authenticated: true },
  );
  return result.recipients;
}

export async function getAttention(): Promise<AttentionOverview> {
  return apiRequest<AttentionOverview>('/attention', { authenticated: true });
}
