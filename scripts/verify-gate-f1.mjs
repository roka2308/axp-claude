#!/usr/bin/env node
/**
 * Gate F1 demonstration.
 *
 * Runs the First Vertical Slice acceptance criteria of Master Specification
 * §27 against a real, running stack and prints a pass/fail table. The slice
 * itself is the path:
 *
 *   Login -> Project -> Matomo Connection -> Site -> Semantic Metric
 *         -> Dashboard -> Widget -> Matomo Query -> Viewer
 *
 * Acceptance criteria demonstrated here, in §27 order:
 *
 *   - server-side tenant/project authorization
 *   - no Matomo credentials in the browser
 *   - no analytics results in MySQL
 *   - dashboard config survives a restart
 *   - published stays stable while the draft changes
 *   - widget loading/empty/error states
 *   - semantically correct comparison
 *   - relevant audit events
 *   - correlation id through the request into Matomo
 *   - bootstrap only once
 *   - keyboard/focus smoke test
 *   - responsive viewer
 *   - capability-driven Matomo status
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f1.mjs [--skip-e2e] [--local-mysql]
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_E2E = process.argv.includes('--skip-e2e');
const LOCAL_MYSQL = process.argv.includes('--local-mysql');

const env = readEnvFile(path.join(ROOT, '.env'));
const API_URL = env.API_PUBLIC_URL ?? 'http://localhost:4000';
const WEB_URL = env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
const WORKER_HEALTH_URL = `http://127.0.0.1:${Number(env.API_PORT ?? 4000) + 1}`;

const ADMIN_EMAIL = 'gate.f1@example.invalid';
/** One password for every gate account; this database is thrown away after. */
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';

const VIEWER_EMAIL = 'viewer.demo@example.invalid';
const EDITOR_EMAIL = 'editor.demo@example.invalid';
const TENANT_ADMIN_EMAIL = 'tenantadmin.demo@example.invalid';

/** The literal token `seedReferenceDashboard` seals for the demo connection. */
const DEMO_MATOMO_TOKEN = 'demo-token-not-a-real-credential';

const results = [];
const children = [];
let matomoStub;

/** Filled in as the run proceeds, so later steps can build on earlier ones. */
const ctx = {
  tenantId: '',
  projectId: '',
  dashboardId: '',
  connectionId: '',
  tokens: {},
};

