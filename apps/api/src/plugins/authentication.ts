import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type AuthContext, errors } from '@axp/contracts';
import { enrichContext } from '@axp/observability';
import type { Container } from '@axp/core';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by `authenticate`; absent on public routes. */
    auth?: AuthContext;
    recentlyAuthenticated?: boolean;
    sessionId?: string;
  }
}

/**
 * Session authentication.
 *
 * The API accepts a bearer token only - never a browser cookie. The session
 * cookie lives on the web origin and is read server-side by Next.js, which
 * forwards the token. That keeps the API free of CORS and CSRF concerns and
 * means no browser ever calls it directly.
 */
export function registerAuthentication(app: FastifyInstance, container: Container): void {
  app.decorate('authenticate', async function authenticate(request: FastifyRequest) {
    const token = extractBearerToken(request);
    if (!token) {
      throw errors.authenticationRequired('missing_session', {
        messageKey: 'auth.session_required',
        internalMessage: 'No bearer token on a protected route.',
      });
    }

    const validation = await container.auth.validateSession(token);
    if (!validation) {
      throw errors.authenticationRequired('invalid_session', {
        messageKey: 'auth.session_expired',
        internalMessage: 'Session token unknown, expired or revoked.',
      });
    }

    request.auth = validation.context;
    request.sessionId = validation.sessionId;
    request.recentlyAuthenticated = validation.recentlyAuthenticated;
    enrichContext({ userId: validation.context.userId });
  });
}

export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

/** Narrows `request.auth` for handlers that ran behind `authenticate`. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw errors.authenticationRequired('missing_session', {
      internalMessage: 'requireAuth() called on a route without the authenticate hook.',
    });
  }
  return request.auth;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest): Promise<void>;
  }
}
