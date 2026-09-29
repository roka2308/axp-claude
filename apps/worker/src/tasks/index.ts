import type { MaintenanceTask } from '../scheduler';
import { sessionCleanupTask } from './session-cleanup';
import { bootstrapTokenCleanupTask } from './bootstrap-token-cleanup';
import { exportArtifactCleanupTask } from './export-artifact-cleanup';
import { shareSessionCleanupTask } from './share-session-cleanup';

/** Registry of periodic tasks. Scheduled reports join in Phase 8. */
export const MAINTENANCE_TASKS: readonly MaintenanceTask[] = [
  sessionCleanupTask,
  bootstrapTokenCleanupTask,
  exportArtifactCleanupTask,
  shareSessionCleanupTask,
];

export {
  sessionCleanupTask,
  bootstrapTokenCleanupTask,
  exportArtifactCleanupTask,
  shareSessionCleanupTask,
};