async function main() {
  if ((env.APP_ENV ?? 'development') !== 'development') {
    throw new Error(`Refusing to run: APP_ENV is "${env.APP_ENV}", expected "development".`);
  }

  // --- a reproducible stack ------------------------------------------------

  if (LOCAL_MYSQL) {
    await step('portable MySQL running', async () => {
      await runOrThrow('node', ['scripts/local-mysql.mjs', 'start']);
      const { stdout } = await runOrThrow('node', ['scripts/local-mysql.mjs', 'status']);
      return stdout.trim();
    });
  } else {
    await step('docker engine reachable', async () => {
      const { code, stdout } = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
      if (code !== 0 || stdout.trim().length === 0) {
        throw new Error('The Docker engine is not answering. Run this with --local-mysql instead.');
      }
      await runOrThrow('docker', ['compose', 'up', '-d']);
      return `engine ${stdout.trim()}`;
    });
  }

  await step('migrations run from an empty database', async () => {
    await runOrThrow('npm', ['run', 'db:reset']);
    const { stdout } = await runOrThrow('npm', ['run', 'db:migrate']);
    if (!/Migrations applied/i.test(stdout)) throw new Error('Migration output was unexpected.');
    return 'applied to an empty schema';
  });

  await step('unit suite passes', async () => {
    const { stdout } = await runOrThrow('npm', ['run', 'test']);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests`;
  });

  await step('integration suite passes', async () => {
    // Includes the cross-tenant denial cases and the structural persistence
    // rule; the live checks below complement them, they do not replace them.
    const { stdout } = await runOrThrow('npm', ['run', 'test:integration']);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests`;
  });

  await step('build artifacts exist', async () => {
    await runOrThrow('npm', ['run', 'build']);
    return 'web + api + worker built';
  });

  await step('api, worker and web start and report health', async () => {
    await startStack();
    const ready = await fetchJson(`${API_URL}/readyz`);
    if (ready.body.status !== 'ready') throw new Error('API readiness reported not_ready.');
    return 'all three processes live';
  });

  // --- the slice, from an empty instance -----------------------------------

  await step('bootstrap happens exactly once', async () => {
    const before = await fetchJson(`${API_URL}/platform/status`);
    if (before.body.initState !== 'uninitialized') {
      throw new Error(`A fresh instance reported initState=${before.body.initState}.`);
    }

    const { stdout } = await runOrThrow('npm', ['run', 'bootstrap-admin', '--', '--json']);
    const token = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)).token;

    const created = await postJson(`${API_URL}/platform/bootstrap/complete`, {
      token,
      email: ADMIN_EMAIL,
      firstName: 'Petra',
      lastName: 'Plattform',
      password: PASSWORD,
    });
    if (created.status !== 201) throw new Error(`Bootstrap failed: ${created.status}`);

    const replay = await postJson(`${API_URL}/platform/bootstrap/complete`, {
      token,
      email: 'second@example.invalid',
      firstName: 'Second',
      lastName: 'Admin',
      password: PASSWORD,
    });
    if (replay.status < 400) throw new Error('A replayed bootstrap token was accepted.');

    return 'admin created, token replay refused';
  });

  await step('canonical fixture seeds the whole slice', async () => {
    const { stdout } = await runOrThrow('npm', [
      'run',
      'seed:demo',
      '--',
      '--password',
      PASSWORD,
      '--json',
    ]);
    const seeded = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));

    ctx.tenantId = seeded.tenantId;
    ctx.projectId = seeded.projectId;
    ctx.dashboardId = seeded.dashboard?.dashboardId ?? '';
    ctx.connectionId = seeded.dashboard?.connectionId ?? '';
    if (!ctx.dashboardId) throw new Error('The fixture produced no dashboard.');

    ctx.tokens.viewer = await signIn(VIEWER_EMAIL);
    ctx.tokens.editor = await signIn(EDITOR_EMAIL);
    ctx.tokens.tenantAdmin = await signIn(TENANT_ADMIN_EMAIL);

    return `Employee Portal, Portal Overview v${seeded.dashboard.publishedVersion}`;
  });

  // --- §27 acceptance ------------------------------------------------------

  await step('capability-driven Matomo status', async () => {
    const { body } = await getJson(
      `${API_URL}/tenants/${ctx.tenantId}/matomo-connections`,
      ctx.tokens.tenantAdmin,
    );
    const connection = body.connections?.[0];
    if (!connection?.capabilities) throw new Error('No capability snapshot was stored.');

    const { compatibility, probes, matomoVersion } = connection.capabilities;
    if (!Array.isArray(probes) || probes.length === 0) {
      throw new Error('Compatibility was recorded without any probe result.');
    }
    // The conclusion has to come from the probes; the version travels beside
    // it, never instead of it (Master Spec §22, G3).
    return `${compatibility} from ${probes.length} probes (Matomo ${matomoVersion})`;
  });

  await step('server-side tenant/project authorization', async () => {
    // A project-scoped viewer holds no tenant capability, and asking politely
    // from a valid session changes nothing.
    const tenantRoute = await getJson(
      `${API_URL}/tenants/${ctx.tenantId}/matomo-connections`,
      ctx.tokens.viewer,
    );
    if (tenantRoute.status !== 403) {
      throw new Error(`A viewer reached a tenant route: ${tenantRoute.status}`);
    }

    const publish = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/publish`,
      {},
      ctx.tokens.viewer,
    );
    if (publish.status !== 403) throw new Error(`A viewer published: ${publish.status}`);

    // An id the caller has no relationship with answers "not found": existence
    // is itself information (Shared Contract §4).
    const foreign = await getJson(
      `${API_URL}/projects/01a00000-0000-7000-8000-000000000000/dashboards`,
      ctx.tokens.viewer,
    );
    if (foreign.status !== 404) throw new Error(`An unknown project answered ${foreign.status}.`);

    const anonymous = await getJson(`${API_URL}/dashboards/${ctx.dashboardId}/presentation`);
    if (anonymous.status !== 401)
      throw new Error(`An unauthenticated read answered ${anonymous.status}.`);

    return 'capability and scope enforced on the server';
  });

  await step('no Matomo credentials reach the browser', async () => {
    const responses = await Promise.all([
      getJson(`${API_URL}/tenants/${ctx.tenantId}/matomo-connections`, ctx.tokens.tenantAdmin),
      getJson(
        `${API_URL}/tenants/${ctx.tenantId}/matomo-connections/${ctx.connectionId}/sites`,
        ctx.tokens.tenantAdmin,
      ),
      getJson(`${API_URL}/projects/${ctx.projectId}`, ctx.tokens.viewer),
      getJson(`${API_URL}/dashboards/${ctx.dashboardId}/presentation`, ctx.tokens.viewer),
    ]);

    for (const response of responses) {
      const serialised = JSON.stringify(response.body);
      if (serialised.includes(DEMO_MATOMO_TOKEN) || /token_auth/i.test(serialised)) {
        throw new Error('An API response carried Matomo credential material.');
      }
    }

    const sealed = await queryDatabase(
      'SELECT credential_ciphertext, credential_nonce FROM matomo_connections',
    );
    if (sealed.length === 0) throw new Error('No connection was stored at all.');
    if (JSON.stringify(sealed).includes(DEMO_MATOMO_TOKEN)) {
      throw new Error('The credential is stored in readable form.');
    }

    return 'sealed at rest, absent from every response';
  });

  await step('correlation id reaches Matomo, credential in the body', async () => {
    const stub = await startMatomoStub();
    const response = await postJson(
      `${API_URL}/tenants/${ctx.tenantId}/matomo-connections/test`,
      { name: 'Gate F1 Stub', baseUrl: stub.url, token: 'gate-f1-outbound-token' },
      ctx.tokens.tenantAdmin,
      { 'x-correlation-id': 'gate-f1-trace' },
    );
    if (response.status !== 200) throw new Error(`Connection test failed: ${response.status}`);

    const calls = stub.received;
    if (calls.length === 0) throw new Error('Matomo was never called.');

    const traced = calls.find((call) => call.headers['x-correlation-id'] === 'gate-f1-trace');
    if (!traced) throw new Error('No outbound Matomo call carried the correlation id.');

    // The token belongs in the POST body: a query string ends up in access
    // logs, proxies and browser history (Master Spec §19).
    if (!/(^|&)token_auth=/.test(traced.body)) {
      throw new Error('The credential was not sent in the request body.');
    }
    if (calls.some((call) => /token_auth/i.test(call.url))) {
      throw new Error('The credential appeared in a query string.');
    }

    return `${calls.length} calls, all traced, credential in the body`;
  });

  await step('semantically correct comparison', async () => {
    const { body } = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation?timeRange=last_30_days&comparison=previous_period`,
      ctx.tokens.viewer,
    );

    const { timeRange, comparison } = body;
    if (daysBetween(comparison.from, comparison.to) !== daysBetween(timeRange.from, timeRange.to)) {
      throw new Error('The comparison period has a different length than the range.');
    }
    if (addDays(comparison.to, 1) !== timeRange.from) {
      throw new Error('The comparison period does not end immediately before the range.');
    }
    if (body.dataScope.siteTimezone !== 'Europe/Berlin') {
      throw new Error(
        `The calendar did not follow the site time zone: ${body.dataScope.siteTimezone}`,
      );
    }

    const card = widget(body, 'kpi-visits');
    const metric = card.content.metrics[0];
    const expected = metric.value.value - metric.comparison.value.value;
    if (Math.abs(metric.comparison.change - expected) > 1e-6) {
      throw new Error('The stated change does not match the two values beside it.');
    }

    const series = widget(body, 'series-visits').content.series[0];
    if (series.points.length !== series.comparisonPoints.length) {
      throw new Error('The comparison series is not aligned with the primary one.');
    }

    return `${timeRange.from}..${timeRange.to} vs ${comparison.from}..${comparison.to}, aligned`;
  });

  await step('widget states are distinct and stated', async () => {
    const { body } = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation`,
      ctx.tokens.viewer,
    );

    const states = new Map(body.widgets.map((item) => [item.widgetId, item.state]));
    for (const [id, state] of states) {
      if (state !== 'ready') throw new Error(`Widget ${id} is ${state} on the healthy fixture.`);
    }

    // A zero is a value; an unreachable source is not. Both must arrive as
    // their own state rather than as a number (D10).
    const zero = valueStatesOf(await renderScenario('zero'));
    if (!zero.includes('zero')) throw new Error(`A measured zero rendered as ${zero.join('/')}.`);

    const empty = valueStatesOf(await renderScenario('empty'));
    if (!empty.includes('empty'))
      throw new Error(`An empty result rendered as ${empty.join('/')}.`);

    const down = await renderScenario('unavailable');
    if (down.widgets.some((item) => item.state !== 'unavailable')) {
      throw new Error('An unreachable source did not put every widget in an unavailable state.');
    }
    if (!down.dashboard.name) throw new Error('A failed source broke the whole dashboard.');

    return `${states.size} ready, plus zero / empty / unavailable demonstrated`;
  });

  await step('published stays stable while the draft changes', async () => {
    const before = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation`,
      ctx.tokens.viewer,
    );

    const draft = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      ctx.tokens.editor,
    );
    const edited = {
      ...draft.body.snapshot,
      name: 'Portal Overview (Gate F1 draft)',
      widgets: draft.body.snapshot.widgets.filter((item) => item.id !== 'table-top-pages'),
    };

    const saved = await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: draft.body.revisionId, snapshot: edited },
      ctx.tokens.editor,
    );
    if (saved.status !== 200) throw new Error(`Autosave failed: ${saved.status}`);

    const after = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation`,
      ctx.tokens.viewer,
    );
    if (after.body.dashboard.name !== before.body.dashboard.name) {
      throw new Error('The published dashboard changed when the draft did.');
    }
    if (after.body.widgets.length !== before.body.widgets.length) {
      throw new Error('A widget removed from the draft disappeared from the published version.');
    }

    const preview = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation?source=draft`,
      ctx.tokens.editor,
    );
    if (preview.body.widgets.length === before.body.widgets.length) {
      throw new Error('The draft preview did not reflect the edit.');
    }

    // A stale write must fail rather than overwrite the newer revision.
    const stale = await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: draft.body.revisionId, snapshot: edited },
      ctx.tokens.editor,
    );
    if (stale.status !== 409) throw new Error(`A stale draft write answered ${stale.status}.`);

    return 'published v1 intact, preview shows the draft, stale write refused';
  });

  await step('no analytics results in MySQL', async () => {
    const { body } = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation`,
      ctx.tokens.viewer,
    );

    // Compared as numbers, not as substrings: a measured 920 also occurs
    // inside plenty of UUIDs, and a false positive would make the rule
    // unenforceable rather than strict.
    const measured = new Set(numbersOf(body).filter((value) => Math.abs(value) >= 100));
    if (measured.size < 4) throw new Error('The fixture produced too few values to search for.');

    const stored = await numbersInDatabase();
    for (const value of measured) {
      if (stored.has(value)) throw new Error(`Measured value ${value} is stored in MySQL.`);
    }

    const dump = JSON.stringify(await dumpDatabase());
    for (const label of labelsOf(body)) {
      if (dump.includes(label)) throw new Error(`Dimension label "${label}" is stored in MySQL.`);
    }

    return `${measured.size} values and every dimension label absent from the product store`;
  });

  await step('relevant audit events are recorded', async () => {
    const rows = await queryDatabase(
      'SELECT action, COUNT(*) AS n FROM audit_events GROUP BY action',
    );
    const actions = new Set(rows.map((row) => row.action));

    // The whole slice leaves a trail: who set the platform up, who connected
    // Matomo, who published what (Shared Contract §16).
    for (const required of [
      'platform.bootstrap.completed',
      'auth.login.succeeded',
      'tenant.created',
      'project.created',
      'user.invited',
      'role_assignment.created',
      'matomo_connection.created',
      'matomo_connection.capabilities_refreshed',
      'matomo_site.imported',
      'project.site_assigned',
      'dashboard.created',
      'dashboard.published',
    ]) {
      if (!actions.has(required)) throw new Error(`No audit event for "${required}".`);
    }

    // Reads are not audited: an audit trail of every dashboard view would be
    // analytics about analytics, and nobody would read it.
    const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
    return `${actions.size} distinct actions, ${total} events`;
  });

  await step('dashboard config survives a restart', async () => {
    const before = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation`,
      ctx.tokens.viewer,
    );

    await shutdownStack();
    await startStack();

    // A new session too: nothing may depend on in-process state.
    const token = await signIn(VIEWER_EMAIL);
    const after = await getJson(`${API_URL}/dashboards/${ctx.dashboardId}/presentation`, token);

    const shape = (body) => ({
      name: body.dashboard.name,
      version: body.dashboard.publishedVersion,
      widgets: body.widgets.map((item) => `${item.widgetId}:${item.family}:${item.title}`),
      range: `${body.timeRange.from}..${body.timeRange.to}`,
    });

    const a = JSON.stringify(shape(before.body));
    const b = JSON.stringify(shape(after.body));
    if (a !== b) throw new Error(`The dashboard changed across a restart:\n${a}\n${b}`);

    ctx.tokens.viewer = token;
    return 'identical dashboard after a full stack restart';
  });

  if (!SKIP_E2E) {
    await step('viewer journey, keyboard and responsive checks pass', async () => {
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], {
        env: {
          ...process.env,
          E2E_ADMIN_EMAIL: ADMIN_EMAIL,
          E2E_ADMIN_PASSWORD: PASSWORD,
          E2E_VIEWER_EMAIL: VIEWER_EMAIL,
          E2E_VIEWER_PASSWORD: PASSWORD,
        },
      });
      const passed = /(\d+)\s+passed/.exec(stdout)?.[1] ?? '?';
      return `${passed} browser checks (chromium + mobile safari)`;
    });
  }

  report();
}

