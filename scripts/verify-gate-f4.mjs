#!/usr/bin/env node
/**
 * Gate F4 demonstration.
 *
 * Runs the Phase 4 acceptance criteria from the Claude Code Development Plan
 * against a real stack and prints a pass/fail table:
 *
 *   - all D10 states demonstrable in fixture environment
 *   - no global cross-filter behavior
 *   - no `Live` badge unless a future real-time capability explicitly supports it
 *   - mobile Detail View is fully usable
 *   - charts have accessible data alternative
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f4.mjs [--skip-e2e] [--local-mysql]
 *
 * `WEB_PORT` in the environment overrides the one in `.env`, for a machine
 * where another program already holds the default port.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_E2E = process.argv.includes('--skip-e2e');
const LOCAL_MYSQL = process.argv.includes('--local-mysql');

const env = readEnvFile(path.join(ROOT, '.env'));
const API_URL = env.API_PUBLIC_URL ?? 'http://localhost:4000';
const WEB_PORT = process.env.WEB_PORT ?? env.WEB_PORT ?? '3000';
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_HEALTH_URL = `http://127.0.0.1:${Number(env.API_PORT ?? 4000) + 1}`;

const ADMIN_EMAIL = 'gate.f4@example.invalid';
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const EDITOR_EMAIL = 'editor.demo@example.invalid';
const VIEWER_EMAIL = 'viewer.demo@example.invalid';

const VIEW = 'timeRange=last_30_days&comparison=previous_period&breakpoint=desktop';

const results = [];
const children = [];

const ctx = {
  tenantId: '',
  projectId: '',
  dashboardId: '',
  stateDashboardId: '',
  tokens: {},
};

const E2E_ENV = () => ({
  ...process.env,
  WEB_PORT,
  E2E_BASE_URL: WEB_URL,
  E2E_ADMIN_EMAIL: ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD: PASSWORD,
  E2E_VIEWER_EMAIL: VIEWER_EMAIL,
  E2E_VIEWER_PASSWORD: PASSWORD,
});

async function main() {
  if ((env.APP_ENV ?? 'development') !== 'development') {
    throw new Error(`Refusing to run: APP_ENV is "${env.APP_ENV}", expected "development".`);
  }

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
    await runOrThrow('npm', ['run', 'db:migrate']);
    return 'applied to an empty schema';
  });

  await step('unit suite passes', async () => {
    const { stdout } = await runOrThrow('npm', ['run', 'test']);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests`;
  });

  await step('integration suite passes', async () => {
    const { stdout } = await runOrThrow('npm', ['run', 'test:integration']);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests`;
  });

  // The integration suite resets the database; start again from empty so the
  // fixture below is the only thing in it.
  await step('database reset for the fixture', async () => {
    await runOrThrow('npm', ['run', 'db:reset']);
    await runOrThrow('npm', ['run', 'db:migrate']);
    return 'empty schema';
  });

  await step('build artifacts exist', async () => {
    await runOrThrow('npm', ['run', 'build']);
    return 'web + api + worker built';
  });

  await step('api, worker and web start and report health', async () => {
    await startStack();
    const ready = await fetchJson(`${API_URL}/readyz`);
    if (ready.body.status !== 'ready') throw new Error('API readiness reported not_ready.');
    return `all three processes live, web on ${WEB_PORT}`;
  });

  await step('platform bootstrapped and fixture seeded', async () => {
    const { stdout: tokenOut } = await runOrThrow('npm', [
      'run',
      'bootstrap-admin',
      '--',
      '--json',
    ]);
    const token = JSON.parse(
      tokenOut.slice(tokenOut.indexOf('{'), tokenOut.lastIndexOf('}') + 1),
    ).token;

    const created = await postJson(`${API_URL}/platform/bootstrap/complete`, {
      token,
      email: ADMIN_EMAIL,
      firstName: 'Petra',
      lastName: 'Plattform',
      password: PASSWORD,
    });
    if (created.status !== 201) throw new Error(`Bootstrap failed: ${created.status}`);

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
    ctx.dashboardId = seeded.dashboard.dashboardId;
    ctx.stateDashboardId = seeded.stateModel?.dashboardId;
    if (!ctx.stateDashboardId) throw new Error('The seed produced no state-model dashboard.');

    ctx.tokens.editor = await signIn(EDITOR_EMAIL);
    ctx.tokens.viewer = await signIn(VIEWER_EMAIL);

    return `Portal Overview v${seeded.dashboard.publishedVersion}, Zustandsmodell v${seeded.stateModel.publishedVersion}`;
  });

  // --- Gate F4 criteria ----------------------------------------------------

  await step('every D10 value state is produced by the fixture', async () => {
    /*
     * Nine of the ten states come from a value; each is asked for as its own
     * tile, the way the viewer asks for it. The reason travels with the state:
     * "not tracked" without "why" would be half an answer (D10).
     */
    const expected = {
      ready: ['ready'],
      zero: ['zero'],
      empty: ['empty'],
      missing: ['missing', 'widget.missing.no_mapping'],
      unknown: ['unknown', 'matomo.value_unreadable'],
      notTracked: ['not_tracked', 'matomo.not_tracked_here'],
      notApplicable: ['not_applicable', 'matomo.not_applicable_here'],
      unavailable: ['unavailable', 'widget.source_unavailable'],
      warning: ['warning'],
    };

    const seen = [];
    for (const [name, [state, reason]] of Object.entries(expected)) {
      const tile = await getJson(
        `${API_URL}/dashboards/${ctx.stateDashboardId}/widgets/state-${name}?${VIEW}`,
        ctx.tokens.viewer,
      );
      if (tile.status !== 200) throw new Error(`${name}: HTTP ${tile.status}`);
      if (tile.body.state !== state) {
        throw new Error(`${name}: expected "${state}", got "${tile.body.state}"`);
      }
      const actualReason = tile.body.stateMessage?.messageKey ?? tile.body.unavailable?.messageKey;
      if (reason && actualReason !== reason) {
        throw new Error(`${name}: reason "${actualReason}", expected "${reason}"`);
      }
      if (state === 'warning' && tile.body.dataQuality.length === 0) {
        throw new Error('warning: no data-quality note says what the warning is.');
      }
      // Absence is never a zero (D10).
      if (!['ready', 'zero', 'warning'].includes(state)) {
        const formatted =
          tile.body.content?.kind === 'card'
            ? tile.body.content.metrics.map((metric) => metric.formatted)
            : [];
        if (formatted.includes('0')) throw new Error(`${name}: an absence was rendered as 0.`);
      }
      seen.push(state);
    }

    // The tenth: `loading`. The layout carries no values at all - every tile
    // starts in `loading` and fetches on its own. The browser run below reads
    // the streamed document and checks the fallbacks precede the values.
    const layout = await getJson(
      `${API_URL}/dashboards/${ctx.stateDashboardId}/layout?${VIEW}`,
      ctx.tokens.viewer,
    );
    if (layout.body.widgets.some((widget) => 'state' in widget || 'content' in widget)) {
      throw new Error('The layout carried values, so no tile would ever be seen loading.');
    }

    return `${seen.length + 1}/10: loading, ${seen.join(', ')}`;
  });

  await step('widgets load and fail independently', async () => {
    // One report down; the dashboard in one request still answers, with the
    // failure confined to its own widget (Master Spec §11).
    const whole = await getJson(
      `${API_URL}/dashboards/${ctx.stateDashboardId}/presentation?${VIEW}`,
      ctx.tokens.viewer,
    );
    if (whole.status !== 200) throw new Error(`The dashboard failed as a whole: ${whole.status}`);

    const states = Object.fromEntries(whole.body.widgets.map((w) => [w.widgetId, w.state]));
    if (states['state-unavailable'] !== 'unavailable') {
      throw new Error('The failing report did not surface as unavailable.');
    }
    const healthy = Object.values(states).filter((state) => state === 'ready').length;
    if (healthy === 0) throw new Error('The failure took its neighbours with it.');

    return `1 widget unavailable, ${healthy} ready beside it`;
  });

  await step('no global cross-filter', async () => {
    /*
     * The viewer's only analytics inputs are time range and comparison (D4).
     * A request that tries to smuggle in a filter or a dimension gets exactly
     * the answer it would have got without - the parameters are not part of
     * the viewer contract, so there is nothing to apply them to.
     */
    const plain = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/widgets/kpi-visits?${VIEW}`,
      ctx.tokens.viewer,
    );
    const smuggled = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/widgets/kpi-visits?${VIEW}` +
        '&filter=page_url%3D%2Fnews&dimension=page_url&crossFilter=table-top-pages',
      ctx.tokens.viewer,
    );
    if (JSON.stringify(plain.body.content) !== JSON.stringify(smuggled.body.content)) {
      throw new Error('An undeclared filter parameter changed a widget value.');
    }

    // And structurally: the viewer's control form declares two fields.
    const source = readFileSync(
      path.join(ROOT, 'apps/web/src/components/ViewerControls.tsx'),
      'utf8',
    );
    const fields = [...source.matchAll(/name="(\w+)"/g)].map((match) => match[1]).sort();
    if (JSON.stringify(fields) !== JSON.stringify(['comparison', 'timeRange'])) {
      throw new Error(`The viewer controls declare ${fields.join(', ')}.`);
    }

    return 'extra parameters inert; controls are timeRange + comparison only';
  });

  await step('no "Live" badge anywhere in the product', async () => {
    // Every user-facing string lives in the two catalogues. A live badge would
    // have to be worded somewhere, so that is where to look.
    const offenders = [];
    for (const locale of ['de', 'en']) {
      const messages = JSON.parse(
        readFileSync(path.join(ROOT, `apps/web/src/messages/${locale}.json`), 'utf8'),
      );
      const walk = (node, trail) => {
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === 'object' && value) walk(value, [...trail, key]);
          else if (/\blive\b|echtzeit|real[- ]?time/i.test(String(value))) {
            offenders.push(`${locale}:${[...trail, key].join('.')}`);
          }
        }
      };
      walk(messages, []);
    }
    if (offenders.length > 0) throw new Error(`Found: ${offenders.join(', ')}`);

    // What is stated instead: freshness, as a fact.
    const tile = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/widgets/kpi-visits?${VIEW}`,
      ctx.tokens.viewer,
    );
    if (!tile.body.freshness?.fetchedAt) throw new Error('No factual freshness was reported.');

    return 'no live/real-time wording; freshness stated as "Aktualisiert …"';
  });

  await step('the detail view inherits the dashboard context', async () => {
    const detail = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/widgets/kpi-visits/detail?timeRange=last_7_days&comparison=none&breakpoint=desktop`,
      ctx.tokens.viewer,
    );
    const layout = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/layout?timeRange=last_7_days&comparison=none&breakpoint=desktop`,
      ctx.tokens.viewer,
    );
    if (JSON.stringify(detail.body.timeRange) !== JSON.stringify(layout.body.timeRange)) {
      throw new Error('The detail view answered for a different period.');
    }
    if (detail.body.comparison) throw new Error('The detail view added a comparison.');
    if (detail.body.visualisation?.kind !== 'time_series') {
      throw new Error('A card opened without its larger visualisation.');
    }
    const export_ = detail.body.actions.find((action) => action.kind === 'export');
    if (export_?.available !== false || !export_.unavailableKey) {
      throw new Error('An unavailable action was offered without a reason.');
    }

    return 'same period, no added comparison, time series, actions state their availability';
  });

  if (!SKIP_E2E) {
    await step('mobile detail view is fully usable', async () => {
      const { stdout } = await runOrThrow(
        'npx',
        ['playwright', 'test', 'tests/e2e/viewer-detail.spec.ts', '--project=mobile-safari'],
        { env: E2E_ENV() },
      );
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} checks on a phone viewport`;
    });

    await step('charts have an accessible data alternative', async () => {
      const { stdout } = await runOrThrow(
        'npx',
        ['playwright', 'test', 'tests/e2e/', '-g', 'as.a.*table'],
        { env: E2E_ENV() },
      );
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} checks, desktop and phone`;
    });

    await step('the browser journey passes', async () => {
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], { env: E2E_ENV() });
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} browser checks`;
    });
  }

  report();
}

