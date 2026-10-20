import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { seedReferenceDashboard } from '@axp/fixtures';
import { HttpMatomoAdapter, type MatomoConnector } from '@axp/core';
import { buildServer } from '../../apps/api/src/server';
import {
  closeDatabase,
  createTestContext,
  grantProjectAccess,
  resetDatabase,
  STRONG_TEST_PASSWORD,
  type TestContext,
} from './harness';

const VIEW = 'timeRange=last_30_days&comparison=previous_period&breakpoint=desktop';
const WIDGETS = ['kpi-visits', 'kpi-pageviews', 'series-visits', 'table-top-pages'];

/**
 * Widget independence, bounded parallelism, timeouts and the short-lived
 * cache (Phase 10; acceptance I; Master Spec §26).
 *
 * The connector is wrapped so one source metric can be made slow and every
 * call to Matomo is counted, with the concurrency at each moment.
 */
describe('performance and robustness', () => {
  let ctx: TestContext;
  let app: FastifyInstance;
  let session: string;
  let dashboardId: string;
  const probe = { calls: 0, active: 0, maxActive: 0, slowMetric: '', delayMs: 0, holdMs: 0 };

  async function start(analytics: { queryTimeoutMs: number; maxParallelQueries: number }) {
    await resetDatabase();
    Object.assign(probe, {
      calls: 0,
      active: 0,
      maxActive: 0,
      slowMetric: '',
      delayMs: 0,
      holdMs: 0,
    });
    ctx = await createTestContext({
      configure: (config) => ({ ...config, analytics: { ...config.analytics, ...analytics } }),
      wrapConnector: (connector) => counting(connector),
    });
    app = await buildServer({ config: ctx.config, container: ctx.container, logger: ctx.logger });
    await app.ready();
    const tenantId = (
      await ctx.container.tenants.createTenant({ portableId: 'perf', name: 'Perf', slug: 'perf' })
    ).tenantId;
    await ctx.container.tenants.changeLifecycle(tenantId, 'active');
    const projectId = (
      await ctx.container.tenants.createProject({
        tenantId,
        portableId: 'perf.project',
        name: 'Portal',
        slug: 'portal',
      })
    ).projectId;
    const { userId } = await ctx.container.users.createLocalUser({
      email: 'viewer@example.invalid',
      firstName: 'View',
      lastName: 'Er',
      password: STRONG_TEST_PASSWORD,
      status: 'active',
    });
    await ctx.container.tenants.addMembership(tenantId, userId);
    await ctx.container.users.assignRole({
      subjectType: 'user',
      subjectId: userId,
      role: 'viewer',
      scopeType: 'project',
      scopeId: projectId,
    });
    await grantProjectAccess(ctx, userId, projectId, 'view');
    dashboardId = (
      await seedReferenceDashboard(ctx.container, { tenantId, projectId, actorUserId: userId })
    ).dashboardId;
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'viewer@example.invalid', password: STRONG_TEST_PASSWORD },
    });
    session = login.json().token as string;
  }

  /** Counts calls and concurrency; makes one metric slow when asked to. */
  function counting(connector: MatomoConnector): MatomoConnector {
    return new Proxy(connector, {
      get(target, property, receiver) {
        if (property !== 'execute') return Reflect.get(target, property, receiver);
        return async (...args: Parameters<MatomoConnector['execute']>) => {
          probe.calls += 1;
          probe.active += 1;
          probe.maxActive = Math.max(probe.maxActive, probe.active);
          try {
            const metrics = args[1].sourceMetrics.map((metric) => metric.sourceMetric);
            if (
              probe.slowMetric &&
              metrics.includes(probe.slowMetric) &&
              args[1].kind === 'scalar'
            ) {
              await sleep(probe.delayMs);
            }
            if (probe.holdMs) await sleep(probe.holdMs);
            return await target.execute(...args);
          } finally {
            probe.active -= 1;
          }
        };
      },
    });
  }

  function tile(widgetId: string, view = VIEW) {
    return app.inject({
      method: 'GET',
      url: `/dashboards/${dashboardId}/widgets/${widgetId}?${view}`,
      headers: { authorization: `Bearer ${session}` },
    });
  }

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('lets a slow widget fail on its own while the others arrive', async () => {
    await start({ queryTimeoutMs: 700, maxParallelQueries: 6 });
    Object.assign(probe, { slowMetric: 'pageviews', delayMs: 5_000 });

    const started = Date.now();
    const answers = await Promise.all(
      WIDGETS.map(async (widgetId) => {
        const response = await tile(widgetId);
        return {
          widgetId,
          ms: Date.now() - started,
          body: response.json(),
          status: response.statusCode,
        };
      }),
    );

    const slow = answers.find((answer) => answer.widgetId === 'kpi-pageviews')!;
    const others = answers.filter((answer) => answer.widgetId !== 'kpi-pageviews');
    for (const answer of answers) expect(answer.status, answer.widgetId).toBe(200);
    // The others are complete and ready, and none waited for the slow one.
    for (const answer of others) {
      expect(answer.body.state, answer.widgetId).toBe('ready');
      expect(answer.ms, answer.widgetId).toBeLessThan(slow.ms);
    }
    // The slow one is cut off at the deadline and says so, as a state - not a zero.
    expect(slow.body.state).toBe('unavailable');
    expect(JSON.stringify(slow.body)).not.toMatch(/"value":0\b/);
    expect(slow.ms).toBeGreaterThanOrEqual(650);
    expect(slow.ms).toBeLessThan(3_000);
  });

  it('keeps requests to Matomo within the configured parallelism', async () => {
    await start({ queryTimeoutMs: 10_000, maxParallelQueries: 2 });
    // Long enough that requests overlap even on a busy machine, so the limit
    // is actually reached rather than never tested.
    probe.holdMs = 400;
    const periods = ['last_7_days', 'last_14_days', 'last_30_days', 'previous_month'];
    const responses = await Promise.all(
      periods.flatMap((period) =>
        WIDGETS.map((widgetId) =>
          tile(widgetId, `timeRange=${period}&comparison=none&breakpoint=desktop`),
        ),
      ),
    );
    for (const response of responses) expect(response.statusCode).toBe(200);
    expect(probe.calls).toBeGreaterThan(4);
    // Never more than the limit - and the limit was reached.
    expect(probe.maxActive).toBeLessThanOrEqual(2);
    expect(probe.maxActive).toBe(2);
  });

  it('asks Matomo once for a question many widgets ask at the same time', async () => {
    await start({ queryTimeoutMs: 10_000, maxParallelQueries: 6 });
    probe.holdMs = 100;
    const responses = await Promise.all(Array.from({ length: 10 }, () => tile('kpi-visits')));
    for (const response of responses) expect(response.json().state).toBe('ready');
    expect(probe.calls).toBe(1);
  });

  it('answers a repeated question from memory, until the cache entry expires', async () => {
    await start({ queryTimeoutMs: 10_000, maxParallelQueries: 6 });
    const first = await tile('kpi-visits');
    const callsAfterCold = probe.calls;
    const second = await tile('kpi-visits');
    expect(second.json().content).toEqual(first.json().content);
    expect(probe.calls).toBe(callsAfterCold);

    ctx.clock.advance(ctx.config.analytics.cacheTtlSeconds * 1000 + 1);
    await tile('kpi-visits');
    expect(probe.calls).toBe(callsAfterCold + 1);
  });

  describe('a Matomo that stalls', () => {
    let server: Server;
    let sockets = 0;
    let closed = 0;

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function stalling(mode: 'no_answer' | 'headers_only'): Promise<string> {
      sockets = 0;
      closed = 0;
      server = createServer((request, response) => {
        if (mode === 'headers_only') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('[');
        }
      });
      server.on('connection', (socket) => {
        sockets += 1;
        socket.on('close', () => (closed += 1));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    for (const mode of ['no_answer', 'headers_only'] as const) {
      it(`is cut off at the deadline and the connection closed (${mode})`, async () => {
        const baseUrl = await stalling(mode);
        const adapter = new HttpMatomoAdapter({
          clock: { now: () => new Date() },
          logger: (await createTestContext()).logger,
          requestTimeoutMs: 400,
          urlGuard: { allowPrivateNetwork: true },
        });
        const started = Date.now();
        await expect(
          adapter.listSites({ connectionId: 'c', baseUrl, token: 'abcdefgh12345' }),
        ).rejects.toMatchObject({ code: 'matomo_unreachable' });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(350);
        expect(elapsed).toBeLessThan(2_000);
        // The request was cancelled, not left hanging.
        await sleep(200);
        expect(sockets).toBeGreaterThan(0);
        expect(closed).toBe(sockets);
      });
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
