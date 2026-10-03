import { minutes } from '@axp/core';
import type { MaintenanceTask } from '../scheduler';

/** Returns jobs whose worker stopped mid-run to the queue, or marks them dead. */
export const jobLeaseReaperTask: MaintenanceTask = {
  name: 'job-lease-reaper',
  intervalMs: minutes(1),
  initialDelayMs: 10_000,
  async run(container) {
    return { summary: { reclaimedJobs: await container.jobs.reapExpiredLeases() } };
  },
};
