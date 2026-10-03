import { z } from 'zod';

/**
 * Background jobs (development plan, Phase 8).
 *
 * A job is a durable instruction for the worker. Its payload names what to do
 * by reference - a schedule, a run - and never carries analytics data: the
 * worker fetches numbers when it executes (Shared Contract §12).
 */
export const JOB_KINDS = ['report.deliver'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Payloads by kind: ids only. Validated when enqueued and when claimed. */
export const JOB_PAYLOAD_SCHEMAS = {
  'report.deliver': z.object({ runId: z.string().min(1).max(64) }).strict(),
} as const satisfies Record<JobKind, z.ZodType>;

export type JobPayload<K extends JobKind> = z.infer<(typeof JOB_PAYLOAD_SCHEMAS)[K]>;
