#!/usr/bin/env node
/**
 * Gate F6 demonstration.
 *
 * Runs against a real stack and the canonical fixture, from an empty database:
 *
 *   - install the Pulse package into a clean eligible project
 *   - resolve mappings without hard-coded source dimension ids
 *   - create a dashboard from an installed template
 *   - updating the package does not silently mutate an existing published
 *     dashboard
 *   - malicious and invalid package payloads are rejected
 *
 * and shows the Pulse reference chain with its canonical values.
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f6.mjs [--skip-e2e] [--local-mysql]
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

const ADMIN_EMAIL = 'gate.f6@example.invalid';
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

  await step('the solutions suite passes', async () => {
    const { stdout } = await runOrThrow('npx', [
      'vitest',
      'run',
      '--project',
      'integration',
      'tests/integration/solutions.test.ts',
    ]);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} solution, template and setup tests`;
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
    PULSE_PACKAGE_TEXT = (
      await getJson(
        `${API_URL}/solutions/catalog/com.axp.employee-portal-health`,
        ctx.tokens.viewer,
      )
    ).body.package;
    return `${ctx.users.length} people in ${seeded.tenantId ? 'the demo tenant' : '?'}, ${Object.keys(ctx.tokens).length} signed in`;
  });

  // --- Gate F6 criteria ----------------------------------------------------

  await step('a clean eligible project is created in the small flow', async () => {
    // Eligible: it reads a site whose connection has detected capabilities.
    // Clean: no definitions of its own, no templates, no solution.
    const options = await getJson(`${API_URL}/projects/creation-options`, ctx.tokens.tenantAdmin);
    const site = options.body.tenants[0]?.sites[0];
    if (!site) throw new Error('The tenant offers no site to reuse.');

    const created = await postJson(
      `${API_URL}/projects`,
      {
        tenantId: ctx.tenantId,
        name: 'Gate F6 Portal',
        slug: 'gate-f6-portal',
        contextProfile: { useCase: 'Gate F6', audience: 'Reviewer' },
        source: { kind: 'existing_site', siteId: site.id },
      },
      ctx.tokens.tenantAdmin,
    );
    if (created.status !== 201) throw new Error(`Project creation answered ${created.status}.`);
    ctx.cleanProjectId = created.body.projectId;

    // Who works in it: the tenant admin gives the editor a role there, as
    // they would for any new project. Data access follows from the dashboards
    // the editor creates (the creator's grant, ADR 0006).
    const editor = ctx.users.find((entry) => entry.email === ACCOUNTS.editor);
    const assigned = await postJson(
      `${API_URL}/admin/tenants/${ctx.tenantId}/role-assignments`,
      {
        subjectType: 'user',
        subjectId: editor.id,
        role: 'dashboard_editor',
        scopeType: 'project',
        scopeId: ctx.cleanProjectId,
      },
      ctx.tokens.tenantAdmin,
    );
    if (assigned.status !== 201)
      throw new Error(`Assigning the editor answered ${assigned.status}.`);

    const templates = await getJson(
      `${API_URL}/projects/${ctx.cleanProjectId}/templates`,
      ctx.tokens.semantic,
    );
    const installations = await getJson(
      `${API_URL}/projects/${ctx.cleanProjectId}/solutions`,
      ctx.tokens.semantic,
    );
    if (templates.body.templates.length > 0 || installations.body.installations.length > 0) {
      throw new Error('The new project is not clean.');
    }
    const detail = await getJson(
      `${API_URL}/projects/${ctx.cleanProjectId}`,
      ctx.tokens.tenantAdmin,
    );
    const state = (key) => detail.body.setup.steps.find((entry) => entry.step === key)?.state;
    return `reuses "${site.name}"; site ${state('site_assignment')}, mapping ${state('mapping')}, no templates, no solution`;
  });

  await step('the Pulse package is analysed before anything is written', async () => {
    const analysis = await analyze(ctx.cleanProjectId, PULSE_SOURCE);
    if (!analysis.installable) {
      throw new Error(
        `Not installable: ${analysis.issues.map((issue) => issue.messageKey).join(', ')}`,
      );
    }
    if (analysis.compatibility !== 'supported')
      throw new Error(`Compatibility ${analysis.compatibility}.`);
    if (analysis.preview.definitionsNew !== 9) {
      throw new Error(`Expected 9 new definitions, got ${analysis.preview.definitionsNew}.`);
    }
    const definitions = await getJson(
      `${API_URL}/projects/${ctx.cleanProjectId}/semantic-definitions`,
      ctx.tokens.semantic,
    );
    ctx.definitionsBefore = definitions.body.definitions.length;
    ctx.analysis = analysis;
    return `validate, compatibility, dependencies passed; ${analysis.preview.definitionsNew} new definitions, ${analysis.mappings.length} requirements to map, nothing written`;
  });

  await step('mappings resolve without hard-coded source ids', async () => {
    /*
     * The package describes requirements in business words and names no
     * report, event, dimension or id. What satisfies them is chosen at install
     * time from what this site offers - here by matching the requirement to
     * the site's reports, the way a person would in the mapping step.
     */
    const text = JSON.stringify(ctx.analysis.manifest) + JSON.stringify(PULSE_PACKAGE_TEXT);
    if (/mock_|dimension\d|"index"|goalId|siteId|connectionId/.test(text)) {
      throw new Error('The package names a source.');
    }
    ctx.mappings = {};
    for (const mapping of ctx.analysis.mappings) {
      const suffix = mapping.requirement.key.split('.').pop();
      const candidate = mapping.candidates.find((entry) => entry.sourceMetric.endsWith(suffix));
      if (!candidate) throw new Error(`The site offers nothing for ${mapping.requirement.label}.`);
      ctx.mappings[mapping.requirement.key] = candidate.sourceMetric;
    }
    const offered = ctx.analysis.mappings[0].candidates.length;
    return `${Object.keys(ctx.mappings).length} requirements mapped onto the site's ${offered} reports`;
  });

  await step('the Pulse package installs into the clean project', async () => {
    const installed = await install(ctx.cleanProjectId, PULSE_SOURCE, { mappings: ctx.mappings });
    if (installed.status !== 201) {
      throw new Error(`Install answered ${installed.status}: ${installed.body.error?.code}`);
    }
    const detail = await getJson(
      `${API_URL}/projects/${ctx.cleanProjectId}`,
      ctx.tokens.tenantAdmin,
    );
    const mapping = detail.body.setup.steps.find((entry) => entry.step === 'mapping');
    if (mapping.state !== 'done') throw new Error(`Mapping step is ${mapping.state}.`);
    return `${installed.body.definitionsCreated} definitions and ${installed.body.templates} templates; mapping step ${mapping.state} (${mapping.detail})`;
  });

  await step('a dashboard is created from an installed template', async () => {
    const templates = await getJson(
      `${API_URL}/projects/${ctx.cleanProjectId}/templates?kind=dashboard`,
      ctx.tokens.editor,
    );
    const ready = templates.body.templates.filter((template) => template.readiness === 'ready');
    if (ready.length !== 2) throw new Error(`${ready.length} of 2 dashboard templates are ready.`);

    ctx.executiveTemplateId = ready.find((entry) => entry.name === 'Executive Health Overview').id;
    ctx.publishedDashboardId = await dashboardFromTemplate(ctx.executiveTemplateId);
    const published = await postJson(
      `${API_URL}/dashboards/${ctx.publishedDashboardId}/publish`,
      {},
      ctx.tokens.editor,
    );
    if (published.status !== 200) throw new Error(`Publishing answered ${published.status}.`);

    const draft = await getJson(
      `${API_URL}/dashboards/${ctx.publishedDashboardId}/draft`,
      ctx.tokens.editor,
    );
    return `"Executive Health Overview" with ${draft.body.snapshot.widgets.length} widgets, published as version ${published.body.version}`;
  });

  await step('the Pulse chain shows the canonical values', async () => {
    const values = await cardValues(ctx.publishedDashboardId, ctx.tokens.editor);
    const expected = {
      'engagement-rate': 18,
      'creation-rate': 5,
      'adoption-rate': 51,
      'interaction-index': 15.4,
      'pulse-score': 40.32,
    };
    for (const [widget, value] of Object.entries(expected)) {
      if (values[widget]?.value !== value) {
        throw new Error(`${widget}: expected ${value}, got ${values[widget]?.value}`);
      }
    }
    const evaluation = values['pulse-score'].evaluation;
    if (!evaluation?.label) throw new Error('PULSE carries no evaluation.');
    return `Engagement 18 %, Creation 5 %, Adoption 51 %, Interaction Index 15.4, PULSE 40.32 ("${evaluation.label}", band ${evaluation.band})`;
  });

  await step('updating the package does not silently change a published dashboard', async () => {
    const before = await getJson(
      `${API_URL}/dashboards/${ctx.publishedDashboardId}/layout?${VIEW}`,
      ctx.tokens.editor,
    );
    const update = { upload: pulseUpdate() };
    const analysis = await analyze(ctx.cleanProjectId, update);
    const changed = analysis.conflicts.filter((conflict) => conflict.kind === 'changed');
    if (!changed.some((conflict) => conflict.portableId === 'pulse.health_index')) {
      throw new Error('The changed PULSE weights were not reported as a conflict.');
    }

    const undecided = await install(ctx.cleanProjectId, update, { mappings: {} });
    if (undecided.status !== 422)
      throw new Error(`An undecided update answered ${undecided.status}.`);

    const resolutions = Object.fromEntries(
      changed.map((conflict) => [conflict.portableId, 'new_version']),
    );
    const updated = await install(ctx.cleanProjectId, update, { mappings: {}, resolutions });
    if (updated.status !== 201) throw new Error(`The update answered ${updated.status}.`);

    const after = await getJson(
      `${API_URL}/dashboards/${ctx.publishedDashboardId}/layout?${VIEW}`,
      ctx.tokens.editor,
    );
    if (after.body.dashboard.publishedVersion !== before.body.dashboard.publishedVersion) {
      throw new Error('The published version changed.');
    }
    const kept = (await cardValues(ctx.publishedDashboardId, ctx.tokens.editor))['pulse-score']
      .value;
    if (kept !== 40.32) throw new Error(`The published PULSE moved to ${kept}.`);

    const fresh = await dashboardFromTemplate(ctx.executiveTemplateId);
    await postJson(`${API_URL}/dashboards/${fresh}/publish`, {}, ctx.tokens.editor);
    const updatedValue = (await cardValues(fresh, ctx.tokens.editor))['pulse-score'].value;
    if (updatedValue !== 33.2)
      throw new Error(`A new dashboard shows ${updatedValue}, expected 33.2.`);

    return `1.0.0 → 1.1.0 needed a decision (${changed.length} changed ${changed.length === 1 ? 'object' : 'objects'}); published dashboard stays at version ${after.body.dashboard.publishedVersion} and 40.32, a new one shows 33.2`;
  });

  await step('malicious and invalid payloads are rejected', async () => {
    const payloads = {
      'executable field': { ...PULSE_PACKAGE_TEXT, script: 'require("child_process").exec("x")' },
      'SQL-shaped formula': withBody({
        kind: 'formula',
        ast: { type: 'sql', query: 'DROP TABLE users' },
      }),
      credential: {
        ...PULSE_PACKAGE_TEXT,
        manifest: { ...PULSE_PACKAGE_TEXT.manifest, token: 'secret' },
      },
      'prototype pollution': JSON.parse(
        JSON.stringify(PULSE_PACKAGE_TEXT).replace(
          '"manifest":{',
          '"manifest":{"__proto__":{"admin":true},',
        ),
      ),
      'unknown schema': {
        ...PULSE_PACKAGE_TEXT,
        manifest: { ...PULSE_PACKAGE_TEXT.manifest, packageSchemaVersion: '99' },
      },
      oversize: 'x'.repeat(600 * 1024),
    };
    const layers = { parser: 0, validation: 0 };
    for (const [name, payload] of Object.entries(payloads)) {
      const response = await postJson(
        `${API_URL}/projects/${ctx.cleanProjectId}/solutions/analyze`,
        { source: { upload: payload } },
        ctx.tokens.semantic,
      );
      if (response.status === 400) {
        // Refused by the request parser before the package check ever sees
        // it - Fastify rejects `__proto__` keys outright.
        layers.parser += 1;
      } else if (response.status === 200) {
        if (response.body.installable || response.body.issues.length === 0) {
          throw new Error(`${name} was not refused.`);
        }
        layers.validation += 1;
      } else {
        throw new Error(`${name}: analysis answered ${response.status}.`);
      }
      const attempt = await install(ctx.cleanProjectId, { upload: payload }, { mappings: {} });
      if (attempt.status !== 422 && attempt.status !== 400) {
        throw new Error(`${name}: install answered ${attempt.status}.`);
      }
    }
    const definitions = await getJson(
      `${API_URL}/projects/${ctx.cleanProjectId}/semantic-definitions`,
      ctx.tokens.semantic,
    );
    const count = definitions.body.definitions.length;
    if (count !== ctx.definitionsBefore + 9) throw new Error(`Definitions changed to ${count}.`);
    return `${Object.keys(payloads).length} payloads refused (${layers.validation} by package validation, ${layers.parser} by the request parser), at analysis and at install; nothing written`;
  });

  await step('the canonical demo carries the Pulse dashboards', async () => {
    const library = await getJson(`${API_URL}/dashboards`, ctx.tokens.viewer);
    const names = library.body.dashboards.map((dashboard) => dashboard.name);
    for (const name of ['Executive Health Overview', 'Engagement & Participation Detail']) {
      if (!names.includes(name)) throw new Error(`"${name}" is missing from the demo.`);
    }
    const executive = library.body.dashboards.find(
      (dashboard) => dashboard.name === 'Executive Health Overview',
    );
    const pulse = (await cardValues(executive.id, ctx.tokens.viewer))['pulse-score'].value;
    if (pulse !== 40.32) throw new Error(`The demo shows PULSE ${pulse}.`);
    return 'both reference dashboards published in Employee Portal; the viewer sees PULSE 40.32';
  });

  if (!SKIP_E2E) {
    await step('the browser journey passes, solutions included', async () => {
      // Sign-in is rate limited per client (20 a minute) on purpose; waiting out
      // the window keeps a product safeguard from failing the run.
      await delay(60_000);
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], { env: E2E_ENV() });
      const solutions = stdout
        .split(/\r?\n/)
        .filter((line) => /\bok\b.*solutions\.spec/.test(line)).length;
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} browser checks, ${solutions} of them solutions and setup`;
    });
  }

  report();
}

// --- fixture and API helpers ------------------------------------------------

const PULSE_SOURCE = { catalog: { packageId: 'com.axp.employee-portal-health' } };
let PULSE_PACKAGE_TEXT = null;

async function analyze(projectId, source) {
  const response = await postJson(
    `${API_URL}/projects/${projectId}/solutions/analyze`,
    { source },
    ctx.tokens.semantic,
  );
  if (response.status !== 200) throw new Error(`Analysis answered ${response.status}.`);
  return response.body;
}

function install(projectId, source, { mappings = {}, resolutions = {} } = {}) {
  return postJson(
    `${API_URL}/projects/${projectId}/solutions/install`,
    { source, request: { mappings, resolutions, acceptWarnings: false } },
    ctx.tokens.semantic,
  );
}

async function dashboardFromTemplate(templateId) {
  const created = await postJson(
    `${API_URL}/projects/${ctx.cleanProjectId}/templates/${templateId}/dashboards`,
    {},
    ctx.tokens.editor,
  );
  if (created.status !== 201)
    throw new Error(`Creating from the template answered ${created.status}.`);
  return created.body.dashboardId;
}

/** Card widgets of a dashboard: widget id -> { value, evaluation }. */
async function cardValues(dashboardId, token) {
  const response = await getJson(
    `${API_URL}/dashboards/${dashboardId}/presentation?${VIEW}`,
    token,
  );
  if (response.status !== 200) throw new Error(`Presentation answered ${response.status}.`);
  const values = {};
  for (const widget of response.body.widgets) {
    if (widget.content?.kind !== 'card') continue;
    const metric = widget.content.metrics[0];
    values[widget.widgetId] = {
      value: metric && 'value' in metric.value ? metric.value.value : metric?.value.state,
      evaluation: metric?.evaluation,
    };
  }
  return values;
}

/** Version 1.1.0 of the reference package: PULSE reweighted to 0.5 / 0.5. */
function pulseUpdate() {
  const pkg = JSON.parse(JSON.stringify(PULSE_PACKAGE_TEXT));
  pkg.manifest.packageVersion = '1.1.0';
  const pulse = pkg.definitions.find(
    (definition) => definition.portableId === 'pulse.health_index',
  );
  pulse.body.components = pulse.body.components.map((component) => ({ ...component, weight: 0.5 }));
  return pkg;
}

function withBody(body) {
  const pkg = JSON.parse(JSON.stringify(PULSE_PACKAGE_TEXT));
  pkg.definitions[4].body = body;
  return pkg;
}

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
  console.log(`Gate F6: ${passed}/${results.length} criteria demonstrated.`);
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
    console.error(`\nGate F6 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
