import type { Container } from '@axp/core';
import { newCorrelationId, runWithContext } from '@axp/observability';

export interface MaintenanceTask {
  readonly name: string;
  readonly intervalMs: number;
  /** Delay before the first run, so startup is not a thundering herd. */
  readonly initialDelayMs?: number;
  run(container: Container): Promise<TaskResult>;
}

export interface TaskResult {
  /** Short, non-sensitive summary for the log line. */
  readonly summary: Record<string, number | string>;
}

/**
 * Minimal periodic scheduler for maintenance work.
 *
 * Phase 0 deliberately has no persistent job queue: the durable JobQueue
 * abstraction with claim/retry/fail semantics belongs to Phase 8, and building
 * it early would mean designing it without the exports and scheduled reports
 * that define its requirements. What matters now is that the worker is a real
 * separate process running real domain code from the same codebase.
 *
 * Each run gets its own correlation id, so a maintenance run is traceable the
 * same way a request is.
 */
export class Scheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly container: Container,
    private readonly tasks: readonly MaintenanceTask[],
  ) {}

  start(): void {
    for (const task of this.tasks) {
      const initialDelay = task.initialDelayMs ?? 0;
      const timer = setTimeout(() => void this.runAndReschedule(task), initialDelay);
      // Do not keep the event loop alive for a timer that is only housekeeping.
      timer.unref?.();
      this.timers.set(task.name, timer);
    }
    this.container.logger.info(
      { tasks: this.tasks.map((task) => task.name) },
      'Worker scheduler started',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Runs one task immediately. Used by tests and by the `--once` mode. */
  async runOnce(task: MaintenanceTask): Promise<TaskResult | null> {
    return this.execute(task);
  }

  private async runAndReschedule(task: MaintenanceTask): Promise<void> {
    if (this.stopped) return;
    await this.execute(task);
    if (this.stopped) return;

    const timer = setTimeout(() => void this.runAndReschedule(task), task.intervalMs);
    timer.unref?.();
    this.timers.set(task.name, timer);
  }

  private async execute(task: MaintenanceTask): Promise<TaskResult | null> {
    const correlationId = newCorrelationId();
    const startedAt = Date.now();

    return runWithContext({ correlationId, jobId: task.name }, async () => {
      try {
        const result = await task.run(this.container);
        this.container.logger.info(
          { task: task.name, durationMs: Date.now() - startedAt, ...result.summary },
          'Maintenance task completed',
        );
        return result;
      } catch (error) {
        // A failing maintenance task must never take the worker down; the next
        // interval retries it.
        this.container.logger.error(
          { err: error, task: task.name, durationMs: Date.now() - startedAt },
          'Maintenance task failed',
        );
        return null;
      }
    });
  }
}
