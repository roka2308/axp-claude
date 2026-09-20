import 'server-only';
import type {
  Capability,
  ComparisonMode,
  DashboardPresentation,
  DashboardRef,
  SetupReadiness,
  TimeRangePreset,
} from '@axp/contracts';
import { apiRequest } from './api-client';

/**
 * Typed reads for the project and dashboard surfaces.
 *
 * Every call runs on the Next.js server with the caller's session token; the
 * browser never talks to the API directly.
 */

export interface ProjectSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly timezone: string;
  readonly setupState: SetupReadiness;
}

export interface SetupStep {
  readonly key: string;
  readonly state: 'open' | 'in_progress' | 'done' | 'review_required' | 'not_relevant';
  readonly required: boolean;
  readonly detail?: string;
}

export interface ProjectSite {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly mainUrl: string | null;
  readonly matomoSiteId: number;
  readonly connectionId: string;
  readonly isPrimary: boolean;
}

export interface ProjectDetail {
  readonly project: ProjectSummary;
  readonly setup: {
    readonly projectId: string;
    readonly readiness: SetupReadiness;
    readonly steps: readonly SetupStep[];
  };
  readonly sites: readonly ProjectSite[];
  /**
   * What the caller may do here, decided by the server.
   *
   * The web app hides what it is not offered and never re-derives a decision;
   * every write is authorized again on the server anyway.
   */
  readonly capabilities: readonly Capability[];
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const result = await apiRequest<{ projects: ProjectSummary[] }>('/projects', {
    authenticated: true,
  });
  return result.projects;
}

export async function getProject(projectId: string): Promise<ProjectDetail> {
  return apiRequest<ProjectDetail>(`/projects/${encodeURIComponent(projectId)}`, {
    authenticated: true,
  });
}

export async function listDashboards(projectId: string): Promise<DashboardRef[]> {
  const result = await apiRequest<{ dashboards: DashboardRef[] }>(
    `/projects/${encodeURIComponent(projectId)}/dashboards`,
    { authenticated: true },
  );
  return result.dashboards;
}

export interface PresentationQuery {
  readonly timeRange: TimeRangePreset;
  readonly comparison: ComparisonMode;
  readonly breakpoint?: 'desktop' | 'tablet' | 'mobile';
  readonly source?: 'published' | 'draft';
}

export async function getPresentation(
  dashboardId: string,
  query: PresentationQuery,
): Promise<DashboardPresentation> {
  const search = new URLSearchParams({
    timeRange: query.timeRange,
    comparison: query.comparison,
    breakpoint: query.breakpoint ?? 'desktop',
    source: query.source ?? 'published',
  });

  return apiRequest<DashboardPresentation>(
    `/dashboards/${encodeURIComponent(dashboardId)}/presentation?${search.toString()}`,
    { authenticated: true },
  );
}
