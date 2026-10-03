import type { MaintenanceTask } from '../scheduler';
import { sessionCleanupTask } from './session-cleanup';
import { bootstrapTokenCleanupTask } from './bootstrap-token-cleanup';
import { exportArtifactCleanupTask } from './export-artifact-cleanup';
import { shareSessionCleanupTask } from './share-session-cleanup';
import { reportSchedulerTask } from './report-scheduler';
import { jobLeaseReaperTask } from './job-lease-reaper';
import { inactivityScanTask, mappingDriftScanTask, shareExpiryScanTask } from './attention-scans';

/**
 * Periodic tasks. Durable work - report delivery - runs through the job
 * queue instead; these only look at the clock and enqueue or tidy up.
 */
export const MAINTENANCE_TASKS: readonly MaintenanceTask[] = [
  sessionCleanupTask,
  bootstrapTokenCleanupTask,
  exportArtifactCleanupTask,
  shareSessionCleanupTask,
  reportSchedulerTask,
  jobLeaseReaperTask,
  shareExpiryScanTask,
  inactivityScanTask,
  mappingDriftScanTask,
];

export {
  sessionCleanupTask,
  bootstrapTokenCleanupTask,
  exportArtifactCleanupTask,
  shareSessionCleanupTask,
  reportSchedulerTask,
  jobLeaseReaperTask,
  shareExpiryScanTask,
  inactivityScanTask,
  mappingDriftScanTask,
};
