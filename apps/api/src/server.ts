import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from '@axp/config';
import type { Container } from '@axp/core';
import type { Logger } from '@axp/observability';
import { registerRequestContext } from './plugins/request-context';
import { registerErrorHandler } from './plugins/error-handler';
import { registerAuthentication } from './plugins/authentication';
import { registerHealthRoutes } from './routes/health';
import { registerPlatformRoutes } from './routes/platform';
import { registerAuthRoutes } from './routes/auth';
import { registerProjectRoutes } from './routes/projects';
import { registerMatomoRoutes } from './routes/matomo';
import { registerDashboardRoutes } from './routes/dashboards';

export interface BuildServerOptions {
  readonly config: AppConfig;
  readonly container: Container;
  readonly logger: Logger;
}

/**
 * Builds the API application.
 *
 * Exported separately from `main.ts` so integration tests can drive the exact
 * same instance through `app.inject()` without opening a port.
 */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config, container, logger } = options;

  const app = Fastify({
    // Cast keeps the instance at Fastify's default generic parameters, so every
    // `register*` helper can take a plain `FastifyInstance`. pino satisfies
    // FastifyBaseLogger structurally; only the declared type differs.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: config.appEnv !== 'development',
    bodyLimit: 1_048_576,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(helmet, {
    // The API serves JSON only; a restrictive CSP costs nothing here.
    contentSecurityPolicy: {
      directives: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  registerRequestContext(app);
  registerErrorHandler(app);
  registerAuthentication(app, container);

  registerHealthRoutes(app, container);
  registerPlatformRoutes(app, container);
  registerAuthRoutes(app, container);
  registerProjectRoutes(app, container);
  registerMatomoRoutes(app, container);
  registerDashboardRoutes(app, container);

  // No CORS plugin on purpose: the browser never calls this service directly.
  // Requests arrive from the Next.js server, which holds the session cookie.

  return app;
}