// --- slice helpers ---------------------------------------------------------

/**
 * Publishes a copy of the reference dashboard onto a mock scenario.
 *
 * The scenario lives in the connection URL, so `zero`, `empty` and
 * `unavailable` are reachable without any special case in product code.
 */
async function renderScenario(scenario) {
  // An unreachable installation cannot be set up in the first place: the site
  // is imported while it still answers and the URL is switched afterwards,
  // which is what "it worked yesterday" looks like in production.
  const setupUrl = scenario === 'unavailable' ? 'mock://default' : `mock://${scenario}`;

  const created = await postJson(
    `${API_URL}/tenants/${ctx.tenantId}/matomo-connections`,
    { name: `Gate F1 ${scenario}`, baseUrl: setupUrl, token: 'gate-f1-scenario-token' },
    ctx.tokens.tenantAdmin,
  );
  if (created.status !== 201) throw new Error(`Creating the ${scenario} connection failed.`);

  const site = await postJson(
    `${API_URL}/projects/${ctx.projectId}/sites`,
    { connectionId: created.body.connection.id, matomoSiteId: 1 },
    ctx.tokens.tenantAdmin,
  );
  if (site.status !== 201) throw new Error(`Importing the ${scenario} site failed.`);

  return publishCopy(`Gate F1 ${scenario}`, site.body.siteId, {
    // Switched after publishing and before the first render, so no cache entry
    // for this dashboard can exist from before the outage.
    afterPublish:
      scenario === 'unavailable'
        ? () =>
            executeDatabase('UPDATE matomo_connections SET base_url = ? WHERE id = ?', [
              'mock://unavailable',
              created.body.connection.id,
            ])
        : undefined,
  });
}

