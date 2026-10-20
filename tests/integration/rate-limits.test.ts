import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

/**
 * Rate limits count the right party (Phase 10).
 *
 * Every browser request arrives from the web server. Counting by connection
 * address would let one visitor's mistakes lock out everyone; so a signed-in
 * request counts per session, and an anonymous one by the visitor's address,
 * which only the trusted web server may state.
 */
describe('rate limits', () => {
  let ctx: TestContext;
  let app: FastifyInstance;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestContext();
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();
    for (const email of ['eins@example.invalid', 'zwei@example.invalid', 'drei@example.invalid']) {
      await ctx.container.users.createLocalUser({
        email,
        firstName: 'Rate',
        lastName: 'Limit',
        password: STRONG_TEST_PASSWORD,
        status: 'active',
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  function resetRequest(address: string, remoteAddress = '127.0.0.1') {
    return app.inject({
      method: 'POST',
      url: '/auth/password-reset',
      remoteAddress,
      headers: { 'x-axp-client-address': address },
      payload: { email: 'niemand@example.invalid' },
    });
  }

  it('limits one visitor without limiting the next one behind the same web server', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await resetRequest('203.0.113.7')).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
    expect((await resetRequest('198.51.100.9')).statusCode).toBe(202);
  });

  it('ignores a stated address from anyone but the trusted web server', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Each request claims a new address, but comes from the same untrusted peer.
      statuses.push((await resetRequest(`192.0.2.${attempt}`, '10.9.8.7')).statusCode);
    }
    expect(statuses[5]).toBe(429);
  });

  it('locks a guessed account, not everyone behind the same web server', async () => {
    const login = (email: string, password: string, address: string) =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: '127.0.0.1',
        headers: { 'x-axp-client-address': address },
        payload: { email, password },
      });
    // Five wrong passwords for one account lock that account, from anywhere.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login('zwei@example.invalid', 'falsch-falsch-falsch', '203.0.113.40');
    }
    expect(
      (await login('zwei@example.invalid', STRONG_TEST_PASSWORD, '198.51.100.40')).statusCode,
    ).toBe(429);
    // The address they came from is not locked for everyone else's account.
    expect(
      (await login('eins@example.invalid', STRONG_TEST_PASSWORD, '203.0.113.40')).statusCode,
    ).toBe(200);
  });

  it('locks an address only after many failures across accounts', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await ctx.container.auth
        .login({
          email: `gibtsnicht${attempt}@example.invalid`,
          password: 'x',
          ipAddress: '192.0.2.77',
        })
        .then(() => 200)
        .catch((error: { category?: string }) => (error.category === 'rate_limited' ? 429 : 401));
      statuses.push(response);
    }
    expect(statuses.slice(0, 49).every((status) => status === 401)).toBe(true);
    await expect(
      ctx.container.auth.login({
        email: 'eins@example.invalid',
        password: STRONG_TEST_PASSWORD,
        ipAddress: '192.0.2.77',
      }),
    ).rejects.toMatchObject({ category: 'rate_limited' });
    await expect(
      ctx.container.auth.login({
        email: 'eins@example.invalid',
        password: STRONG_TEST_PASSWORD,
        ipAddress: '192.0.2.78',
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('limits only the routes that declare a limit', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'eins@example.invalid', password: STRONG_TEST_PASSWORD },
    });
    const session = login.json().token as string;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/me/profile',
        headers: { authorization: 'Bearer ' + session },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });

  it('counts signed-in requests per session', async () => {
    const sessions = [];
    for (const email of ['eins@example.invalid', 'drei@example.invalid']) {
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: STRONG_TEST_PASSWORD },
      });
      sessions.push(login.json().token as string);
    }
    const reauth = (session: string) =>
      app.inject({
        method: 'POST',
        url: '/auth/reauthenticate',
        headers: { authorization: `Bearer ${session}` },
        payload: { password: STRONG_TEST_PASSWORD },
      });
    const first = [];
    for (let attempt = 0; attempt < 11; attempt += 1)
      first.push((await reauth(sessions[0]!)).statusCode);
    expect(first[10]).toBe(429);
    expect((await reauth(sessions[1]!)).statusCode).toBe(200);
  });
});
