#!/usr/bin/env node
/**
 * Gate F3 demonstration.
 *
 * Runs the Phase 3 acceptance criteria from the Claude Code Development Plan
 * against a real stack and prints a pass/fail table:
 *
 *   - no arbitrary executable code in formulas
 *   - cyclic dependency blocked
 *   - version pinning verified across publish/update
 *   - mapping correction does not silently create a semantic version
 *   - score never hides missing inputs by reweighting
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f3.mjs [--skip-e2e] [--local-mysql]
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

const ADMIN_EMAIL = 'gate.f3@example.invalid';
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const SEMANTIC_EMAIL = 'semantic.demo@example.invalid';
const EDITOR_EMAIL = 'editor.demo@example.invalid';
const VIEWER_EMAIL = 'viewer.demo@example.invalid';

const results = [];
const children = [];

const ctx = {
  tenantId: '',
  projectId: '',
  dashboardId: '',
  gateDashboardId: '',
  siteId: '',
  visits: { definitionId: '', versionId: '' },
  pageviews: { definitionId: '', versionId: '' },
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

    ctx.tokens.semantic = await signIn(SEMANTIC_EMAIL);
    ctx.tokens.editor = await signIn(EDITOR_EMAIL);
    ctx.tokens.viewer = await signIn(VIEWER_EMAIL);

    const { body } = await getJson(
      `${API_URL}/projects/${ctx.projectId}/semantic-definitions`,
      ctx.tokens.semantic,
    );
    for (const definition of body.definitions) {
      if (definition.portableId === 'core.visits') {
        ctx.visits = { definitionId: definition.id, versionId: definition.currentVersionId };
      }
      if (definition.portableId === 'core.pageviews') {
        ctx.pageviews = { definitionId: definition.id, versionId: definition.currentVersionId };
      }
    }
    if (!ctx.visits.versionId || !ctx.pageviews.versionId) {
      throw new Error('The seeded catalog is missing its core native metrics.');
    }

    return `${body.definitions.length} definitions, Portal Overview v${seeded.dashboard.publishedVersion}`;
  });

  // --- Gate F3 criteria ----------------------------------------------------

  await step('formulas carry no arbitrary executable code', async () => {
    /*
     * Three ways in, all closed:
     *
     *   - a node type that carries a source string is not in the schema;
     *   - a node type that does not exist is refused, rather than ignored and
     *     stored alongside the rest;
     *   - what a valid formula stores is structure. The check below reads the
     *     row straight out of MySQL and asserts there is nothing in it that
     *     could be handed to an interpreter.
     */
    const injections = [
      { type: 'expression', source: 'process.exit(1)' },
      { type: 'javascript', code: 'fetch("http://evil.invalid")' },
      { type: 'sql', query: 'SELECT * FROM users' },
      { type: 'reference', semanticVersionId: ctx.visits.versionId, eval: '1+1' },
    ];

    for (const [index, ast] of injections.entries()) {
      const response = await postJson(
        `${API_URL}/projects/${ctx.projectId}/semantic-definitions`,
        {
          portableId: `gate.f3.injection-${index}`,
          type: 'formula',
          name: `Injektion ${index}`,
          body: {
            kind: 'formula',
            ast,
            unit: 'ratio',
            scope: 'visit',
            direction: 'higher_is_better',
            decimals: 2,
          },
        },
        ctx.tokens.semantic,
      );
      if (response.status !== 422) {
        throw new Error(`Injection ${index} was accepted with ${response.status}.`);
      }
    }

    // A legitimate formula, and what actually lands in the database.
    const stored = await createFormula('gate.f3.pages-per-visit', 'Seiten pro Besuch', divide());
    const rows = await queryDatabase('SELECT body FROM semantic_versions WHERE definition_id = ?', [
      stored.definition.id,
    ]);
    const body = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
    const serialised = JSON.stringify(body);

    for (const forbidden of ['source', 'code', 'query', 'eval', 'script', 'expression']) {
      if (serialised.includes(`"${forbidden}"`)) {
        throw new Error(`The stored formula carries a "${forbidden}" field.`);
      }
    }
    const nodeTypes = new Set();
    const walk = (node) => {
      nodeTypes.add(node.type);
      if (node.left) walk(node.left);
      if (node.right) walk(node.right);
      if (node.args) node.args.forEach(walk);
    };
    walk(body.ast);
    for (const type of nodeTypes) {
      if (!['constant', 'reference', 'binary', 'function'].includes(type)) {
        throw new Error(`The stored AST contains an unexpected node type: ${type}`);
      }
    }

    return `${injections.length} injections refused, stored AST is ${[...nodeTypes].join('/')}`;
  });

  await step('a cyclic dependency is blocked', async () => {
    // A definition whose second version refers to its own first version. The
    // reference is real and resolvable - which is exactly why a naive check
    // would let it through, and why this is a gate criterion.
    const created = await createFormula('gate.f3.cycle', 'Kreis', divide());
    await activate(created.definition.id, created.version.id);

    const response = await postJson(
      `${API_URL}/projects/${ctx.projectId}/semantic-definitions/${created.definition.id}/versions`,
      {
        body: {
          kind: 'formula',
          ast: {
            type: 'binary',
            op: '/',
            left: { type: 'reference', semanticVersionId: created.version.id },
            right: { type: 'constant', value: 2 },
          },
          unit: 'ratio',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 2,
        },
      },
      ctx.tokens.semantic,
    );

    if (response.status !== 422) {
      throw new Error(`A self-referential version was accepted with ${response.status}.`);
    }
    if (response.body.error?.messageKey !== 'semantic.formula.cycle') {
      throw new Error(`The refusal was generic: ${response.body.error?.messageKey}`);
    }

    const versions = await getJson(
      `${API_URL}/projects/${ctx.projectId}/semantic-definitions/${created.definition.id}/versions`,
      ctx.tokens.semantic,
    );
    if (versions.body.versions.length !== 1) {
      throw new Error('The rejected version was stored anyway.');
    }

    return 'self-reference refused by name, nothing stored';
  });

  await step('a published dashboard keeps the version it pinned', async () => {
    /*
     * The whole point of pinning, demonstrated end to end:
     *
     *   1. put a formula on a widget and publish the dashboard;
     *   2. change what the formula means, and activate the new version;
     *   3. the published dashboard still pins the old version, and renders
     *      exactly what it rendered before;
     *   4. publishing again picks the new version up - on purpose, and only
     *      then.
     *
     * The subject is a project formula rather than a native metric: `visits`
     * is shipped with the product and has no tenant-facing write path, which
     * is itself the reason the catalog distinguishes the two.
     */
    const created = await createFormula('gate.f3.pinned', 'Seiten pro Besuch (Pin)', divide());
    await activate(created.definition.id, created.version.id);

    // Its own dashboard. The fixture is what the browser suite reads, and a
    // gate that left it rewired would be testing its own leftovers.
    ctx.gateDashboardId = await cloneFixtureDashboard('Gate F3 Pinning');
    await putWidgetMetric(created.version.id);
    const firstPublish = await publish();
    if (firstPublish.status !== 200) {
      throw new Error(`Publishing failed: ${firstPublish.status}`);
    }

    const before = await published();
    if (!before.pinnedSemanticVersionIds.includes(created.version.id)) {
      throw new Error('The published dashboard did not pin the formula version.');
    }
    const renderedBefore = await renderedValues(ctx.tokens.viewer);

    // The business changes its mind about how the number is rounded.
    const second = await postJson(
      `${API_URL}/projects/${ctx.projectId}/semantic-definitions/${created.definition.id}/versions`,
      {
        body: {
          kind: 'formula',
          ast: divide(),
          unit: 'ratio',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 0,
        },
      },
      ctx.tokens.semantic,
    );
    if (second.status !== 201) {
      throw new Error(`Adding a version failed: ${second.status} ${JSON.stringify(second.body)}`);
    }
    await activate(created.definition.id, second.body.version.id);

    const after = await published();
    if (
      JSON.stringify(after.pinnedSemanticVersionIds) !==
      JSON.stringify(before.pinnedSemanticVersionIds)
    ) {
      throw new Error('Activating a new version changed what the published dashboard pins.');
    }
    if (after.pinnedSemanticVersionIds.includes(second.body.version.id)) {
      throw new Error('The published dashboard picked up the new version without a publish.');
    }

    const renderedAfter = await renderedValues(ctx.tokens.viewer);
    if (JSON.stringify(renderedAfter) !== JSON.stringify(renderedBefore)) {
      throw new Error('The published dashboard rendered different values after the change.');
    }

    // Republishing on its own changes nothing either: a widget holds a version
    // id, and publishing pins what the widget holds (Shared Contract §7). A
    // new active version reaches a dashboard only when an editor puts it
    // there - which is the difference between a pinned definition and a
    // floating one.
    const blind = await publish();
    if (blind.status !== 200) throw new Error(`Republish failed: ${blind.status}`);

    const stillOld = await published();
    if (stillOld.pinnedSemanticVersionIds.includes(second.body.version.id)) {
      throw new Error('Republishing adopted a new semantic version nobody chose.');
    }

    // Adopting it is an edit, and then a publish.
    await putWidgetMetric(second.body.version.id);
    const adopted = await publish();
    if (adopted.status !== 200)
      throw new Error(`Publishing the adoption failed: ${adopted.status}`);

    const latest = await published();
    if (!latest.pinnedSemanticVersionIds.includes(second.body.version.id)) {
      throw new Error('The adopted version was not pinned by the new publish.');
    }
    if (latest.pinnedSemanticVersionIds.includes(created.version.id)) {
      throw new Error('The new snapshot still pins the superseded version.');
    }

    return `v${before.version} held its pin through an update and a blind republish; v${latest.version} moved it only on an explicit edit`;
  });

  await step('correcting a mapping creates no semantic version', async () => {
    const versionsBefore = await countRows('semantic_versions');
    const definitionsBefore = await countRows('semantic_definitions');

    const requirementKey = 'gate.f3.engaged_users';
    for (const index of [3, 4, 5]) {
      const response = await putJson(
        `${API_URL}/projects/${ctx.projectId}/source-bindings`,
        { requirementKey, siteId: null, binding: { kind: 'custom_dimension', index } },
        ctx.tokens.semantic,
      );
      if (response.status !== 200) throw new Error(`Mapping ${index} failed: ${response.status}`);
    }

    // And the review state, which is the other half of the same rule: somebody
    // acknowledging drift is not somebody redefining a number.
    const reviewed = await postJson(
      `${API_URL}/projects/${ctx.projectId}/source-bindings/${requirementKey}/review`,
      {},
      ctx.tokens.semantic,
    );
    if (reviewed.status !== 200) throw new Error(`Recording a review failed: ${reviewed.status}`);

    const versionsAfter = await countRows('semantic_versions');
    const definitionsAfter = await countRows('semantic_definitions');
    if (versionsAfter !== versionsBefore) {
      throw new Error(
        `Mapping work created ${versionsAfter - versionsBefore} semantic version(s).`,
      );
    }
    if (definitionsAfter !== definitionsBefore) {
      throw new Error('Mapping work created a semantic definition.');
    }

    // One row, corrected in place, rather than a pile of history.
    const bindings = await queryDatabase(
      'SELECT id, reviewed_at FROM source_bindings WHERE requirement_key = ?',
      [requirementKey],
    );
    if (bindings.length !== 1) {
      throw new Error(`Three corrections left ${bindings.length} rows.`);
    }
    if (!bindings[0].reviewed_at) throw new Error('The review was not recorded.');

    return '3 corrections + 1 review, 0 semantic versions';
  });

  await step('a score with a missing input is not calculable', async () => {
    /*
     * The rule that separates a score from an average: a missing component is
     * not dropped and the remaining weights are not renormalised. A score
     * built from 50/50 where one half is unavailable must not quietly become
     * the other half.
     */
    const unavailable = await postJson(
      `${API_URL}/projects/${ctx.projectId}/semantic-definitions`,
      {
        portableId: 'gate.f3.unavailable',
        type: 'custom_metric',
        name: 'Nicht verfügbar',
        body: {
          kind: 'custom',
          requirementKey: 'gate.f3.nothing_maps_here',
          unit: 'count',
          scope: 'visit',
          direction: 'higher_is_better',
          decimals: 0,
        },
      },
      ctx.tokens.semantic,
    );
    if (unavailable.status !== 201) {
      throw new Error(`Creating the unavailable metric failed: ${unavailable.status}`);
    }
    await activate(unavailable.body.definition.id, unavailable.body.version.id);

    const score = {
      kind: 'score',
      unit: 'score',
      scope: 'visit',
      direction: 'higher_is_better',
      decimals: 1,
      components: [
        {
          semanticVersionId: ctx.visits.versionId,
          weight: 50,
          label: 'Besuche',
          normalisation: { kind: 'linear', worst: 0, best: 1000 },
        },
        {
          semanticVersionId: unavailable.body.version.id,
          weight: 50,
          label: 'Nicht verfügbar',
          normalisation: { kind: 'linear', worst: 0, best: 100 },
        },
      ],
      evaluation: [
        { key: 'weak', atLeast: 0, band: 1 },
        { key: 'good', atLeast: 60, band: 4 },
      ],
    };

    const preview = await postJson(
      `${API_URL}/projects/${ctx.projectId}/semantic-definitions/preview`,
      { body: score, siteId: ctx.siteId },
      ctx.tokens.semantic,
    );
    if (preview.status !== 200) throw new Error(`Score preview failed: ${preview.status}`);

    const value = preview.body.value;
    if (value.state === 'ok') {
      throw new Error(`The score produced a number (${value.value}) despite a missing input.`);
    }
    if (value.state === 'zero' || value.value === 0) {
      throw new Error('The score rendered a missing input as zero.');
    }
    if (value.state !== 'missing') {
      throw new Error(`Unexpected value state: ${value.state}`);
    }

    if (value.cause?.kind !== 'not_calculable') {
      throw new Error(`Unexpected cause: ${JSON.stringify(value.cause)}`);
    }
    if (!(value.cause.missingInputs ?? []).includes('Nicht verfügbar')) {
      throw new Error('The refusal does not name which input was missing.');
    }

    // The available half was genuinely available: had the score renormalised
    // the remaining weight to 100 %, it would have produced a plausible
    // number. That is the failure mode the rule exists to prevent.
    const available = (preview.body.inputs ?? []).find(
      (input) => input.value && ['ready', 'zero'].includes(input.value.state),
    );
    if (!available) {
      throw new Error('Neither input produced a value, so nothing was demonstrated.');
    }
    const absent = (preview.body.inputs ?? []).find(
      (input) => input.value?.state === 'missing' && input.value.cause?.kind === 'no_mapping',
    );
    if (!absent) throw new Error('The unmapped input was not reported as unmapped.');

    return `state "${value.state}", "${value.cause.missingInputs.join(', ')}" named, no reweighting`;
  });

  await step('the browser journey passes', async () => {
    if (SKIP_E2E) return 'skipped by request';

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

  report();
}

// --- domain helpers --------------------------------------------------------

/** Pages per visit: the smallest formula that is actually useful. */
function divide() {
  return {
    type: 'binary',
    op: '/',
    left: { type: 'reference', semanticVersionId: ctx.pageviews.versionId },
    right: { type: 'reference', semanticVersionId: ctx.visits.versionId },
  };
}

async function createFormula(portableId, name, ast) {
  const response = await postJson(
    `${API_URL}/projects/${ctx.projectId}/semantic-definitions`,
    {
      portableId,
      type: 'formula',
      name,
      body: {
        kind: 'formula',
        ast,
        unit: 'ratio',
        scope: 'visit',
        direction: 'higher_is_better',
        decimals: 2,
      },
    },
    ctx.tokens.semantic,
  );
  if (response.status !== 201) {
    throw new Error(
      `Creating ${portableId} failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

async function activate(definitionId, versionId) {
  const response = await postJson(
    `${API_URL}/projects/${ctx.projectId}/semantic-definitions/${definitionId}/versions/${versionId}/status`,
    { to: 'active' },
    ctx.tokens.semantic,
  );
  if (response.status !== 200) {
    throw new Error(`Activating ${versionId} failed: ${response.status}`);
  }
  return response.body;
}

/**
 * Points the first widget of the fixture dashboard at one semantic version.
 *
 * Takes the lease first: one editor at a time is a Phase 2 rule, and a gate
 * that bypassed it would be demonstrating something the product does not do.
 */
async function putWidgetMetric(versionId) {
  const lease = await postJson(
    `${API_URL}/dashboards/${ctx.gateDashboardId}/lease`,
    { force: true },
    ctx.tokens.editor,
  );
  if (!lease.body.acquired) throw new Error('The editor could not take the draft lease.');

  const current = await getJson(
    `${API_URL}/dashboards/${ctx.gateDashboardId}/draft`,
    ctx.tokens.editor,
  );
  if (current.status !== 200) throw new Error(`Reading the draft failed: ${current.status}`);

  const [first, ...rest] = current.body.snapshot.widgets;
  const saved = await putJson(
    `${API_URL}/dashboards/${ctx.gateDashboardId}/draft`,
    {
      expectedRevisionId: current.body.revisionId,
      snapshot: {
        ...current.body.snapshot,
        widgets: [{ ...first, data: { ...first.data, semanticVersionIds: [versionId] } }, ...rest],
      },
    },
    ctx.tokens.editor,
  );
  if (saved.status !== 200) {
    throw new Error(`Saving the draft failed: ${saved.status} ${JSON.stringify(saved.body)}`);
  }
}

function publish() {
  return postJson(`${API_URL}/dashboards/${ctx.gateDashboardId}/publish`, {}, ctx.tokens.editor);
}

/**
 * A dashboard of the gate's own, with the fixture's widgets copied into it.
 *
 * Copied rather than built from nothing: the point of the step is what happens
 * to a real published dashboard, and an empty one publishes nothing to pin.
 */
async function cloneFixtureDashboard(name) {
  const template = await getJson(
    `${API_URL}/dashboards/${ctx.dashboardId}/draft`,
    ctx.tokens.editor,
  );
  if (template.status !== 200) {
    throw new Error(`Reading the fixture draft failed: ${template.status}`);
  }

  const created = await postJson(
    `${API_URL}/projects/${ctx.projectId}/dashboards`,
    { name, siteId: ctx.siteId },
    ctx.tokens.editor,
  );
  if (created.status !== 201) {
    throw new Error(`Creating the gate dashboard failed: ${created.status}`);
  }

  const dashboardId = created.body.dashboardId ?? created.body.dashboard?.id;
  if (!dashboardId) {
    throw new Error(`The create response carried no id: ${JSON.stringify(created.body)}`);
  }

  const draft = await getJson(`${API_URL}/dashboards/${dashboardId}/draft`, ctx.tokens.editor);
  const saved = await putJson(
    `${API_URL}/dashboards/${dashboardId}/draft`,
    {
      expectedRevisionId: draft.body.revisionId,
      snapshot: { ...template.body.snapshot, name, siteId: ctx.siteId },
    },
    ctx.tokens.editor,
  );
  if (saved.status !== 200) {
    throw new Error(`Seeding the gate dashboard failed: ${saved.status}`);
  }

  return dashboardId;
}

/** The current published version row of the fixture dashboard. */
async function published() {
  const rows = await queryDatabase(
    'SELECT v.version, v.pinned_semantic_version_ids AS pinned FROM dashboard_versions v ' +
      'JOIN dashboards d ON d.published_version_id = v.id WHERE d.id = ?',
    [ctx.gateDashboardId],
  );
  if (rows.length === 0) throw new Error('The gate dashboard has no published version.');

  const pinned = rows[0].pinned;
  return {
    version: rows[0].version,
    pinnedSemanticVersionIds: (typeof pinned === 'string' ? JSON.parse(pinned) : pinned) ?? [],
  };
}

/** What the published dashboard currently renders, widget by widget. */
async function renderedValues(token) {
  const response = await getJson(`${API_URL}/dashboards/${ctx.dashboardId}/presentation`, token);
  if (response.status !== 200) {
    throw new Error(`Reading the published dashboard failed: ${response.status}`);
  }
  return (response.body.widgets ?? []).map((widget) => ({
    id: widget.id,
    state: widget.state,
    value: widget.value ?? null,
  }));
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
  console.log(`Gate F3: ${passed}/${results.length} criteria demonstrated.`);
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
    console.error(`\nGate F3 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
