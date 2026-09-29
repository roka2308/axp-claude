import { minutes } from '@axp/core';
import type { MaintenanceTask } from '../scheduler';

/**
 * Removes expired password sessions of shares. Expiry is enforced on every
 * request already; this only keeps the table small.
 */
export const shareSessionCleanupTask: MaintenanceTask = {
  name: 'share-session-cleanup',
  intervalMs: minutes(15),
  initialDelayMs: minutes(1),
  async run(container) {
    const removed = await container.shares.purgeExpiredSessions();
    return { summary: { removedShareSessions: removed } };
  },
};
