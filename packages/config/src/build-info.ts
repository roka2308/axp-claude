import type { BuildInfo } from '@axp/contracts';

/**
 * Product / schema / build metadata.
 *
 * Gate F0 requires web, API and worker to expose version and build info; the
 * release lifecycle (Master Spec §24) later builds compatibility statements on
 * the same values. Injected at build time, with safe development defaults.
 */
export const PRODUCT_VERSION = '0.1.0';

/**
 * Database schema version. Bumped when a migration changes the contract
 * between product version and stored data, not on every migration.
 */
export const SCHEMA_VERSION = '1';

export function getBuildInfo(service: string): BuildInfo {
  return {
    name: service,
    version: process.env.AXP_PRODUCT_VERSION ?? PRODUCT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    commit: process.env.AXP_BUILD_COMMIT ?? 'dev',
    builtAt: process.env.AXP_BUILT_AT ?? 'dev',
  };
}
