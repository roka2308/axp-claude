import type { DeploymentProfile, PlatformInitState } from './lifecycle';

/** Header carrying the correlation id across web -> api -> worker -> Matomo. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

export interface BuildInfo {
  readonly name: string;
  readonly version: string;
  readonly schemaVersion: string;
  readonly commit: string;
  readonly builtAt: string;
}

export type DependencyStatus = 'up' | 'degraded' | 'down';

export interface DependencyHealth {
  readonly name: string;
  readonly status: DependencyStatus;
  readonly latencyMs?: number;
  /** Safe, non-sensitive detail. Never a raw driver error. */
  readonly detail?: string;
}

/** Liveness: the process is running. Does not check dependencies. */
export interface LivenessResponse {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
}

/** Readiness: the process can serve traffic, dependencies included. */
export interface ReadinessResponse {
  readonly status: 'ready' | 'not_ready';
  readonly dependencies: readonly DependencyHealth[];
}

export interface VersionResponse extends BuildInfo {
  readonly deploymentProfile: DeploymentProfile;
  readonly appEnv: string;
}

/** Public, unauthenticated: tells the web app whether setup is still required. */
export interface PlatformStatusResponse {
  readonly initState: PlatformInitState;
  readonly deploymentProfile: DeploymentProfile;
}
