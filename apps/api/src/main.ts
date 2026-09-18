import { ConfigurationError, getBuildInfo, loadConfig } from '@axp/config';
import { createContainer } from '@axp/core';
import { createLogger } from '@axp/observability';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const build = getBuildInfo('api');

  const logger = createLogger({
    level: config.log.level,
    format: config.log.format,
    service: 'api',
    version: build.version,
    appEnv: config.appEnv,
  });

  const container = createContainer({ config, logger });
  const app = await buildServer({ config, container, logger });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down API');
    // Stop accepting requests first, then release the pool, so in-flight work
    // still has a working database connection.
    await app.close();
    await container.close();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  await app.listen({ host: config.api.host, port: config.api.port });
  logger.info(
    {
      host: config.api.host,
      port: config.api.port,
      version: build.version,
      schemaVersion: build.schemaVersion,
      commit: build.commit,
      deploymentProfile: config.deploymentProfile,
    },
    'API listening',
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) {
    // Configuration problems are operator errors: print them plainly rather
    // than as a stack trace nobody can act on.
    console.error(error.message);
    process.exit(78); // EX_CONFIG
  }
  console.error('API failed to start:', error);
  process.exit(1);
});
