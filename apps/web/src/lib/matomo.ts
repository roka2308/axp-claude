import 'server-only';
import type {
  ConnectionTestResult,
  MatomoCapabilityFingerprint,
  MatomoSiteSummary,
} from '@axp/contracts';
import { apiRequest } from './api-client';

/**
 * Matomo connections and sites, as the setup surfaces need them.
 *
 * Note what is absent: there is no function that reads a credential back. The
 * token travels one way - from the form, through this process, into the API,
 * where it is sealed (Master Spec §19).
 */

/** A connection as the product describes it. Deliberately without the token. */
export interface ConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly status: string;
  readonly lastTestedAt: string | null;
  readonly hasCredential: boolean;
}

export interface ConnectionWithCapabilities extends ConnectionSummary {
  readonly capabilities: MatomoCapabilityFingerprint | null;
}

export async function listConnections(tenantId: string): Promise<ConnectionWithCapabilities[]> {
  const result = await apiRequest<{ connections: ConnectionWithCapabilities[] }>(
    `/tenants/${encodeURIComponent(tenantId)}/matomo-connections`,
    { authenticated: true },
  );
  return result.connections;
}

export async function listRemoteSites(
  tenantId: string,
  connectionId: string,
): Promise<MatomoSiteSummary[]> {
  const result = await apiRequest<{ sites: MatomoSiteSummary[] }>(
    `/tenants/${encodeURIComponent(tenantId)}/matomo-connections/${encodeURIComponent(connectionId)}/sites`,
    { authenticated: true },
  );
  return result.sites;
}

export interface ConnectionInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
}

/** Probes a connection without storing anything, so setup can fail before it commits. */
export function testConnection(
  tenantId: string,
  input: ConnectionInput,
): Promise<ConnectionTestResult> {
  return apiRequest<ConnectionTestResult>(
    `/tenants/${encodeURIComponent(tenantId)}/matomo-connections/test`,
    { method: 'POST', body: input, authenticated: true },
  );
}

export function createConnection(
  tenantId: string,
  input: ConnectionInput,
): Promise<{ connection: ConnectionSummary; capabilities: MatomoCapabilityFingerprint }> {
  return apiRequest(`/tenants/${encodeURIComponent(tenantId)}/matomo-connections`, {
    method: 'POST',
    body: input,
    authenticated: true,
  });
}

export function refreshCapabilities(
  tenantId: string,
  connectionId: string,
): Promise<MatomoCapabilityFingerprint> {
  return apiRequest(
    `/tenants/${encodeURIComponent(tenantId)}/matomo-connections/${encodeURIComponent(connectionId)}/refresh-capabilities`,
    { method: 'POST', authenticated: true },
  );
}

export function assignSite(
  projectId: string,
  connectionId: string,
  matomoSiteId: number,
): Promise<{ siteId: string }> {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/sites`, {
    method: 'POST',
    body: { connectionId, matomoSiteId },
    authenticated: true,
  });
}

export function createDashboard(
  projectId: string,
  input: { name: string; description?: string; siteId: string },
): Promise<{ dashboardId: string; revisionId: string }> {
  return apiRequest(`/projects/${encodeURIComponent(projectId)}/dashboards`, {
    method: 'POST',
    body: input,
    authenticated: true,
  });
}

export function publishDashboard(dashboardId: string): Promise<{ version: number }> {
  return apiRequest(`/dashboards/${encodeURIComponent(dashboardId)}/publish`, {
    method: 'POST',
    authenticated: true,
  });
}
