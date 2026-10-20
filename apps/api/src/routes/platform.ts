import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientAddress } from '../lib/client-address';
import { type PlatformStatusResponse } from '@axp/contracts';
import type { Container } from '@axp/core';

const completeBootstrapSchema = z.object({
  token: z.string().min(16).max(256),
  email: z.string().email().max(320),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
  locale: z.enum(['de', 'en']).optional(),
});

const verifyTokenSchema = z.object({
  token: z.string().min(16).max(256),
});

/**
 * Platform initialization (Master Spec §6, Gap Review G4).
 *
 * These routes are unauthenticated by necessity - there is no account yet - so
 * they are rate limited and the token does all the gatekeeping. They stop
 * working the moment the platform is initialized.
 */
export function registerPlatformRoutes(app: FastifyInstance, container: Container): void {
  app.get('/platform/status', async (): Promise<PlatformStatusResponse> => {
    return {
      initState: await container.bootstrap.getInitState(),
      deploymentProfile: container.config.deploymentProfile,
    };
  });

  app.post(
    '/platform/bootstrap/verify',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => {
      const { token } = verifyTokenSchema.parse(request.body);
      // Deliberately boolean-only: the response must not hint at why a token
      // is unusable (unknown, expired or already consumed).
      return { valid: await container.bootstrap.isTokenUsable(token) };
    },
  );

  app.post(
    '/platform/bootstrap/complete',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const input = completeBootstrapSchema.parse(request.body);
      const result = await container.bootstrap.completeInitialBootstrap({
        ...input,
        ipAddress: clientAddress(request, container.config.api.trustedProxies),
        userAgent: request.headers['user-agent'],
      });
      void reply.status(201);
      return { userId: result.userId };
    },
  );

  /**
   * Break-glass recovery. A separate route from the setup path on purpose, so
   * the two never share a code path, a token or an audit action.
   */
  app.post(
    '/platform/recovery/verify',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = verifyTokenSchema.parse(request.body);
      return { valid: await container.bootstrap.isTokenUsable(token, 'break_glass_recovery') };
    },
  );

  app.post(
    '/platform/recovery/complete',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = completeBootstrapSchema.parse(request.body);
      const result = await container.bootstrap.completeRecovery({
        ...input,
        ipAddress: clientAddress(request, container.config.api.trustedProxies),
        userAgent: request.headers['user-agent'],
      });
      void reply.status(201);
      return { userId: result.userId };
    },
  );
}
