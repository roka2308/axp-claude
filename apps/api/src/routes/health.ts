import type { FastifyInstance } from 'fastify';
import type {
  DependencyHealth,
  LivenessResponse,
  ReadinessResponse,
  VersionResponse,
} from '@axp/contracts';
import { getBuildInfo } from '@axp/config';
import { checkDatabaseHealth } from '@axp/db';
import type { Container } from '@axp/core';

/**
 * Health endpoints (Master Spec §24).
 *
 * Liveness answers "is the process alive" and never touches a dependency, so a
 * database outage does not cause an orchestrator to kill healthy processes.
 * Readiness answers "can this process serve traffic" and does check.
 */
export function registerHealthRoutes(app: FastifyInstance, container: Container): void {
  const startedAt = Date.now();

  app.get('/livez', async (): Promise<LivenessResponse> => {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
  });

  app.get('/readyz', async (_request, reply): Promise<ReadinessResponse> => {
    const database = await checkDatabaseHealth(container.db);
    const dependencies: DependencyHealth[] = [
      {
        name: 'mysql',
        status: database.reachable ? 'up' : 'down',
        latencyMs: database.latencyMs,
        ...(database.detail ? { detail: database.detail } : {}),
      },
    ];

    const ready = dependencies.every((dependency) => dependency.status === 'up');
    void reply.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', dependencies };
  });

  app.get('/version', async (): Promise<VersionResponse> => {
    return {
      ...getBuildInfo('api'),
      deploymentProfile: container.config.deploymentProfile,
      appEnv: container.config.appEnv,
    };
  });
}
