import type { JobKind } from '@axp/contracts';
import type { Logger } from '@axp/observability';
import { newCorrelationId, runWithContext, sanitizeCorrelationId } from '@axp/observability';
import type { ClaimedJob, FailOutcome, JobQueue } from './job-queue';

/** What a handler says about a job it ran to the end. */
export type JobHandlerResult = 'done' | 'cancelled';

export interface JobHandler {
  run(job: ClaimedJob): Promise<JobHandlerResult>;
  /** Classifies a thrown error: retrying helps, or it does not. */
  classify(error: unknown): { code: string; retryable: boolean };
  /** Told after every failed attempt, with what the queue decided. */
  onFailure?(job: ClaimedJob, error: unknown, outcome: FailOutcome): Promise<void>;
}

/**
 * Takes jobs off the queue and runs them (development plan, Phase 8).
 *
 * Each job runs under its own correlation id, so a report's log lines and its
 * audit record can be traced to one execution (Master Spec §24: job
 * correlation). A handler that throws is never fatal to the worker: the queue
 * decides between retry, `dead` and `failed`, and the handler hears the verdict.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly deps: {
      queue: JobQueue;
      logger: Logger;
      handlers: Readonly<Partial<Record<JobKind, JobHandler>>>;
      workerId: string;
      pollMs: number;
      batchSize?: number;
    },
  ) {}

  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      this.running = this.drain().catch((error: unknown) =>
        this.deps.logger.error({ err: error }, 'Job polling failed'),
      );
      await this.running;
      if (this.stopped) return;
      this.timer = setTimeout(() => void tick(), this.deps.pollMs);
      this.timer.unref?.();
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Claims and runs jobs until none are due. Returns how many ran. */
  async drain(): Promise<number> {
    let processed = 0;
    for (;;) {
      const claimed = await this.deps.queue.claim(this.deps.workerId, {
        limit: this.deps.batchSize ?? 2,
      });
      if (claimed.length === 0) return processed;
      await Promise.all(claimed.map((job) => this.execute(job)));
      processed += claimed.length;
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const correlationId = job.correlationId
      ? sanitizeCorrelationId(job.correlationId)
      : newCorrelationId();
    await runWithContext({ correlationId, jobId: job.id }, async () => {
      const handler = this.deps.handlers[job.kind];
      if (!handler) {
        await this.deps.queue.fail(job, { code: 'job.no_handler', retryable: false });
        return;
      }
      try {
        const result = await handler.run(job);
        if (result === 'cancelled') await this.deps.queue.cancel(job, 'cancelled_by_handler');
        else await this.deps.queue.complete(job);
        this.deps.logger.info({ job: job.kind, attempt: job.attempt, result }, 'Job finished');
      } catch (error) {
        const classified = handler.classify(error);
        const outcome = await this.deps.queue.fail(job, classified);
        this.deps.logger.warn(
          { job: job.kind, attempt: job.attempt, code: classified.code, next: outcome.status },
          'Job attempt failed',
        );
        await handler.onFailure?.(job, error, outcome);
      }
    });
  }
}
