#!/usr/bin/env node
/**
 * Gate F5 demonstration.
 *
 * "A reviewer can answer `What can this user do, where, and why?` from the UI
 * without inspecting database rows." Runs the Phase 5 security tests, then
 * demonstrates against a real stack and the canonical fixture:
 *
 *   - every person's access is explained: each capability by a chain, each
 *     data verdict by both halves or by the half that is missing
 *   - the explanation agrees with what the request path actually does
 *   - Tenant Admin cannot assign Platform Admin
 *   - Platform Admin without an object grant cannot open customer analytics
 *   - group and direct grants accumulate; no deny rules exist
 *   - the impact preview predicts exactly what a change then does
 *   - deactivation ends every session at once
 *   - privileged changes are audited
 *   - the administration journey, in a browser, on desktop and phone
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f5.mjs [--skip-e2e] [--local-mysql]
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

const ADMIN_EMAIL = 'gate.f5@example.invalid';
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const VIEWER_EMAIL = 'viewer.demo@example.invalid';

/** The canonical fixture's accounts, by the role each one exercises. */
const ACCOUNTS = {
  viewer: VIEWER_EMAIL,
  editor: 'editor.demo@example.invalid',
  semantic: 'semantic.demo@example.invalid',
  tenantAdmin: 'tenantadmin.demo@example.invalid',
  platformAdmin: 'platformadmin.demo@example.invalid',
};

const VIEW = 'timeRange=last_30_days&comparison=previous_period&breakpoint=desktop';

const results = [];
const children = [];