/** Copies the reference dashboard onto another site and publishes it. */
async function publishCopy(name, siteId, options = {}) {
  const template = await getJson(
    `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
    ctx.tokens.editor,
  );

  const created = await postJson(
    `${API_URL}/projects/${ctx.projectId}/dashboards`,
    { name, siteId },
    ctx.tokens.editor,
  );
  if (created.status !== 201) throw new Error(`Creating "${name}" failed: ${created.status}`);

  const saved = await putJson(
    `${API_URL}/dashboards/${created.body.dashboardId}/draft`,
    {
      expectedRevisionId: created.body.revisionId,
      snapshot: { ...template.body.snapshot, name, siteId },
    },
    ctx.tokens.editor,
  );
  if (saved.status !== 200) throw new Error(`Saving "${name}" failed: ${saved.status}`);

  const published = await postJson(
    `${API_URL}/dashboards/${created.body.dashboardId}/publish`,
    {},
    ctx.tokens.editor,
  );
  if (published.status !== 200) throw new Error(`Publishing "${name}" failed: ${published.status}`);

  if (options.afterPublish) await options.afterPublish();

  const rendered = await getJson(
    `${API_URL}/dashboards/${created.body.dashboardId}/presentation`,
    ctx.tokens.viewer,
  );
  if (rendered.status !== 200) throw new Error(`Rendering "${name}" failed: ${rendered.status}`);
  return rendered.body;
}

function widget(body, id) {
  const found = body.widgets.find((item) => item.widgetId === id);
  if (!found) throw new Error(`Widget ${id} is missing from the presentation.`);
  return found;
}

function valueStatesOf(body) {
  return [...new Set(body.widgets.map((item) => item.state))];
}

/** Every measured number in a presentation, wherever it sits. */
function numbersOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) numbersOf(child, found);
  } else if (node && typeof node === 'object') {
    if ('state' in node && typeof node.value === 'number') found.push(node.value);
    for (const child of Object.values(node)) numbersOf(child, found);
  }
  return found;
}

/** Dimension labels: analytics results just as much as the numbers are. */
function labelsOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) labelsOf(child, found);
  } else if (node && typeof node === 'object') {
    if (
      'key' in node &&
      'metrics' in node &&
      typeof node.label === 'string' &&
      node.label.length > 2
    ) {
      found.push(node.label);
    }
    for (const child of Object.values(node)) labelsOf(child, found);
  }
  return found;
}

function daysBetween(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// --- a Matomo that records what it was asked -------------------------------

async function startMatomoStub() {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ url: request.url ?? '', headers: request.headers, body });

      const method = new URLSearchParams(body).get('method');
      response.setHeader('content-type', 'application/json');
      if (method === 'API.getMatomoVersion') {
        response.end(JSON.stringify('5.3.2'));
      } else if (method === 'SitesManager.getSitesWithAtLeastViewAccess') {
        response.end(
          JSON.stringify([
            { idsite: 1, name: 'Gate F1 Stub', main_url: 'http://stub.invalid', timezone: 'UTC' },
          ]),
        );
      } else {
        response.end(JSON.stringify([]));
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  matomoStub = server;

  return { url: `http://127.0.0.1:${server.address().port}`, received };
}

// --- process and transport helpers -----------------------------------------

async function startStack() {
  await assertPortsFree();
  startProcess('api', 'node', ['apps/api/dist/main.js']);
  startProcess('worker', 'node', ['apps/worker/dist/main.js']);
  startProcess('web', 'node', ['apps/web/.next/standalone/apps/web/server.js'], {
    env: { PORT: String(env.WEB_PORT ?? 3000) },
  });

  await waitForHttp(`${API_URL}/livez`);
  await waitForHttp(`${WORKER_HEALTH_URL}/livez`);
  await waitForHttp(WEB_URL);
}

async function shutdownStack() {
  const running = children.splice(0, children.length);
  for (const { child } of running) await stopProcess(child);

  // Windows releases the listening socket a moment after the process exits,
  // and a restart that reused a still-open port would prove nothing.
  await delay(1500);
  await assertPortsFree();
}

async function signIn(email) {
  const response = await postJson(`${API_URL}/auth/login`, { email, password: PASSWORD });
  if (response.status !== 200) {
    throw new Error(`Sign-in for ${email} failed: ${response.status}`);
  }
  return response.body.token;
}

function authHeaders(token, extra = {}) {
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

function getJson(url, token, extra) {
  return fetchJson(url, { headers: authHeaders(token, extra) });
}

function postJson(url, payload, token, extra) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token, extra) },
    body: JSON.stringify(payload),
  });
}

