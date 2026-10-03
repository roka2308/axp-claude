import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import {
  AppError,
  JOB_PAYLOAD_SCHEMAS,
  type JobKind,
  type JobPayload,
  type JobStatus,
} from '@axp/contracts';
import { affectedRows, type Database, jobs, newId } from '@axp/db';
import type { Clock } from '../clock';

/**
 * Durable background work (development plan, Phase 8).
 *
 * The contract every job follows: enqueue (idempotent through a dedupe key),
 * claim (a lease, so a crashed worker's job comes back), then exactly one of
 * complete, fail - retried with backoff until its attempts are used up, then
 * `dead` - or cancel. Payloads are ids, validated on the way in and out; a job
 * never carries analytics data (Shared Contract §12).
 */
export interface JobQueue {
  enqueue<K extends JobKind>(input: EnqueueInput<K>): Promise<{ id: string; created: boolean }>;
  claim(workerId: string, options?: { limit?: number }): Promise<ClaimedJob[]>;
  complete(job: ClaimedJob): Promise<void>;
  fail(job: ClaimedJob, error: { code: string; retryable: boolean }): Promise<FailOutcome>;
  cancel(job: ClaimedJob, code: string): Promise<void>;
  reapExpiredLeases(): Promise<number>;
}

export interface EnqueueInput<K extends JobKind> {
  readonly kind: K;
  readonly payload: JobPayload<K>;
  readonly tenantId?: string | null;
  readonly runAfter?: Date;
  readonly dedupeKey?: string;
  readonly maxAttempts?: number;
  readonly correlationId?: string;
}

export interface ClaimedJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly tenantId: string | null;
  /** This attempt's number, starting at 1. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly correlationId: string | null;
}

export type FailOutcome = {
  readonly status: Extract<JobStatus, 'queued' | 'failed' | 'dead'>;
  readonly retryAt?: Date;
};

/** Waits between attempts: 1, 5, then 15 minutes. */
export const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const;

export class MySqlJobQueue implements JobQueue {
  constructor(private readonly deps: { db: Database; clock: Clock; leaseSeconds: number }) {}

  async enqueue<K extends JobKind>(input: EnqueueInput<K>) {
    const payload = JOB_PAYLOAD_SCHEMAS[input.kind].parse(input.payload) as Record<string, unknown>;
    if (input.dedupeKey) {
      const [existing] = await this.deps.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.dedupeKey, input.dedupeKey))
        .limit(1);
      if (existing) return { id: existing.id, created: false };
    }

    const id = newId();
    try {
      await this.deps.db.insert(jobs).values({
        id,
        tenantId: input.tenantId ?? null,
        kind: input.kind,
        payload,
        status: 'queued',
        maxAttempts: input.maxAttempts ?? RETRY_BACKOFF_MS.length,
        runAfter: input.runAfter ?? this.deps.clock.now(),
        dedupeKey: input.dedupeKey ?? null,
        correlationId: input.correlationId ?? null,
      });
    } catch (error) {
      // Two schedulers raced for the same occurrence: the other one won.
      if (input.dedupeKey && /Duplicate entry/i.test(String((error as Error).message))) {
        const [existing] = await this.deps.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.dedupeKey, input.dedupeKey))
          .limit(1);
        if (existing) return { id: existing.id, created: false };
      }
      throw error;
    }
    return { id, created: true };
  }

  /**
   * Takes due jobs under a lease. `SKIP LOCKED` lets several workers claim in
   * parallel without waiting on, or double-taking, each other's rows.
   */
  async claim(workerId: string, options: { limit?: number } = {}): Promise<ClaimedJob[]> {
    const now = this.deps.clock.now();
    const leaseUntil = new Date(now.getTime() + this.deps.leaseSeconds * 1000);

    return this.deps.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now)))
        .orderBy(asc(jobs.runAfter))
        .limit(options.limit ?? 1)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];

      const claimed: ClaimedJob[] = [];
      for (const row of due) {
        await tx
          .update(jobs)
          .set({
            status: 'running',
            attempts: row.attempts + 1,
            lockedBy: workerId,
            lockedUntil: leaseUntil,
            startedAt: now,
          })
          .where(eq(jobs.id, row.id));
        claimed.push({
          id: row.id,
          kind: row.kind,
          payload: JOB_PAYLOAD_SCHEMAS[row.kind].parse(row.payload) as Record<string, unknown>,
          tenantId: row.tenantId,
          attempt: row.attempts + 1,
          maxAttempts: row.maxAttempts,
          correlationId: row.correlationId,
        });
      }
      return claimed;
    });
  }

  async complete(job: ClaimedJob): Promise<void> {
    await this.finish(job.id, 'succeeded', null);
  }

  async fail(job: ClaimedJob, error: { code: string; retryable: boolean }): Promise<FailOutcome> {
    if (error.retryable && job.attempt < job.maxAttempts) {
      const retryAt = new Date(
        this.deps.clock.now().getTime() +
          (RETRY_BACKOFF_MS[job.attempt - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!),
      );
      await this.deps.db
        .update(jobs)
        .set({
          status: 'queued',
          runAfter: retryAt,
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: error.code.slice(0, 100),
        })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')));
      return { status: 'queued', retryAt };
    }
    const status = error.retryable ? 'dead' : 'failed';
    await this.finish(job.id, status, error.code);
    return { status };
  }

  async cancel(job: ClaimedJob, code: string): Promise<void> {
    await this.finish(job.id, 'cancelled', code);
  }

  /**
   * A job whose lease ran out belongs to a worker that stopped. It goes back
   * to the queue while it has attempts left; after that it is dead.
   */
  async reapExpiredLeases(): Promise<number> {
    const now = this.deps.clock.now();
    const stale = await this.deps.db
      .select({ id: jobs.id, attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
      .from(jobs)
      .where(and(eq(jobs.status, 'running'), lte(jobs.lockedUntil, now)));

    const retry = stale.filter((row) => row.attempts < row.maxAttempts).map((row) => row.id);
    const dead = stale.filter((row) => row.attempts >= row.maxAttempts).map((row) => row.id);
    if (retry.length > 0) {
      await this.deps.db
        .update(jobs)
        .set({
          status: 'queued',
          lockedBy: null,
          lockedUntil: null,
          lastErrorCode: 'lease_expired',
        })
        .where(inArray(jobs.id, retry));
    }
    if (dead.length > 0) {
      await this.deps.db
        .update(jobs)
        .set({
          status: 'dead',
          lockedBy: null,
          lockedUntil: null,
          finishedAt: now,
          lastErrorCode: 'lease_expired',
        })
        .where(inArray(jobs.id, dead));
    }
    return stale.length;
  }

  private async finish(id: string, status: JobStatus, code: string | null): Promise<void> {
    const result = await this.deps.db
      .update(jobs)
      .set({
        status,
        lockedBy: null,
        lockedUntil: null,
        finishedAt: this.deps.clock.now(),
        ...(code ? { lastErrorCode: code.slice(0, 100) } : {}),
      })
      .where(and(eq(jobs.id, id), eq(jobs.status, 'running')));
    if (affectedRows(result) === 0) {
      throw new AppError('conflict', {
        code: 'job_not_running',
        internalMessage: `Job ${id} was not running when it was finished as ${status}.`,
      });
    }
  }
}