const ctx = {
  tenantId: '',
  projectId: '',
  dashboardId: '',
  stateDashboardId: '',
  tokens: {},
  users: [],
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

  await step('the security tests pass', async () => {
    // The five Phase 5 security tests, by name, against real MySQL:
    // Tenant Admin cannot assign Platform Admin; Platform Admin without a data
    // grant cannot open customer analytics; group and direct grants
    // accumulate; no deny rules exist; deactivated user and session behaviour.
    const { stdout } = await runOrThrow('npx', [
      'vitest',
      'run',
      '--project',
      'integration',
      'tests/integration/access.test.ts',
    ]);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} access tests`;
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
    const seeded = await seedFixture();
    return `${ctx.users.length} people in ${seeded.tenantId ? 'the demo tenant' : '?'}, ${Object.keys(ctx.tokens).length} signed in`;
  });

  // --- Gate F5 criteria ----------------------------------------------------

  await step('every answer names its reasons', async () => {
    /*
     * The gate question, asked for every person in the tenant: what can they
     * do, where, and why. Every capability carries at least one chain; every
     * dashboard verdict is either granted with both halves named, or refused
     * with the missing half named. No answer needs a database row.
     */
    const catalogue = JSON.parse(
      readFileSync(path.join(ROOT, 'apps/web/src/messages/de.json'), 'utf8'),
    );
    const resolves = (key) =>
      typeof key.split('.').reduce((node, part) => node?.[part], catalogue) === 'string';

    let capabilities = 0;
    let verdicts = 0;
    for (const user of ctx.users) {
      const view = await getJson(
        `${API_URL}/admin/tenants/${ctx.tenantId}/users/${user.id}`,
        ctx.tokens.tenantAdmin,
      );
      if (view.status !== 200) throw new Error(`${user.email}: HTTP ${view.status}`);
      const { effective } = view.body;

      for (const scope of effective.scopes) {
        for (const entry of scope.capabilities) {
          assertReasons(entry.reasons, `${user.email} ${entry.capability} @ ${scope.scope.label}`);
          capabilities += 1;
        }
      }
      for (const dashboard of effective.dashboards) {
        for (const [kind, verdict] of Object.entries({
          view: dashboard.view,
          edit: dashboard.edit,
        })) {
          const where = `${user.email} ${kind} ${dashboard.name}`;
          if (verdict.granted) {
            assertReasons(verdict.roleReasons, `${where} (role)`);
            assertReasons(verdict.grantReasons, `${where} (grant)`);
          } else if (!verdict.missing) {
            throw new Error(`${where}: refused without naming what is missing.`);
          }
          verdicts += 1;
        }
      }
    }

    function assertReasons(reasons, where) {
      if (reasons.length === 0) throw new Error(`${where}: no reason given.`);
      for (const reason of reasons) {
        if (reason.chain.length === 0) throw new Error(`${where}: an empty chain.`);
        if (!resolves(reason.summaryKey)) {
          throw new Error(`${where}: "${reason.summaryKey}" has no wording.`);
        }
      }
    }

    return `${ctx.users.length} people, ${capabilities} capabilities and ${verdicts} data verdicts, each explained`;
  });

  await step('the answer is what the request path does', async () => {
    // Effective Access is not a second opinion: for every person who can sign
    // in and every dashboard, "may view" is exactly "the dashboard opens".
    let checked = 0;
    for (const [role, token] of Object.entries(ctx.tokens)) {
      const me = ctx.users.find((user) => user.email === ACCOUNTS[role]);
      if (!me) continue; // the platform admin is not a member of the tenant
      const { effective } = (
        await getJson(
          `${API_URL}/admin/tenants/${ctx.tenantId}/users/${me.id}`,
          ctx.tokens.tenantAdmin,
        )
      ).body;
      for (const dashboard of effective.dashboards) {
        const opened = await getJson(`${API_URL}/dashboards/${dashboard.id}/layout?${VIEW}`, token);
        const opens = opened.status === 200;
        if (opens !== dashboard.view.granted) {
          throw new Error(
            `${role} / ${dashboard.name}: says ${dashboard.view.granted}, request gets ${opened.status}`,
          );
        }
        checked += 1;
      }
    }
    return `${checked} person × dashboard pairs agree`;
  });

  await step('Tenant Admin cannot assign Platform Admin', async () => {
    const offered = await getJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/assignable-roles?scopeType=tenant&scopeId=${ctx.tenantId}`,
      ctx.tokens.tenantAdmin,
    );
    if (offered.body.roles.includes('platform_admin')) {
      throw new Error('platform_admin is offered to a tenant admin.');
    }
    const attempt = await postJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/role-assignments`,
      {
        subjectType: 'user',
        subjectId: user('editor').id,
        role: 'platform_admin',
        scopeType: 'platform',
        scopeId: '',
      },
      ctx.tokens.tenantAdmin,
    );
    if (attempt.status !== 403) throw new Error(`The attempt answered ${attempt.status}.`);
    return `not offered (${offered.body.roles.length} roles are), and refused with 403`;
  });

  await step('Platform Admin without a grant sees no customer analytics', async () => {
    const token = ctx.tokens.platformAdmin;
    const codes = new Set();
    for (const [id, widget] of [
      [ctx.dashboardId, 'kpi-visits'],
      [ctx.stateDashboardId, 'state-ready'],
    ]) {
      const layout = await getJson(`${API_URL}/dashboards/${id}/layout?${VIEW}`, token);
      const tile = await getJson(`${API_URL}/dashboards/${id}/widgets/${widget}?${VIEW}`, token);
      if (layout.status !== 403 || tile.status !== 403) {
        throw new Error(`Dashboard ${id}: layout ${layout.status}, tile ${tile.status}.`);
      }
      // Refused as a permission, never as "not found": the platform role
      // simply carries no data access (ADR 0006).
      codes.add(layout.body.error?.code);
    }
    const unexpected = [...codes].filter(
      (code) => !['no_object_grant', 'capability_denied'].includes(code),
    );
    if (unexpected.length > 0) throw new Error(`Refused as ${unexpected.join(', ')}.`);
    const library = await getJson(`${API_URL}/dashboards`, token);
    if ((library.body.dashboards ?? []).length !== 0) {
      throw new Error('The library lists customer dashboards.');
    }
    // ...while administering the platform works.
    const tenants = await getJson(`${API_URL}/admin/platform/tenants`, token);
    if (tenants.status !== 200) throw new Error(`Tenant list: ${tenants.status}`);
    return `dashboards and tiles 403 (${[...codes].join(', ')}), library empty, tenant list 200`;
  });

  await step('group and direct grants accumulate', async () => {
    // The viewer sees the project through the group "Portal-Leser". A direct
    // grant on top changes nothing; leaving the group is what would take it
    // away. Both answered by the preview, nothing changed.
    const viewer = user('viewer');
    const direct = await preview({
      kind: 'grant',
      subjectType: 'user',
      subjectId: viewer.id,
      objectType: 'project',
      objectId: ctx.projectId,
      access: 'view',
    });
    if (!direct.noEffect)
      throw new Error('A redundant direct grant was predicted to change access.');

    const groups = await getJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/groups`,
      ctx.tokens.tenantAdmin,
    );
    const readers = groups.body.groups.find((group) => group.name === 'Portal-Leser');
    const leave = await preview({ kind: 'remove_member', groupId: readers.id, userId: viewer.id });
    const lost = leave.affected.find((entry) => entry.userId === viewer.id)?.dashboardsLost ?? [];
    if (!lost.some((entry) => entry.access === 'view')) {
      throw new Error('Leaving the group was not predicted to cost the view.');
    }
    return `direct on top of group: no effect; leaving the group: loses ${lost.length} dashboard view(s)`;
  });

  await step('no deny rules exist', async () => {
    const attempt = await postJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/grants`,
      {
        subjectType: 'user',
        subjectId: user('viewer').id,
        objectType: 'project',
        objectId: ctx.projectId,
        access: 'deny',
      },
      ctx.tokens.tenantAdmin,
    );
    if (attempt.status !== 422) throw new Error(`A deny grant answered ${attempt.status}.`);
    const contract = readFileSync(path.join(ROOT, 'packages/contracts/src/identity.ts'), 'utf8');
    if (!/OBJECT_ACCESS_LEVELS = \['view', 'edit'\] as const/.test(contract)) {
      throw new Error('The access levels are no longer exactly view and edit.');
    }
    return 'access levels are view and edit; "deny" is refused as invalid (422)';
  });

  await step('the preview is what then happens', async () => {
    const viewer = user('viewer');
    const change = {
      kind: 'assign_role',
      subjectType: 'user',
      subjectId: viewer.id,
      role: 'dashboard_editor',
      scopeType: 'project',
      scopeId: ctx.projectId,
    };
    const predicted = (await preview(change)).affected.find((entry) => entry.userId === viewer.id);
    const before = await effectiveOf(viewer.id);

    const { status, body } = await postJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/role-assignments`,
      change,
      ctx.tokens.tenantAdmin,
    );
    if (status !== 201) throw new Error(`Assigning answered ${status}.`);
    const after = await effectiveOf(viewer.id);

    const gained = capabilitySet(after).filter((entry) => !capabilitySet(before).includes(entry));
    const said = predicted.capabilitiesGained.map((entry) => entry.capability).sort();
    const got = [...new Set(gained.map((entry) => entry.split('|')[1]))].sort();
    if (JSON.stringify(said) !== JSON.stringify(got)) {
      throw new Error(`Predicted ${said.join(', ')}; got ${got.join(', ')}.`);
    }

    const removed = await deleteJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/role-assignments/${body.assignmentId}`,
      ctx.tokens.tenantAdmin,
    );
    if (removed.status >= 300)
      throw new Error(`Removing the role again answered ${removed.status}.`);
    return `predicted and actual both: ${said.join(', ')}`;
  });

  await step('deactivation ends every session at once', async () => {
    const viewer = user('viewer');
    const token = ctx.tokens.viewer;
    if ((await getJson(`${API_URL}/me/profile`, token)).status !== 200) {
      throw new Error('The viewer session was not live to begin with.');
    }
    const deactivated = await postJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/users/${viewer.id}/deactivate`,
      {},
      ctx.tokens.tenantAdmin,
    );
    if (deactivated.status !== 200) throw new Error(`Deactivating answered ${deactivated.status}.`);

    const after = await getJson(`${API_URL}/me/profile`, token);
    if (after.status !== 401) throw new Error(`The old session still answers ${after.status}.`);
    const again = await postJson(`${API_URL}/auth/login`, {
      email: ACCOUNTS.viewer,
      password: PASSWORD,
    });
    if (again.status === 200) throw new Error('A deactivated account could sign in.');

    // What the account held is kept: reactivation restores it unchanged.
    await postJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/users/${viewer.id}/reactivate`,
      {},
      ctx.tokens.tenantAdmin,
    );
    ctx.tokens.viewer = await signIn(ACCOUNTS.viewer);
    const restored = await effectiveOf(viewer.id);
    if (!restored.dashboards.some((dashboard) => dashboard.view.granted)) {
      throw new Error('Reactivation did not restore the access the account held.');
    }
    return `session 401 at once, sign-in refused (${again.status}); reactivated with its access intact`;
  });

  await step('privileged changes are audited', async () => {
    const audit = await getJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/audit`,
      ctx.tokens.tenantAdmin,
    );
    const actions = new Set(audit.body.events.map((event) => event.action));
    const expected = [
      'role_assignment.created',
      'role_assignment.removed',
      'user.deactivated',
      'user.activated',
    ];
    const missing = expected.filter((action) => !actions.has(action));
    if (missing.length > 0) throw new Error(`Not in the audit trail: ${missing.join(', ')}`);
    return expected.join(', ');
  });

  if (!SKIP_E2E) {
    await step('the browser journey passes, administration included', async () => {
      // Sign-in is rate limited per client (20 a minute) on purpose; the steps
      // above signed in several times, and the browser suite signs every demo
      // role in once more. Waiting out the window keeps a product safeguard
      // from being reported as a test failure.
      await delay(60_000);
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], { env: E2E_ENV() });
      const admin = stdout
        .split(/\r?\n/)
        .filter((line) => /\bok\b.*administration\.spec/.test(line)).length;
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} browser checks, ${admin} of them administration (desktop and phone)`;
    });
  }

  report();
}

// --- fixture and API helpers ------------------------------------------------

async function seedFixture() {
  const { stdout: tokenOut } = await runOrThrow('npm', ['run', 'bootstrap-admin', '--', '--json']);
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

  ctx.tokens = {};
  for (const [role, email] of Object.entries(ACCOUNTS)) ctx.tokens[role] = await signIn(email);

  const users = await getJson(
    `${API_URL}/admin/tenants/${ctx.tenantId}/users`,
    ctx.tokens.tenantAdmin,
  );
  if (users.status !== 200) throw new Error(`User list: ${users.status}`);
  ctx.users = users.body.users;
  return seeded;
}

function user(role) {
  const found = ctx.users.find((entry) => entry.email === ACCOUNTS[role]);
  if (!found) throw new Error(`No ${role} in the fixture.`);
  return found;
}

async function preview(change) {
  const response = await postJson(
    `${API_URL}/admin/tenants/${ctx.tenantId}/impact-preview`,
    { change },
    ctx.tokens.tenantAdmin,
  );
  if (response.status !== 200) throw new Error(`Preview answered ${response.status}.`);
  return response.body;
}

async function effectiveOf(userId) {
  const response = await getJson(
    `${API_URL}/admin/tenants/${ctx.tenantId}/users/${userId}`,
    ctx.tokens.tenantAdmin,
  );
  return response.body.effective;
}

function capabilitySet(effective) {
  return effective.scopes.flatMap((scope) =>
    scope.capabilities.map((entry) => `${scope.scope.id}|${entry.capability}`),
  );
}

function deleteJson(url, token) {
  return fetchJson(url, { method: 'DELETE', headers: authHeaders(token) });
}

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
  console.log(`Gate F5: ${passed}/${results.length} criteria demonstrated.`);
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
    console.error(`\nGate F5 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
