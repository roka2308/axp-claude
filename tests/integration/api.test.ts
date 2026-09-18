import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CORRELATION_ID_HEADER } from '@axp/contracts';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * API-level tests, driven through `app.inject()` so no port is opened and the
 * exact production wiring is exercised: real plugins, real error handler, real
 * container.
 */
describe('API', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDatabase();
    ctx = await createTestContext();
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  describe('health and build metadata', () => {
    it('answers liveness without touching a dependency', async () => {
      const response = await app.inject({ method: 'GET', url: '/livez' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('reports readiness with dependency detail', async () => {
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'ready',
        dependencies: [{ name: 'mysql', status: 'up' }],
      });
    });

    it('exposes product, schema and build version', async () => {
      // Gate F0: web, API and worker expose version/build info.
      const response = await app.inject({ method: 'GET', url: '/version' });
      const body = response.json();
      expect(body).toMatchObject({ name: 'api' });
      expect(body.version).toBeTruthy();
      expect(body.schemaVersion).toBeTruthy();
      expect(body.deploymentProfile).toBeTruthy();
    });
  });

  describe('correlation ids', () => {
    it('mints one and echoes it on the response', async () => {
      const response = await app.inject({ method: 'GET', url: '/livez' });
      expect(response.headers[CORRELATION_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('continues a trace started upstream', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/livez',
        headers: { [CORRELATION_ID_HEADER]: 'web-request-42' },
      });
      expect(response.headers[CORRELATION_ID_HEADER]).toBe('web-request-42');
    });

    it('replaces a hostile inbound value instead of echoing it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/livez',
        headers: { [CORRELATION_ID_HEADER]: 'injected\nlog line' },
      });
      expect(response.headers[CORRELATION_ID_HEADER]).not.toContain('\n');
    });
  });

  describe('platform status', () => {
    it('reports an uninitialized platform', async () => {
      const response = await app.inject({ method: 'GET', url: '/platform/status' });
      expect(response.json()).toMatchObject({ initState: 'uninitialized' });
    });

    it('answers token verification with a bare boolean', async () => {
      const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();

      const valid = await app.inject({
        method: 'POST',
        url: '/platform/bootstrap/verify',
        payload: { token: issued.token },
      });
      expect(valid.json()).toEqual({ valid: true });

      const invalid = await app.inject({
        method: 'POST',
        url: '/platform/bootstrap/verify',
        payload: { token: 'x'.repeat(40) },
      });
      // No hint about why: unknown, expired and consumed look identical.
      expect(invalid.json()).toEqual({ valid: false });
    });

    it('completes the bootstrap and then refuses a repeat', async () => {
      const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();
      const payload = {
        token: issued.token,
        email: 'admin@example.invalid',
        firstName: 'Petra',
        lastName: 'Plattform',
        password: STRONG_TEST_PASSWORD,
      };

      const created = await app.inject({
        method: 'POST',
        url: '/platform/bootstrap/complete',
        payload,
      });
      expect(created.statusCode).toBe(201);

      const repeat = await app.inject({
        method: 'POST',
        url: '/platform/bootstrap/complete',
        payload,
      });
      expect(repeat.statusCode).toBeGreaterThanOrEqual(400);
    });
  });

  describe('authentication', () => {
    async function bootstrapAdmin() {
      const issued = await ctx.container.bootstrap.issueInitialBootstrapToken();
      await ctx.container.bootstrap.completeInitialBootstrap({
        token: issued.token,
        email: 'admin@example.invalid',
        firstName: 'Petra',
        lastName: 'Plattform',
        password: STRONG_TEST_PASSWORD,
      });
    }

    it('signs in and returns a session token', async () => {
      await bootstrapAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@example.invalid', password: STRONG_TEST_PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.token).toBeTruthy();
      expect(body.expiresAt).toBeTruthy();
      // The password must not travel back in any form.
      expect(JSON.stringify(body)).not.toContain(STRONG_TEST_PASSWORD);
    });

    it('answers a failed sign-in with a stable product error shape', async () => {
      await bootstrapAdmin();
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@example.invalid', password: 'falsch-aber-lang-genug' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { category: 'authentication_required', code: 'invalid_credentials' },
      });
      // No raw driver or library text reaches the client.
      expect(JSON.stringify(response.json())).not.toMatch(/argon2|mysql|stack/i);
    });

    it('refuses a protected route without a bearer token', async () => {
      const response = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { category: 'authentication_required' } });
    });

    it('ignores a cookie: the API accepts bearer tokens only', async () => {
      await bootstrapAdmin();
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@example.invalid', password: STRONG_TEST_PASSWORD },
      });
      const token = login.json().token as string;

      // The browser never calls this service, so a cookie must not authenticate.
      const withCookie = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: `axp_session=${token}` },
      });
      expect(withCookie.statusCode).toBe(401);

      const withBearer = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(withBearer.statusCode).toBe(200);
    });

    it('returns roles together with the "no automatic data access" statement', async () => {
      await bootstrapAdmin();
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'admin@example.invalid', password: STRONG_TEST_PASSWORD },
      });

      const me = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${login.json().token}` },
      });

      const body = me.json();
      expect(body.user.email).toBe('admin@example.invalid');
      expect(body.roleAssignments).toEqual([
        expect.objectContaining({
          role: 'platform_admin',
          scopeType: 'platform',
          grantsAutomaticAnalyticsAccess: false,
        }),
      ]);
      // The response must never carry credential material.
      expect(JSON.stringify(body)).not.toMatch(/passwordHash|\$argon2/);
    });
  });

  describe('error handling', () => {
    it('answers an unknown route with the product error shape', async () => {
      const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { category: 'not_found' } });
    });

    it('answers a schema violation as validation_failed with field detail', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: '', password: '' },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json();
      expect(body.error.category).toBe('validation_failed');
      expect(body.error.fieldErrors).toBeTruthy();
    });
  });
});
