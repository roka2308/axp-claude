import { z } from 'zod';

/**
 * Background jobs (development plan, Phase 8).
 *
 * A job is a durable instruction for the worker. Its payload names what to do
 * by reference - a schedule, a run - and never carries analytics data: the
 * worker fetches numbers when it executes (Shared Contract §12).
 */
export const JOB_KINDS = ['report.deliver', 'account.mail'] as const;

/** What an account mail is about; the record holds the rest (Phase 10). */
export const ACCOUNT_MAIL_PURPOSES = ['invitation', 'password_reset', 'email_change'] as const;
export type AccountMailPurpose = (typeof ACCOUNT_MAIL_PURPOSES)[number];
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
  // The link's token is not in the payload: it waits, encrypted, on the record.
  'account.mail': z
    .object({ purpose: z.enum(ACCOUNT_MAIL_PURPOSES), recordId: z.string().min(1).max(64) })
    .strict(),
} as const satisfies Record<JobKind, z.ZodType>;

export type JobPayload<K extends JobKind> = z.infer<(typeof JOB_PAYLOAD_SCHEMAS)[K]>;
