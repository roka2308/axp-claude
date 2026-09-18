import { minutes } from '@axp/core';
import type { MaintenanceTask } from '../scheduler';

/**
 * Drops consumed and expired bootstrap/recovery tokens.
 *
 * Only hashes are stored, so this is hygiene rather than secret removal - but
 * short-lived credentials should not linger even as hashes.
 */
export const bootstrapTokenCleanupTask: MaintenanceTask = {
  name: 'bootstrap-token-cleanup',
  intervalMs: minutes(30),
  initialDelayMs: minutes(2),
  async run(container) {
    const removed = await container.bootstrap.purgeExpiredTokens();
    return { summary: { removedTokens: removed } };
  },
};
