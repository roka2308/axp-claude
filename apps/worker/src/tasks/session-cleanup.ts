import { minutes } from '@axp/core';
import type { MaintenanceTask } from '../scheduler';

/**
 * Removes sessions that can no longer be used.
 *
 * Expiry is already enforced on every validation, so this only keeps the table
 * from growing without bound - it is not a security control by itself.
 */
export const sessionCleanupTask: MaintenanceTask = {
  name: 'session-cleanup',
  intervalMs: minutes(15),
  initialDelayMs: minutes(1),
  async run(container) {
    const removed = await container.auth.purgeExpiredSessions();
    return { summary: { removedSessions: removed } };
  },
};