// --- process and transport helpers -----------------------------------------

// --- process and transport helpers -----------------------------------------

async function startStack() {
  await assertPortsFree();
  startProcess('api', 'node', ['apps/api/dist/main.js']);
  startProcess('worker', 'node', ['apps/worker/dist/main.js']);
  startProcess('web', 'node', ['apps/web/.next/standalone/apps/web/server.js'], {
    env: { PORT: String(WEB_PORT) },
  });

  await waitForHttp(`${API_URL}/livez`);
  await waitForHttp(`${WORKER_HEALTH_URL}/livez`);
  await waitForHttp(`${WEB_URL}/login`);
}

async function shutdownStack() {
  const running = children.splice(0, children.length);
  for (const { child } of running) await stopProcess(child);
  await delay(1500);
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    child.kill();
  }
  await Promise.race([once(child, 'close'), delay(5000)]);
}

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

async function signIn(email) {
  const response = await postJson(`${API_URL}/auth/login`, { email, password: PASSWORD });
  if (response.status !== 200) throw new Error(`Sign-in for ${email} failed: ${response.status}`);
  return response.body.token;
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function getJson(url, token) {
  return fetchJson(url, { headers: authHeaders(token) });
}

function postJson(url, payload, token) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
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
    await shutdownStack();
    process.exit(1);
  }
}

function report() {
  const passed = results.filter((result) => result.ok).length;
  console.log('');
  console.log(`Gate F4: ${passed}/${results.length} criteria demonstrated.`);
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
    stdio: 'ignore',
  });
  children.push({ name, child });
  return child;
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

main()
  .then(shutdownStack)
  .catch(async (error) => {
    console.error(`\nGate F4 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
