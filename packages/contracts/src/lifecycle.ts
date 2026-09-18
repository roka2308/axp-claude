import { z } from 'zod';

/** Tenant lifecycle: provisioning -> active <-> suspended -> offboarding -> deleted (§5). */
export const TENANT_LIFECYCLE_STATES = [
  'provisioning',
  'active',
  'suspended',
  'offboarding',
  'deleted',
] as const;
export const tenantLifecycleSchema = z.enum(TENANT_LIFECYCLE_STATES);
export type TenantLifecycle = z.infer<typeof tenantLifecycleSchema>;

const TENANT_TRANSITIONS: Readonly<Record<TenantLifecycle, readonly TenantLifecycle[]>> = {
  provisioning: ['active', 'deleted'],
  active: ['suspended', 'offboarding'],
  suspended: ['active', 'offboarding'],
  offboarding: ['deleted'],
  deleted: [],
};

export function canTransitionTenant(from: TenantLifecycle, to: TenantLifecycle): boolean {
  return TENANT_TRANSITIONS[from].includes(to);
}

/**
 * States in which normal customer-facing processing stops: user access,
 * analytics queries, external shares, scheduled reports and customer jobs (§5).
 * Configuration is retained.
 */
export function tenantProcessingHalted(state: TenantLifecycle): boolean {
  return state === 'suspended' || state === 'offboarding' || state === 'deleted';
}

/** Dashboard lifecycle (§21). Published is never edited live. */
export const DASHBOARD_LIFECYCLE_STATES = [
  'draft',
  'preview',
  'published',
  'archived',
  'trash',
] as const;
export const dashboardLifecycleSchema = z.enum(DASHBOARD_LIFECYCLE_STATES);
export type DashboardLifecycle = z.infer<typeof dashboardLifecycleSchema>;

/** Semantic definition lifecycle (§13). Referenced objects are never hard deleted. */
export const SEMANTIC_LIFECYCLE_STATES = ['draft', 'active', 'deprecated', 'archived'] as const;
export const semanticLifecycleSchema = z.enum(SEMANTIC_LIFECYCLE_STATES);
export type SemanticLifecycle = z.infer<typeof semanticLifecycleSchema>;

/** Account lifecycle (§6). Deactivation replaces hard delete in normal admin flows. */
export const USER_STATUSES = ['invited', 'active', 'deactivated'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** Platform initialization state (§6, G4). No default accounts, no default passwords. */
export const PLATFORM_INIT_STATES = ['uninitialized', 'initialized'] as const;
export const platformInitStateSchema = z.enum(PLATFORM_INIT_STATES);
export type PlatformInitState = z.infer<typeof platformInitStateSchema>;

/** Matomo compatibility states (§13, G3). Never derived from version alone. */
export const MATOMO_COMPATIBILITY_STATES = [
  'supported',
  'supported_with_limitations',
  'technically_compatible_not_certified',
  'unsupported',
] as const;
export const matomoCompatibilitySchema = z.enum(MATOMO_COMPATIBILITY_STATES);
export type MatomoCompatibility = z.infer<typeof matomoCompatibilitySchema>;

/** Deployment profiles served by one build, no customer code forks (§5). */
export const DEPLOYMENT_PROFILES = [
  'central_multi_tenant',
  'dedicated_single_customer',
  'customer_hosted',
] as const;
export const deploymentProfileSchema = z.enum(DEPLOYMENT_PROFILES);
export type DeploymentProfile = z.infer<typeof deploymentProfileSchema>;

export const SUPPORTED_LOCALES = ['de', 'en'] as const;
export const localeSchema = z.enum(SUPPORTED_LOCALES);
export type Locale = z.infer<typeof localeSchema>;
export const DEFAULT_LOCALE: Locale = 'de';
