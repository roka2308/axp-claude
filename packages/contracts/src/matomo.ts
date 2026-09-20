import { z } from 'zod';
import type { MatomoCompatibility } from './lifecycle.js';

/**
 * Matomo support model (Master Spec §22, Gap Review G3).
 *
 * Compatibility is decided by probing what an installation can actually do,
 * never by its version string alone. Runtime capability detection and the
 * maintained support matrix are separate concepts; this file covers detection.
 */

/**
 * Capabilities the platform probes for.
 *
 * `technical` must all hold for a connection to be usable at all. `core`
 * capabilities back the MVP use cases: a missing one blocks the affected use
 * case, not the whole connection. `optional` capabilities degrade gracefully.
 */
export const TECHNICAL_CAPABILITIES = [
  'url_reachable',
  'tls_valid',
  'auth_valid',
  'api_parseable',
  'version_parseable',
] as const;

export const CORE_CAPABILITIES = [
  'sites_listing',
  'visits',
  'pageviews',
  'time_series',
  'page_ranking',
  'site_timezone',
] as const;

export const OPTIONAL_CAPABILITIES = [
  'events',
  'custom_dimensions',
  'segments',
  'site_search',
  'goals',
  'ecommerce',
] as const;

export const MATOMO_CAPABILITIES = [
  ...TECHNICAL_CAPABILITIES,
  ...CORE_CAPABILITIES,
  ...OPTIONAL_CAPABILITIES,
] as const;

export const matomoCapabilitySchema = z.enum(MATOMO_CAPABILITIES);
export type MatomoCapability = z.infer<typeof matomoCapabilitySchema>;

export type CapabilityTier = 'technical' | 'core' | 'optional';

export function capabilityTier(capability: MatomoCapability): CapabilityTier {
  if ((TECHNICAL_CAPABILITIES as readonly string[]).includes(capability)) return 'technical';
  if ((CORE_CAPABILITIES as readonly string[]).includes(capability)) return 'core';
  return 'optional';
}

export const CAPABILITY_STATES = ['available', 'unavailable', 'unknown'] as const;
export const capabilityStateSchema = z.enum(CAPABILITY_STATES);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export interface CapabilityProbeResult {
  readonly capability: MatomoCapability;
  readonly state: CapabilityState;
  /** i18n key explaining a negative result. Never a raw vendor message. */
  readonly detailKey?: string;
}

/**
 * What a connection can do, as observed at `detectedAt`.
 *
 * May be stored (Master Spec §22) because it contains no analytics results:
 * only capability flags, version and site metadata.
 */
export interface MatomoCapabilityFingerprint {
  readonly connectionId: string;
  readonly detectedAt: string;
  readonly matomoVersion: string | null;
  readonly compatibility: MatomoCompatibility;
  readonly probes: readonly CapabilityProbeResult[];
  /** i18n keys describing what will not work, for the setup summary. */
  readonly limitationKeys: readonly string[];
  readonly siteCount: number | null;
}

export function hasCapability(
  fingerprint: MatomoCapabilityFingerprint,
  capability: MatomoCapability,
): boolean {
  return fingerprint.probes.some(
    (probe) => probe.capability === capability && probe.state === 'available',
  );
}

/**
 * Derives the compatibility state from probe results.
 *
 * The four states are decided by what is missing, never by the version:
 *   - any technical probe failing makes the connection unsupported;
 *   - a missing core capability means "supported with limitations", because the
 *     connection still serves the use cases that do not need it;
 *   - an unreadable version means "technically compatible, not yet certified":
 *     it works, but it is outside the tested support matrix.
 */
export function deriveCompatibility(
  probes: readonly CapabilityProbeResult[],
  options: { readonly versionCertified: boolean },
): MatomoCompatibility {
  const failed = (tier: CapabilityTier) =>
    probes.some(
      (probe) => capabilityTier(probe.capability) === tier && probe.state !== 'available',
    );

  if (failed('technical')) return 'unsupported';
  if (failed('core')) return 'supported_with_limitations';
  if (!options.versionCertified) return 'technically_compatible_not_certified';
  return 'supported';
}

export interface ConnectionTestInput {
  readonly baseUrl: string;
  /** Matomo `token_auth`. Never leaves the server. */
  readonly token: string;
}

export interface ConnectionTestResult {
  readonly reachable: boolean;
  readonly authenticated: boolean;
  readonly matomoVersion: string | null;
  readonly compatibility: MatomoCompatibility;
  readonly probes: readonly CapabilityProbeResult[];
  readonly limitationKeys: readonly string[];
  /** i18n key for a failure the user can act on, e.g. a wrong URL. */
  readonly errorKey?: string;
}

/** Site metadata, without any analytics values. */
export interface MatomoSiteSummary {
  /** Matomo's own numeric site id. */
  readonly matomoSiteId: number;
  readonly name: string;
  readonly mainUrl: string | null;
  /** IANA time zone; authoritative for the analytics calendar. */
  readonly timezone: string;
  readonly currency: string | null;
  readonly ecommerceEnabled: boolean;
}

export interface MatomoMetadataSnapshot {
  readonly siteId: string;
  readonly refreshedAt: string;
  readonly site: MatomoSiteSummary;
  /** Metric and dimension names the site exposes, for mapping. */
  readonly availableMetrics: readonly string[];
  readonly availableDimensions: readonly string[];
}
