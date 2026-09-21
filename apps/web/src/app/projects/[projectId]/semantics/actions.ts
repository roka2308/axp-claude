'use server';

import { revalidatePath } from 'next/cache';
import type {
  SemanticDefinitionBody,
  SemanticVersionRef,
  SemanticLifecycle,
  SourceBindingDescriptor,
  ValueEnvelope,
} from '@axp/contracts';
import { apiRequest } from '@/lib/api-client';
import { resolveError } from '@/lib/error-messages';

/**
 * Catalog writes (Master Spec §13).
 *
 * Failures come back as values. A builder is a place where people try things
 * out, and "that formula does not combine" is an expected answer rather than
 * an error page.
 */

export interface CatalogOutcome {
  readonly status: 'idle' | 'saved' | 'error';
  readonly message?: string;
  readonly action?: string;
  readonly definitionId?: string;
}

export async function createDefinitionAction(
  projectId: string,
  input: {
    portableId: string;
    type: 'custom_metric' | 'formula' | 'score';
    name: string;
    description?: string;
    body: SemanticDefinitionBody;
  },
): Promise<CatalogOutcome> {
  try {
    const created = await apiRequest<{ definition: { id: string } }>(
      `/projects/${encodeURIComponent(projectId)}/semantic-definitions`,
      { method: 'POST', body: input, authenticated: true },
    );

    revalidatePath(`/projects/${projectId}/semantics`);
    return { status: 'saved', definitionId: created.definition.id };
  } catch (error) {
    return failure(error);
  }
}

export async function addVersionAction(
  projectId: string,
  definitionId: string,
  body: SemanticDefinitionBody,
): Promise<CatalogOutcome> {
  try {
    await apiRequest(
      `/projects/${encodeURIComponent(projectId)}/semantic-definitions/${encodeURIComponent(definitionId)}/versions`,
      { method: 'POST', body: { body }, authenticated: true },
    );

    revalidatePath(`/projects/${projectId}/semantics`);
    return { status: 'saved', definitionId };
  } catch (error) {
    return failure(error);
  }
}

/** Version history, loaded when somebody asks for it rather than up front. */
export async function listVersionsAction(
  projectId: string,
  definitionId: string,
): Promise<SemanticVersionRef[]> {
  try {
    const { versions } = await apiRequest<{ versions: SemanticVersionRef[] }>(
      `/projects/${encodeURIComponent(projectId)}/semantic-definitions/${encodeURIComponent(definitionId)}/versions`,
      { authenticated: true },
    );
    return versions;
  } catch {
    // A history that cannot be loaded is an empty panel, not a broken page.
    return [];
  }
}

export async function changeVersionStatusAction(
  projectId: string,
  definitionId: string,
  versionId: string,
  to: SemanticLifecycle,
): Promise<CatalogOutcome> {
  try {
    await apiRequest(
      `/projects/${encodeURIComponent(projectId)}/semantic-definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/status`,
      { method: 'POST', body: { to }, authenticated: true },
    );

    revalidatePath(`/projects/${projectId}/semantics`);
    return { status: 'saved', definitionId };
  } catch (error) {
    return failure(error);
  }
}

export interface PreviewOutcome {
  readonly status: 'ok' | 'error';
  readonly value?: ValueEnvelope;
  readonly trace?: readonly { label: string; value: ValueEnvelope }[];
  readonly inputs?: readonly {
    semanticVersionId: string;
    name: string;
    value: ValueEnvelope | null;
  }[];
  readonly message?: string;
}

/**
 * Evaluates a candidate definition without storing it (D6).
 *
 * The question a builder has to answer before anyone commits: what would this
 * actually produce on real data?
 */
export async function previewAction(
  projectId: string,
  body: SemanticDefinitionBody,
  siteId: string,
): Promise<PreviewOutcome> {
  try {
    const result = await apiRequest<Omit<PreviewOutcome, 'status'>>(
      `/projects/${encodeURIComponent(projectId)}/semantic-definitions/preview`,
      { method: 'POST', body: { body, siteId }, authenticated: true },
    );
    return { status: 'ok', ...result };
  } catch (error) {
    const resolved = await resolveError(error);
    return { status: 'error', message: resolved.message };
  }
}

export async function setBindingAction(
  projectId: string,
  requirementKey: string,
  binding: SourceBindingDescriptor,
): Promise<CatalogOutcome> {
  try {
    await apiRequest(`/projects/${encodeURIComponent(projectId)}/source-bindings`, {
      method: 'PUT',
      body: { requirementKey, siteId: null, binding },
      authenticated: true,
    });

    revalidatePath(`/projects/${projectId}/semantics`);
    return { status: 'saved' };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Records that somebody looked at a drifting mapping and accepted it.
 *
 * Separate from `setBindingAction` on purpose. Repointing a mapping and
 * accepting that there is nothing to point at are different answers to the
 * same warning, and neither one creates a semantic version (Gate F3).
 */
export async function reviewBindingAction(
  projectId: string,
  requirementKey: string,
): Promise<CatalogOutcome> {
  try {
    await apiRequest(
      `/projects/${encodeURIComponent(projectId)}/source-bindings/${encodeURIComponent(requirementKey)}/review`,
      { method: 'POST', body: {}, authenticated: true },
    );

    revalidatePath(`/projects/${projectId}/semantics`);
    return { status: 'saved' };
  } catch (error) {
    return failure(error);
  }
}

async function failure(error: unknown): Promise<CatalogOutcome> {
  const resolved = await resolveError(error);
  return {
    status: 'error',
    message: resolved.message,
    ...(resolved.action ? { action: resolved.action } : {}),
  };
}
