import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { ConfigurationError, getBuildInfo, loadConfig } from '@axp/config';
import { hostname } from 'node:os';
import { createContainer, JobRunner } from '@axp/core';
import { checkDatabaseHealth } from '@axp/db';
import { createLogger } from '@axp/observability';
import { Scheduler } from './scheduler';
import { MAINTENANCE_TASKS } from './tasks/index';

/**
 * Background worker.
 *
 * A separate process built from the same codebase and running the same domain
 * services as the API (Master Spec §3), which is what keeps "one modular
 * monolith, several processes" honest.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      once: { type: 'boolean', default: false },
      'health-port': { type: 'string' },
    },
    allowPositionals: false,
  });

  const config = loadConfig();
  const build = getBuildInfo('worker');

  const logger = createLogger({
    level: config.log.level,
    format: config.log.format,
    service: 'worker',
    version: build.version,
    appEnv: config.appEnv,
  });

  const container = createContainer({ config, logger });
  const scheduler = new Scheduler(container, MAINTENANCE_TASKS);
  // Durable work: claimed from the job queue under a lease, retried with backoff.
  const jobRunner = new JobRunner({
    queue: container.jobs,
    logger,
    handlers: { 'report.deliver': container.reportRunner.asJobHandler() },
    workerId: `${hostname()}:${process.pid}`,
    pollMs: config.worker.jobPollMs,
  });

  if (values.once) {
    // One pass over every task, then exit. Used by tests and by operators who
    // want to force housekeeping without restarting the process.
    for (const task of MAINTENANCE_TASKS) await scheduler.runOnce(task);
    await jobRunner.drain();
    await container.close();
    return;
  }

  // Minimal health surface so an orchestrator can supervise the worker too
  // (Master Spec §24). Intentionally not a full HTTP API.
  const healthPort = Number(values['health-port'] ?? config.api.port + 1);
  const healthServer = createServer((request, response) => {
    void (async () => {
      if (request.url === '/livez') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (request.url === '/readyz') {
        const database = await checkDatabaseHealth(container.db);
        response.writeHead(database.reachable ? 200 : 503, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            status: database.reachable ? 'ready' : 'not_ready',
            dependencies: [
              {
                name: 'mysql',
                status: database.reachable ? 'up' : 'down',
                latencyMs: database.latencyMs,
              },
            ],
          }),
        );
        return;
      }
      if (request.url === '/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ...build,
            deploymentProfile: config.deploymentProfile,
            appEnv: config.appEnv,
          }),
        );
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { category: 'not_found', code: 'route' } }));
    })();
  });

  healthServer.listen(healthPort, config.api.host);
  scheduler.start();
  jobRunner.start();

  logger.info(
    {
      healthPort,
      version: build.version,
      schemaVersion: build.schemaVersion,
      commit: build.commit,
      deploymentProfile: config.deploymentProfile,
    },
    'Worker started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down worker');
    await scheduler.stop();
    await jobRunner.stop();
    healthServer.close();
    await container.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    process.exit(78);
  }
  console.error('Worker failed to start:', error);
  process.exit(1);
});