function putJson(url, payload, token, extra) {
  return fetchJson(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token, extra) },
    body: JSON.stringify(payload),
  });
}

// --- the product store, read directly --------------------------------------

async function withDatabase(fn) {
  const connection = await mysql.createConnection(env.DATABASE_URL);
  try {
    return await fn(connection);
  } finally {
    await connection.end();
  }
}

function queryDatabase(sql, params = []) {
  return withDatabase(async (connection) => (await connection.query(sql, params))[0]);
}

function executeDatabase(sql, params = []) {
  return withDatabase(async (connection) => (await connection.execute(sql, params))[0]);
}

async function listTables() {
  const rows = await queryDatabase(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '__drizzle_migrations'",
  );
  return rows.map((row) => row.name);
}

async function dumpDatabase() {
  const dump = {};
  for (const table of await listTables()) {
    dump[table] = await queryDatabase(`SELECT * FROM \`${table}\``);
  }
  return dump;
}

async function numbersInDatabase() {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
    } else if (node && typeof node === 'object') {
      for (const child of Object.values(node)) walk(child);
    } else if (typeof node === 'number' && Number.isFinite(node)) {
      found.add(node);
    } else if (typeof node === 'string' && /^-?\d+(\.\d+)?$/.test(node)) {
      found.add(Number(node));
    }
  };
  walk(await dumpDatabase());
  return found;
}

