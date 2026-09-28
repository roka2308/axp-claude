import 'server-only';
import type {
  SolutionCatalogEntry,
  SolutionInstallationSummary,
  TemplateKind,
  TemplateSummary,
} from '@axp/contracts';
import { apiRequest } from './api-client';

/**
 * Solutions and templates (D7): reads for the "Vorlagen" area.
 *
 * Every call goes through the API with the caller's session; which templates
 * and solutions a project offers is the server's answer, never recomputed here.
 */

export async function getSolutionCatalog(): Promise<SolutionCatalogEntry[]> {
  return (
    await apiRequest<{ solutions: SolutionCatalogEntry[] }>('/solutions/catalog', {
      authenticated: true,
    })
  ).solutions;
}

export async function listInstallations(projectId: string): Promise<SolutionInstallationSummary[]> {
  return (
    await apiRequest<{ installations: SolutionInstallationSummary[] }>(
      `/projects/${encodeURIComponent(projectId)}/solutions`,
      { authenticated: true },
    )
  ).installations;
}

export async function listTemplates(
  projectId: string,
  kind?: TemplateKind,
): Promise<TemplateSummary[]> {
  const query = kind ? `?kind=${kind}` : '';
  return (
    await apiRequest<{ templates: TemplateSummary[] }>(
      `/projects/${encodeURIComponent(projectId)}/templates${query}`,
      { authenticated: true },
    )
  ).templates;
}

export interface CreationOptions {
  readonly tenants: readonly {
    readonly id: string;
    readonly name: string;
    readonly connections: readonly { id: string; name: string; status: string }[];
    readonly sites: readonly {
      id: string;
      name: string;
      timezone: string;
      connectionName: string;
      usedByProjects: number;
    }[];
  }[];
}

export function getCreationOptions(): Promise<CreationOptions> {
  return apiRequest<CreationOptions>('/projects/creation-options', { authenticated: true });
}
