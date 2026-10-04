/**
 * Entitlements and feature flags (Master Spec §23, Shared Contract §14).
 *
 * Three different questions, answered by three different checks:
 *
 *   - Authorization: may this person do it? (roles, scopes, grants)
 *   - Entitlement: does this customer have the module? (per tenant)
 *   - Feature flag: is the function rolled out in this installation? (config)
 *
 * No billing, no licence server, no phone-home. Losing an entitlement never
 * deletes configuration: schedules, shares and themes stay as they were and
 * work again when the module is back.
 */
export const ENTITLEMENTS = [
  'reporting.scheduled',
  'sharing.external',
  'solutions.packages',
  'theming.custom',
] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

export interface EntitlementState {
  readonly entitlement: Entitlement;
  readonly enabled: boolean;
  /** Null while the deployment default applies. */
  readonly changedAt: string | null;
  readonly changedBy: string | null;
}

/** Technical rollout switches of this installation, from its configuration. */
export const FEATURE_FLAGS = ['reports.pptx'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export interface FeatureFlagState {
  readonly flag: FeatureFlag;
  readonly enabled: boolean;
  /** The configuration variable that decides it. */
  readonly setting: string;
}
