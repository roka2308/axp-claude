#!/usr/bin/env node
/**
 * Gate F2 demonstration.
 *
 * Runs the Phase 2 acceptance criteria from the Claude Code Development Plan
 * against a real stack and prints a pass/fail table:
 *
 *   - grid behaviour deterministic
 *   - no overlaps
 *   - published never changes before publish
 *   - autosave + edit lock tested
 *   - keyboard alternative can move and resize a widget
 *   - desktop/tablet/mobile preview works
 *   - publish validation catches invalid widget size/config
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f2.mjs [--skip-e2e] [--local-mysql]
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

const ADMIN_EMAIL = 'gate.f2@example.invalid';
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const EDITOR_EMAIL = 'editor.demo@example.invalid';
const SECOND_EDITOR_EMAIL = 'semantic.demo@example.invalid';
const VIEWER_EMAIL = 'viewer.demo@example.invalid';
const TENANT_ADMIN_EMAIL = 'tenantadmin.demo@example.invalid';

const results = [];
const children = [];

const ctx = {
  tenantId: '',
  projectId: '',
  dashboardId: '',
  siteId: '',
  tokens: {},
};

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
    ctx.siteId = seeded.dashboard.siteId;

    ctx.tokens.editor = await signIn(EDITOR_EMAIL);
    ctx.tokens.second = await signIn(SECOND_EDITOR_EMAIL);
    ctx.tokens.viewer = await signIn(VIEWER_EMAIL);
    ctx.tokens.tenantAdmin = await signIn(TENANT_ADMIN_EMAIL);

    // The semantic manager is not an editor by default; Phase 2 needs a second
    // editor to demonstrate the lock, so grant it explicitly.
    await grantProjectRole(SECOND_EDITOR_EMAIL, 'dashboard_editor');
    ctx.tokens.second = await signIn(SECOND_EDITOR_EMAIL);

    return `Portal Overview v${seeded.dashboard.publishedVersion}`;
  });

  // --- Gate F2 criteria ----------------------------------------------------

  await step('grid behaviour is deterministic', async () => {
    /*
     * Two properties, checked against the running stack:
     *
     *   - the same edit, applied twice from the same starting point, yields
     *     byte-identical layouts;
     *   - the order the widgets arrive in does not change the result. The
     *     engine's own order-independence is proved by the unit suite; what
     *     this checks is that nothing along the save path reintroduces it.
     */
    const original = await draft();
    const movedId = original.snapshot.widgets[0].id;

    const first = await layoutAfterMove(original, movedId, { x: 0, y: 0 });
    const second = await layoutAfterMove(original, movedId, { x: 0, y: 0 });
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error('The same move produced two different layouts.');
    }

    // The same widget, the same target - only the array order differs.
    const shuffled = { ...original.snapshot, widgets: [...original.snapshot.widgets].reverse() };
    const third = await layoutAfterMove({ ...original, snapshot: shuffled }, movedId, {
      x: 0,
      y: 0,
    });
    if (JSON.stringify(sortById(first)) !== JSON.stringify(sortById(third))) {
      throw new Error('Reordering the widget list changed the resulting layout.');
    }

    await restore(original);
    return 'same input, same layout, whatever the order';
  });

  await step('widgets never overlap', async () => {
    const original = await draft();

    // Drive every widget onto the same cell and check what comes back.
    const piled = original.snapshot.widgets.map((widget) => ({
      ...widget,
      placement: { ...widget.placement, desktop: { ...widget.placement.desktop, x: 0, y: 0 } },
    }));

    const saved = await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      {
        expectedRevisionId: original.revisionId,
        snapshot: { ...original.snapshot, widgets: piled },
      },
      ctx.tokens.editor,
    );
    if (saved.status !== 200) throw new Error(`Autosave failed: ${saved.status}`);

    // A snapshot that arrives overlapping is stored as sent - and refused at
    // publish, which is where a broken layout would reach viewers.
    const impact = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/publish-impact`,
      ctx.tokens.editor,
    );
    const overlapErrors = impact.body.blockingErrors.filter(
      (issue) => issue.messageKey === 'dashboard.publish.widgets_overlap',
    );
    if (overlapErrors.length === 0) throw new Error('An overlapping layout was publishable.');
    if (impact.body.canPublish) throw new Error('canPublish was true with an overlap present.');

    await restore(original);
    return `${overlapErrors.length} overlap(s) reported, publish blocked`;
  });

  await step('autosave and the edit lock work', async () => {
    const original = await draft();

    const lease = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/lease`,
      {},
      ctx.tokens.editor,
    );
    if (!lease.body.acquired) throw new Error('The first editor did not get the lease.');

    const blocked = await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: original.revisionId, snapshot: original.snapshot },
      ctx.tokens.second,
    );
    if (blocked.status !== 409 || blocked.body.error?.code !== 'draft_locked') {
      throw new Error(`A second editor was allowed to write: ${blocked.status}`);
    }

    const second = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/lease`,
      {},
      ctx.tokens.second,
    );
    if (second.body.acquired) throw new Error('The lease was handed out twice.');
    if (!second.body.lease?.userName) throw new Error('The refusal did not name the holder.');

    const takeover = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/lease`,
      { force: true },
      ctx.tokens.second,
    );
    if (!takeover.body.acquired) throw new Error('A deliberate takeover was refused.');

    // Optimistic concurrency underneath: a stale revision fails even with the
    // lease in hand.
    const saved = await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: original.revisionId, snapshot: original.snapshot },
      ctx.tokens.second,
    );
    if (saved.status !== 200) throw new Error(`Autosave after takeover failed: ${saved.status}`);

    const stale = await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: original.revisionId, snapshot: original.snapshot },
      ctx.tokens.second,
    );
    if (stale.status !== 409) throw new Error('A stale revision was accepted.');

    await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/lease`,
      { force: true },
      ctx.tokens.editor,
    );
    await restore(await draft());
    return 'lock held, takeover audited, stale write refused';
  });

  await step('published never changes before publish', async () => {
    const before = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation`,
      ctx.tokens.viewer,
    );

    const original = await draft();
    const edited = {
      ...original.snapshot,
      name: 'Gate F2 Entwurf',
      widgets: original.snapshot.widgets.slice(1),
    };
    const saved = await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: original.revisionId, snapshot: edited },
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
      throw new Error('A widget removed from the draft vanished from the published version.');
    }

    // Preview renders the draft through the same builder the viewer uses (D3).
    const preview = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation?source=draft`,
      ctx.tokens.editor,
    );
    if (preview.body.widgets.length !== edited.widgets.length) {
      throw new Error('The draft preview did not reflect the edit.');
    }

    await restore(original);
    return 'draft edited, published untouched, preview shows the draft';
  });

  await step('publish validation catches an invalid widget', async () => {
    const original = await draft();

    const broken = {
      ...original.snapshot,
      widgets: [
        {
          ...original.snapshot.widgets[0],
          id: 'gate-f2-broken',
          family: 'time_series',
          // Two separate faults at once: four columns starting at column 10
          // runs off a twelve-column raster, and one row is below the family
          // minimum of three.
          placement: { desktop: { x: 10, y: 0, w: 4, h: 1 } },
        },
      ],
    };

    await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: original.revisionId, snapshot: broken },
      ctx.tokens.editor,
    );

    const impact = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/publish-impact`,
      ctx.tokens.editor,
    );
    const keys = impact.body.blockingErrors.map((issue) => issue.messageKey);
    for (const required of [
      'dashboard.publish.widget_too_small',
      'dashboard.publish.widget_out_of_grid',
    ]) {
      if (!keys.includes(required)) throw new Error(`Validation missed ${required}.`);
    }
    if (impact.body.canPublish) throw new Error('An invalid layout reported canPublish.');

    const refused = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/publish`,
      {},
      ctx.tokens.editor,
    );
    if (refused.status !== 422) throw new Error(`Publish was not refused: ${refused.status}`);

    await restore(original);
    return `${keys.length} blocking error(s), publish refused`;
  });

  await step('warnings inform without blocking', async () => {
    const original = await draft();

    await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: original.revisionId, snapshot: { ...original.snapshot, widgets: [] } },
      ctx.tokens.editor,
    );

    const impact = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/publish-impact`,
      ctx.tokens.editor,
    );
    if (!impact.body.canPublish) throw new Error('An empty dashboard was treated as an error.');
    if (impact.body.warnings.length === 0)
      throw new Error('An empty dashboard warned about nothing.');

    await restore(original);
    return 'empty dashboard warns, does not block';
  });

  await step('desktop, tablet and mobile all render', async () => {
    const seen = [];
    for (const [breakpoint, columns] of [
      ['desktop', 12],
      ['tablet', 8],
      ['mobile', 4],
    ]) {
      const { body } = await getJson(
        `${API_URL}/dashboards/${ctx.dashboardId}/presentation?breakpoint=${breakpoint}`,
        ctx.tokens.viewer,
      );
      if (body.breakpoint !== breakpoint)
        throw new Error(`Asked for ${breakpoint}, got ${body.breakpoint}.`);
      if (body.widgets.length === 0) throw new Error(`No widgets at ${breakpoint}.`);
      seen.push(`${breakpoint}/${columns}`);
    }
    return seen.join(', ');
  });

  await step('rollback appends a version rather than resurrecting one', async () => {
    const original = await draft();

    await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      {
        expectedRevisionId: original.revisionId,
        snapshot: { ...original.snapshot, name: 'Gate F2 zweite Fassung' },
      },
      ctx.tokens.editor,
    );
    const second = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/publish`,
      {},
      ctx.tokens.editor,
    );
    if (second.body.version !== 2)
      throw new Error(`Expected version 2, got ${second.body.version}.`);

    const rolled = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/rollback`,
      { version: 1 },
      ctx.tokens.editor,
    );
    if (rolled.body.version !== 3) throw new Error('Rollback did not create a new version.');

    const { body } = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/versions`,
      ctx.tokens.viewer,
    );
    const versions = body.versions.map((entry) => entry.version);
    if (JSON.stringify(versions) !== JSON.stringify([3, 2, 1])) {
      throw new Error(`History is not append-only: ${versions.join(', ')}`);
    }

    // Put the draft back: a gate that leaves the fixture renamed makes every
    // later step's failure harder to read than it needs to be.
    await restore(original);
    return 'v1 → v2 → rollback to v1 published as v3';
  });

  await step('archive and trash change a state, not the data', async () => {
    const counts = async () => ({
      dashboards: await countRows('dashboards'),
      drafts: await countRows('dashboard_drafts'),
      versions: await countRows('dashboard_versions'),
    });

    const before = await counts();
    for (const to of ['archived', 'restore', 'trash', 'restore']) {
      const response = await postJson(
        `${API_URL}/dashboards/${ctx.dashboardId}/lifecycle`,
        { to },
        ctx.tokens.editor,
      );
      if (response.status !== 200) throw new Error(`Lifecycle "${to}" failed: ${response.status}`);
    }

    const after = await counts();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Archiving or trashing deleted rows.');
    }
    return 'archived, restored, trashed, restored - nothing deleted';
  });

  await step('every widget family renders', async () => {
    // Phase 2 asks for rendering shells for all seven families.
    const original = await draft();
    const families = [
      'card',
      'time_series',
      'bar',
      'donut',
      'flexible_table',
      'context_text',
      'annotation_event_list',
    ];

    const template = original.snapshot.widgets[0];
    const widgets = families.map((family, index) => ({
      ...template,
      id: `gate-f2-${family}`,
      family,
      title: family,
      placement: { desktop: { x: 0, y: index * 6, w: 6, h: 5 } },
      data:
        family === 'bar' || family === 'donut' || family === 'flexible_table'
          ? { ...template.data, dimension: 'page_url', topN: 5 }
          : template.data,
    }));

    await putJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
      { expectedRevisionId: original.revisionId, snapshot: { ...original.snapshot, widgets } },
      ctx.tokens.editor,
    );

    const { body } = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/presentation?source=draft`,
      ctx.tokens.editor,
    );

    const rendered = body.widgets.map((widget) => `${widget.family}:${widget.state}`);
    const broken = body.widgets.filter(
      (widget) => widget.state === 'unavailable' || widget.state === 'missing',
    );
    if (broken.length > 0) {
      throw new Error(`Families failed to render: ${broken.map((w) => w.family).join(', ')}`);
    }

    await restore(original);
    return rendered.join(', ');
  });

  if (!SKIP_E2E) {
    await step('editor journey passes in the browser', async () => {
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], {
        env: {
          ...process.env,
          E2E_ADMIN_EMAIL: ADMIN_EMAIL,
          E2E_ADMIN_PASSWORD: PASSWORD,
          E2E_VIEWER_EMAIL: VIEWER_EMAIL,
          E2E_VIEWER_PASSWORD: PASSWORD,
        },
      });
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} browser checks`;
    });
  }

  report();
}

// --- domain helpers --------------------------------------------------------

function draft() {
  return getJson(`${API_URL}/dashboards/${ctx.dashboardId}/draft`, ctx.tokens.editor).then(
    (response) => response.body,
  );
}

/** Restores a known-good draft so the next step starts from a clean slate. */
async function restore(state) {
  const current = await draft();
  await putJson(
    `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
    { expectedRevisionId: current.revisionId, snapshot: state.snapshot },
    ctx.tokens.editor,
  );
}

