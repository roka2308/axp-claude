import type { MaintenanceTask } from '../scheduler';

/**
 * Turns due report schedules into queued runs. Cheap and idempotent, so it
 * runs often; the delivery itself happens in the job queue.
 */
export const reportSchedulerTask: MaintenanceTask = {
  name: 'report-scheduler',
  intervalMs: 30_000,
  initialDelayMs: 3_000,
  async run(container) {
    const result = await container.reportRunner.scheduleDue();
    return { summary: { queuedRuns: result.queued, skippedRuns: result.skipped } };
  },
};
