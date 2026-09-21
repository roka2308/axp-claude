import 'server-only';
import type {
  BindingHealth,
  SemanticDefinitionBody,
  SemanticDefinitionRef,
  SemanticVersionRef,
  SourceBindingRef,
} from '@axp/contracts';
import { apiRequest } from './api-client';

/**
 * Semantic catalog reads.
 *
 * Writes go through Server Actions rather than through here, because they are
 * form submissions and need the same error handling the rest of the app uses.
 */

export async function listDefinitions(projectId: string): Promise<SemanticDefinitionRef[]> {
  const { definitions } = await apiRequest<{ definitions: SemanticDefinitionRef[] }>(
    `/projects/${encodeURIComponent(projectId)}/semantic-definitions`,
    { authenticated: true },
  );
  return definitions;
}

export async function listDefinitionVersions(
  projectId: string,
  definitionId: string,
): Promise<SemanticVersionRef[]> {
  const { versions } = await apiRequest<{ versions: SemanticVersionRef[] }>(
    `/projects/${encodeURIComponent(projectId)}/semantic-definitions/${encodeURIComponent(definitionId)}/versions`,
    { authenticated: true },
  );
  return versions;
}

export async function listBindings(projectId: string): Promise<SourceBindingRef[]> {
  const { bindings } = await apiRequest<{ bindings: SourceBindingRef[] }>(
    `/projects/${encodeURIComponent(projectId)}/source-bindings`,
    { authenticated: true },
  );
  return bindings;
}

export interface BindingHealthReport {
  readonly health: readonly BindingHealth[];
  /** What the site currently offers, so a mapping can be made from real names. */
  readonly available: { readonly metrics: string[]; readonly dimensions: string[] };
}

export async function getBindingHealth(projectId: string): Promise<BindingHealthReport> {
  try {
    return await apiRequest<BindingHealthReport>(
      `/projects/${encodeURIComponent(projectId)}/source-bindings/health`,
      { authenticated: true },
    );
  } catch {
    // The site may be unreachable. A drift check that cannot run is not a
    // broken page: it simply has nothing to report yet.
    return { health: [], available: { metrics: [], dimensions: [] } };
  }
}

/** The active version of every definition, for showing what each one means. */
export async function describeActiveVersions(
  projectId: string,
  definitions: readonly SemanticDefinitionRef[],
): Promise<Map<string, SemanticVersionRef>> {
  const withVersions = definitions.filter((definition) => definition.currentVersionId);

  const resolved = await Promise.all(
    withVersions.map(async (definition) => {
      const versions = await listDefinitionVersions(projectId, definition.id);
      return [definition.id, versions.find((version) => version.status === 'active')] as const;
    }),
  );

  return new Map(
    resolved.filter((entry): entry is [string, SemanticVersionRef] => Boolean(entry[1])),
  );
}

export type { SemanticDefinitionBody };
