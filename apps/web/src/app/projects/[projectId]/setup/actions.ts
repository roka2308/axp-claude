'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { resolveError } from '@/lib/error-messages';
import {
  assignSite,
  createConnection,
  createDashboard,
  refreshCapabilities,
  testConnection,
} from '@/lib/matomo';
import { getProject } from '@/lib/analytics';
import type { SetupFormState } from './state';

/**
 * Project setup (Master Spec §13).
 *
 * One action per step rather than a single wizard submit, because setup is
 * resumable: each step commits on its own and the checklist reflects what is
 * actually configured, in whatever order it happened.
 *
 * The tenant is resolved from the project on the server in every action. The
 * browser supplies a project id and nothing else; it never names the tenant it
 * would like to write to (Shared Contract §4).
 */

/**
 * Tests or saves a Matomo connection, depending on which button was pressed.
 *
 * Testing is its own outcome on purpose: a wrong URL or a token without the
 * necessary access should be visible before a connection exists, not afterwards
 * as a failing row somebody has to clean up.
 */
export async function submitConnectionAction(
  projectId: string,
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const t = await getTranslations('errors');
  const values = {
    name: String(formData.get('name') ?? '').trim(),
    baseUrl: String(formData.get('baseUrl') ?? '').trim(),
    token: String(formData.get('token') ?? '').trim(),
  };
  const echo = { name: values.name, baseUrl: values.baseUrl };

  const fieldErrors: Record<string, string> = {};
  if (!values.name) fieldErrors.name = t('required');
  if (!values.baseUrl) fieldErrors.baseUrl = t('required');
  if (!values.token) fieldErrors.token = t('required');
  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', fieldErrors, values: echo };
  }

  try {
    const tenantId = await tenantOf(projectId);

    if (formData.get('intent') === 'test') {
      return { status: 'tested', test: await testConnection(tenantId, values), values: echo };
    }

    const created = await createConnection(tenantId, values);
    revalidateSetup(projectId);
    return {
      status: 'saved',
      test: {
        reachable: true,
        authenticated: true,
        matomoVersion: created.capabilities.matomoVersion,
        compatibility: created.capabilities.compatibility,
        probes: created.capabilities.probes,
        limitationKeys: created.capabilities.limitationKeys,
      },
    };
  } catch (error) {
    return failure(error, echo);
  }
}

export async function refreshCapabilitiesAction(
  projectId: string,
  connectionId: string,
  _formData?: FormData,
): Promise<void> {
  const tenantId = await tenantOf(projectId);
  await refreshCapabilities(tenantId, connectionId);
  revalidateSetup(projectId);
}

export async function assignSiteAction(
  projectId: string,
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  // One control chooses across every connection, so the option value carries
  // both parts: `<connectionId>:<matomoSiteId>`.
  const [connectionId, rawSiteId] = String(formData.get('site') ?? '').split(':');
  const matomoSiteId = Number(rawSiteId);

  if (!connectionId || !Number.isInteger(matomoSiteId) || matomoSiteId <= 0) {
    const t = await getTranslations('errors');
    return { status: 'error', fieldErrors: { site: t('required') } };
  }

  try {
    await assignSite(projectId, connectionId, matomoSiteId);
    revalidateSetup(projectId);
    return { status: 'saved' };
  } catch (error) {
    return failure(error, {});
  }
}

export async function createDashboardAction(
  projectId: string,
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  const t = await getTranslations('errors');
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const siteId = String(formData.get('siteId') ?? '');

  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = t('required');
  if (!siteId) fieldErrors.siteId = t('required');
  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', fieldErrors, values: { name, description } };
  }

  try {
    await createDashboard(projectId, { name, siteId, ...(description ? { description } : {}) });
    revalidateSetup(projectId);
    return { status: 'saved', values: { name } };
  } catch (error) {
    return failure(error, { name, description });
  }
}

// --- shared ----------------------------------------------------------------

async function tenantOf(projectId: string): Promise<string> {
  const detail = await getProject(projectId);
  return detail.project.tenantId;
}

function revalidateSetup(projectId: string): void {
  revalidatePath(`/projects/${projectId}/setup`);
  revalidatePath(`/projects/${projectId}`);
}

/**
 * Turns a failure into form state.
 *
 * `values` never carries the token. Everything in `SetupFormState` is
 * serialised into the page, and a credential echoed back into a form value
 * would be a credential in the browser.
 */
async function failure(error: unknown, values: Record<string, string>): Promise<SetupFormState> {
  const resolved = await resolveError(error);
  return {
    status: 'error',
    message: resolved.message,
    ...(resolved.action ? { action: resolved.action } : {}),
    ...(resolved.correlationId ? { correlationId: resolved.correlationId } : {}),
    ...(resolved.fieldErrors ? { fieldErrors: resolved.fieldErrors } : {}),
    values,
  };
}