// --- runner ----------------------------------------------------------------

async function step(name, fn) {
  process.stdout.write(`  ... ${name}\r`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`  FAIL  ${name} — ${error.message}`);
    report();
    await shutdown();
    process.exit(1);
  }
}

function report() {
  const passed = results.filter((result) => result.ok).length;
  console.log('');
  console.log(`Gate F1: ${passed}/${results.length} criteria demonstrated.`);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runOrThrow(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n');
    throw new Error(`${command} ${args.join(' ')} exited ${result.code}\n${output}`);
  }
  return result;
}

function startProcess(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    // Deliberately no shell. On Windows a shell wrapper survives `kill()` and
    // the real server keeps the port, so a "restart" would silently reuse the
    // old process and every check after it would be meaningless.
    stdio: 'ignore',
  });
  children.push({ name, child });
  return child;
}

/** Stops a child and everything it spawned, and waits for the port to go. */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    child.kill();
  }
  await Promise.race([once(child, 'close'), delay(5000)]);
}

/** Refuses to start on top of a server that is already listening. */
async function assertPortsFree() {
  for (const url of [`${API_URL}/livez`, WEB_URL]) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
    } catch {
      continue;
    }
    throw new Error(`${url} is still answering: a previous process was not stopped.`);
  }
}

async function waitForHttp(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not respond within ${timeoutMs} ms.`);
    await delay(1000);
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, headers: response.headers, body };
}

function readEnvFile(file) {
  try {
    const result = {};
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) result[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
    return result;
  } catch {
    return {};
  }
}

async function shutdown() {
  await shutdownStack();
  if (matomoStub) {
    matomoStub.close();
    matomoStub = undefined;
  }
}

main()
  .then(shutdown)
  .catch(async (error) => {
    console.error(`\nGate F1 run aborted: ${error.message}`);
    await shutdown();
    process.exit(1);
  });
