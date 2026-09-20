import type { MaintenanceTask } from '../scheduler';
import { sessionCleanupTask } from './session-cleanup';
import { bootstrapTokenCleanupTask } from './bootstrap-token-cleanup';

/** Registry of periodic tasks. Scheduled reports and exports join in Phase 8. */
export const MAINTENANCE_TASKS: readonly MaintenanceTask[] = [
  sessionCleanupTask,
  bootstrapTokenCleanupTask,
];

export { sessionCleanupTask, bootstrapTokenCleanupTask };
