import { hours, minutes } from '@axp/core';
import type { MaintenanceTask } from '../scheduler';

/** Links close to their expiry, for whoever created them. */
export const shareExpiryScanTask: MaintenanceTask = {
  name: 'attention-share-expiry',
  intervalMs: hours(1),
  initialDelayMs: minutes(1),
  async run(container) {
    return { summary: { expiringShares: await container.attentionScans.expiringShares() } };
  },
};

/** Accounts unused for a long time, for whoever manages accounts. */
export const inactivityScanTask: MaintenanceTask = {
  name: 'attention-inactivity',
  intervalMs: hours(24),
  initialDelayMs: minutes(2),
  async run(container) {
    return { summary: { inactiveAccounts: await container.attentionScans.inactiveAccounts() } };
  },
};

/** Mappings whose Matomo source changed, for the catalog managers. */
export const mappingDriftScanTask: MaintenanceTask = {
  name: 'attention-mapping-drift',
  intervalMs: hours(6),
  initialDelayMs: minutes(3),
  async run(container) {
    return { summary: { mappingsToReview: await container.attentionScans.mappingDrift() } };
  },
};
