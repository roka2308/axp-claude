import { minutes } from '@axp/core';
import type { MaintenanceTask } from '../scheduler';

/**
 * Deletes export files and diagnostic bundles once they expire (Master Spec §4,
 * §15, §24).
 *
 * A finished export holds analytics values, so it may exist only as long as
 * its download window. This is the auto-delete; a download after expiry is
 * refused by the API on its own, so a late run never extends a file's life.
 */
export const exportArtifactCleanupTask: MaintenanceTask = {
  name: 'export-artifact-cleanup',
  intervalMs: minutes(1),
  initialDelayMs: 5_000,
  async run(container) {
    // Diagnostic bundles first, so their files are gone before the orphan sweep.
    const bundles = await container.diagnostics.purgeExpired();
    const removed = await container.exports.purgeExpired();
    return {
      summary: {
        expiredArtifacts: removed.expired,
        expiredDiagnosticBundles: bundles,
        orphanFiles: removed.orphans,
      },
    };
  },
};
