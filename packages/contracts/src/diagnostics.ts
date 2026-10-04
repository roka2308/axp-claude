/**
 * Release metadata and diagnostics (Master Spec §24).
 *
 * What an operator needs to understand an installation - versions, health,
 * compatibility, job states, error codes - and nothing that belongs to its
 * customers: no analytics payloads, no secrets, tokens, passwords or
 * sessions, no search terms or custom dimension values, no sensitive URLs, no
 * unnecessary personal data.
 */

/** Support status of a release (Master Spec §24); durations are on hold. */
export const SUPPORT_STATUSES = ['current', 'maintenance', 'end_of_support'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export interface ReleaseInfo {
  readonly productVersion: string;
  readonly schemaVersion: string;
  readonly commit: string;
  readonly builtAt: string;
  readonly supportStatus: SupportStatus;
  readonly deploymentProfile: string;
  readonly appEnv: string;
  readonly nodeVersion: string;
  /** Applied database migrations - with the schema version, proof the store matches the build. */
  readonly appliedMigrations: number;
  readonly lastMigrationAt: string | null;
}

export interface CompatibilityInfo {
  /** Package schema versions this release can install. */
  readonly solutionPackageSchemas: readonly string[];
  /** Matomo support is capability-based; a version matrix follows real testing. */
  readonly matomoSupportModel: 'capability_based';
  readonly matomoConnections: readonly {
    readonly tenant: string;
    readonly compatibility: string;
    readonly version: string | null;
    readonly checkedAt: string | null;
    /** Limitation keys from the capability check - names, never values. */
    readonly limitations: readonly string[];
  }[];
}

export interface SystemOverview {
  readonly release: ReleaseInfo;
  readonly compatibility: CompatibilityInfo;
  readonly health: readonly {
    readonly name: string;
    readonly status: 'up' | 'down';
    readonly latencyMs?: number;
  }[];
  readonly jobs: Readonly<Record<string, number>>;
  readonly providers: Readonly<Record<string, string>>;
  readonly featureFlags: readonly { readonly flag: string; readonly enabled: boolean }[];
  readonly bundles: readonly DiagnosticArtifactSummary[];
}

/** A generated bundle, by reference. The file is short-lived and audited. */
export interface DiagnosticArtifactSummary {
  readonly id: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdBy: string | null;
}
