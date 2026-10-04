import { minutes } from '@axp/core';
import type { MaintenanceTask } from '../scheduler';

/**
 * Drops consumed and expired bootstrap/recovery tokens, and the encrypted
 * copies of mailed links (invitations, password resets, address changes)
 * once those links can no longer be used.
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
    const accountTokens = await container.accountMail.purgeExpired();
    return { summary: { removedTokens: removed, removedAccountTokens: accountTokens } };
  },
};