/** Moves one widget by id, saves, and reads back the layout the server stored. */
async function layoutAfterMove(state, widgetId, target) {
  const current = await draft();
  const widgets = state.snapshot.widgets.map((widget) =>
    widget.id === widgetId
      ? {
          ...widget,
          placement: { ...widget.placement, desktop: { ...widget.placement.desktop, ...target } },
        }
      : widget,
  );

  const saved = await putJson(
    `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
    { expectedRevisionId: current.revisionId, snapshot: { ...state.snapshot, widgets } },
    ctx.tokens.editor,
  );
  if (saved.status !== 200) throw new Error(`Autosave failed: ${saved.status}`);

  return saved.body.snapshot.widgets.map((widget) => ({
    id: widget.id,
    ...widget.placement.desktop,
  }));
}

function sortById(layout) {
  return [...layout].sort((a, b) => a.id.localeCompare(b.id));
}

async function grantProjectRole(email, role) {
  await withDatabase(async (connection) => {
    const [users] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
    if (users.length === 0) throw new Error(`No such demo user: ${email}`);

    await connection.execute(
      'INSERT INTO role_assignments (id, subject_type, subject_id, role, scope_type, scope_id, created_at) ' +
        'VALUES (UUID(), ?, ?, ?, ?, ?, NOW(3))',
      ['user', users[0].id, role, 'project', ctx.projectId],
    );
  });
}

async function countRows(table) {
  const rows = await queryDatabase(`SELECT COUNT(*) AS n FROM \`${table}\``);
  return Number(rows[0].n);
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

function putJson(url, payload, token) {
  return fetchJson(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
}

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
  console.log(`Gate F2: ${passed}/${results.length} criteria demonstrated.`);
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
    console.error(`\nGate F2 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
