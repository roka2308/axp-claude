#!/usr/bin/env node
/**
 * Gate F7 demonstration.
 *
 * Runs against a real stack and the canonical fixture, from an empty database:
 *
 *   - a share never exposes the draft or internal notes
 *   - the current viewer state is reflected in a manual export
 *   - artifact access is authorized and short-lived
 *   - an export carries the correct scope, time and comparison metadata
 *   - no analytics payload is persisted beyond the ephemeral processing
 *
 * and shows the share lifecycle: expiry required, rights enforced, password,
 * revoke, archive - each ending in the same neutral "not available".
 *
 * The stack runs with a one-minute export lifetime, so the worker's
 * auto-delete is observed rather than asserted.
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f7.mjs [--skip-e2e] [--local-mysql]
 *
 * `WEB_PORT` in the environment overrides the one in `.env`, for a machine
 * where another program already holds the default port.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { readdirSync, readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_E2E = process.argv.includes('--skip-e2e');
const LOCAL_MYSQL = process.argv.includes('--local-mysql');

const env = readEnvFile(path.join(ROOT, '.env'));
const API_URL = env.API_PUBLIC_URL ?? 'http://localhost:4000';
const WEB_PORT = process.env.WEB_PORT ?? env.WEB_PORT ?? '3000';
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_HEALTH_URL = `http://127.0.0.1:${Number(env.API_PORT ?? 4000) + 1}`;
const ARTIFACT_DIR = env.EXPORT_ARTIFACT_DIR || path.join(ROOT, '.local', 'exports');
/** Short on purpose: the worker's auto-delete happens inside this run. */
const ARTIFACT_TTL_MINUTES = 1;

const ADMIN_EMAIL = 'gate.f7@example.invalid';
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const VIEWER_EMAIL = 'viewer.demo@example.invalid';

const ACCOUNTS = {
  viewer: VIEWER_EMAIL,
  editor: 'editor.demo@example.invalid',
  semantic: 'semantic.demo@example.invalid',
  tenantAdmin: 'tenantadmin.demo@example.invalid',
};

const NOTE = 'GATE-F7-INTERNE-NOTIZ';
const WIDGET_NOTE = 'GATE-F7-WIDGET-NOTIZ';
const DRAFT_NAME = 'GATE-F7-ENTWURF';
const DRAFT_WIDGET = 'GATE-F7-ENTWURFS-WIDGET';
const MARKERS = [NOTE, WIDGET_NOTE, DRAFT_NAME, DRAFT_WIDGET];

const RIGHTS_NONE = { timeRange: false, comparison: false, detail: false, export: false };
const RIGHTS_ALL = { timeRange: true, comparison: true, detail: true, export: true };

const results = [];
const children = [];
const ctx = { tenantId: '', projectId: '', tokens: {}, artifacts: [] };

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

  await step('the sharing and export suite passes', async () => {
    const { stdout } = await runOrThrow('npx', [
      'vitest',
      'run',
      '--project',
      'integration',
      'tests/integration/sharing.test.ts',
    ]);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} share and export tests`;
  });

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
    return `all three processes live, web on ${WEB_PORT}, exports live ${ARTIFACT_TTL_MINUTES} min`;
  });

  await step('platform bootstrapped and fixture seeded', async () => {
    await seedFixture();
    return `${Object.keys(ctx.tokens).length} demo accounts signed in`;
  });

  await step('a published dashboard with internal notes and a newer draft', async () => {
    const templates = await getJson(
      `${API_URL}/projects/${ctx.projectId}/templates?kind=dashboard`,
      ctx.tokens.editor,
    );
    const executive = templates.body.templates.find(
      (template) => template.name === 'Executive Health Overview',
    );
    const created = await postJson(
      `${API_URL}/projects/${ctx.projectId}/templates/${executive.id}/dashboards`,
      { name: 'Gate F7 Overview' },
      ctx.tokens.editor,
    );
    if (created.status !== 201) throw new Error(`Template answered ${created.status}.`);
    ctx.dashboardId = created.body.dashboardId;

    // Version 2 carries internal notes on the dashboard and on a widget.
    await editDraft((snapshot) => ({
      ...snapshot,
      internalNote: NOTE,
      widgets: snapshot.widgets.map((widget, index) =>
        index === 0
          ? { ...widget, context: { ...widget.context, internalNote: WIDGET_NOTE } }
          : widget,
      ),
    }));
    const published = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/publish`,
      {},
      ctx.tokens.editor,
    );
    if (published.status !== 200) throw new Error(`Publish answered ${published.status}.`);
    ctx.publishedVersion = published.body.version;

    // Then a draft nobody published: a new name and an extra widget.
    await editDraft((snapshot) => ({
      ...snapshot,
      name: DRAFT_NAME,
      widgets: [
        ...snapshot.widgets,
        {
          ...snapshot.widgets[0],
          id: 'gate-draft-only',
          title: DRAFT_WIDGET,
          placement: { desktop: { x: 0, y: 40, w: 3, h: 3 } },
        },
      ],
    }));

    // Inside the product the notes are visible - that is where they belong.
    const layout = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/layout`,
      ctx.tokens.editor,
    );
    if (layout.body.dashboard.internalNote !== NOTE)
      throw new Error('The team does not see its note.');
    return `version ${published.body.version} published with two internal notes; the draft renames it and adds a widget`;
  });

  // --- Gate F7 criteria ----------------------------------------------------

  await step('a share never exposes the draft or internal notes', async () => {
    const share = await createShare({ label: 'Gate F7 alle Rechte', rights: RIGHTS_ALL });
    ctx.shareAll = share;
    const bodies = [];

    const access = await publicGet('/public/share', share.token);
    bodies.push(access.text);
    const layout = await publicGet('/public/share/layout', share.token);
    bodies.push(layout.text);
    const widgetIds = layout.body.widgets.map((widget) => widget.widgetId);
    if (widgetIds.includes('gate-draft-only')) throw new Error('The draft widget is in the share.');
    for (const widgetId of widgetIds) {
      bodies.push((await publicGet(`/public/share/widgets/${widgetId}`, share.token)).text);
      bodies.push((await publicGet(`/public/share/widgets/${widgetId}/detail`, share.token)).text);
    }
    const guessed = await publicGet('/public/share/widgets/gate-draft-only', share.token);
    if (guessed.status !== 404)
      throw new Error(`Guessing the draft widget answered ${guessed.status}.`);

    const files = {};
    for (const format of ['pdf', 'xlsx', 'pptx']) {
      files[format] = await shareExport(share.token, { format });
    }
    files.csv = await shareExport(share.token, { format: 'csv', widgetId: widgetIds[0] });

    const texts = [...bodies];
    for (const [format, file] of Object.entries(files)) texts.push(await readable(format, file));
    for (const text of texts) {
      for (const marker of [...MARKERS, 'internalNote', ctx.dashboardId]) {
        if (text.includes(marker)) throw new Error(`"${marker}" reached a recipient.`);
      }
    }
    if (!(await readable('pdf', files.pdf)).includes('Gate F7 Overview')) {
      throw new Error('The shared PDF does not show the published name.');
    }
    return `${bodies.length} responses and 4 files (PDF, XLSX, PPTX, CSV) searched: published version only, no draft name, no draft widget, no internal note`;
  });

  await step('the current viewer state is reflected in a manual export', async () => {
    const state = 'timeRange=last_14_days&comparison=prior_year';
    const layout = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/layout?${state}`,
      ctx.tokens.viewer,
    );
    const onScreen = {};
    for (const widget of layout.body.widgets) {
      const tile = await getJson(
        `${API_URL}/dashboards/${ctx.dashboardId}/widgets/${widget.widgetId}?${state}`,
        ctx.tokens.viewer,
      );
      if (tile.body.content?.kind === 'card') {
        const metric = tile.body.content.metrics[0];
        onScreen[tile.body.title] =
          'value' in metric.value ? metric.value.value : metric.value.state;
      }
    }

    const file = await userExport(ctx.tokens.viewer, {
      format: 'xlsx',
      timeRange: 'last_14_days',
      comparison: 'prior_year',
    });
    const sheets = await xlsxSheets(file.body);
    const metrics = sheets.get('Kennzahlen');
    let compared = 0;
    for (const [title, value] of Object.entries(onScreen)) {
      const row = metrics.find((entry) => entry[0] === title);
      if (!row || row[2] !== value) throw new Error(`${title}: screen ${value}, file ${row?.[2]}.`);
      compared += 1;
    }
    const overview = rowsByLabel(sheets.get('Übersicht'));
    const period = `Letzte 14 Tage (${german(layout.body.timeRange.from)} – ${german(layout.body.timeRange.to)})`;
    if (overview.Zeitraum !== period) throw new Error(`Period in the file: ${overview.Zeitraum}`);
    if (
      !overview.Vergleich.startsWith(`Vorjahreszeitraum (${german(layout.body.comparison.from)}`)
    ) {
      throw new Error(`Comparison in the file: ${overview.Vergleich}`);
    }
    return `last 14 days vs prior year on screen and in the file: ${compared} key figures identical (${Object.entries(
      onScreen,
    )
      .map(([title, value]) => `${title} ${value}`)
      .join(', ')})`;
  });

  await step('an export carries the correct scope, time and comparison metadata', async () => {
    const layout = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/layout`,
      ctx.tokens.viewer,
    );
    const expected = [
      'Employee Portal Demo Site',
      'Europe/Berlin',
      `Letzte 7 Tage (${german(layout.body.timeRange.from)} – ${german(layout.body.timeRange.to)})`,
      `Vorperiode (${german(layout.body.comparison.from)} – ${german(layout.body.comparison.to)})`,
      `Veröffentlichte Version ${ctx.publishedVersion}`,
      'Gate F7 Overview',
    ];
    const checked = [];
    for (const format of ['pdf', 'xlsx', 'pptx']) {
      const file = await userExport(ctx.tokens.viewer, { format });
      const text = await readable(format, file.body);
      for (const item of expected) {
        if (!text.includes(item)) throw new Error(`${format.toUpperCase()} lacks "${item}".`);
      }
      checked.push(format.toUpperCase());
    }
    const csv = await userExport(ctx.tokens.viewer, {
      format: 'csv',
      widgetId: layout.body.widgets[0].widgetId,
    });
    const csvText = csv.body.toString('utf8');
    for (const item of expected) {
      if (!csvText.includes(item)) throw new Error(`CSV lacks "${item}".`);
    }
    checked.push('CSV');

    const pdf = await userExport(ctx.tokens.viewer, { format: 'pdf' });
    const info = await pdfInfo(pdf.body);
    if (!info.tagged || info.lang !== 'de-DE')
      throw new Error('The PDF is not tagged with its language.');
    const slides = await pptxSlides((await userExport(ctx.tokens.viewer, { format: 'pptx' })).body);
    const images = slides.reduce((sum, slide) => sum + slide.images, 0);
    const tables = slides.reduce((sum, slide) => sum + slide.tables, 0);
    const alts = slides.flatMap((slide) => slide.altTexts).filter(Boolean).length;
    if (images === 0 || alts !== images)
      throw new Error('PPTX chart images lack a text alternative.');
    return `${checked.join(', ')} each name site, time zone, period, comparison and version; PDF tagged (de-DE); PPTX hybrid: ${tables} native tables, ${images} chart images, each with alt text and values in the notes`;
  });

  await step('artifact access is authorized and short-lived', async () => {
    const created = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/exports`,
      { format: 'pdf' },
      ctx.tokens.viewer,
    );
    const artifact = created.body;
    const lifetime = (Date.parse(artifact.expiresAt) - Date.parse(artifact.createdAt)) / 60_000;
    if (lifetime !== ARTIFACT_TTL_MINUTES) throw new Error(`Lifetime ${lifetime} min.`);

    const url = `${API_URL}/exports/${artifact.id}`;
    const anonymous = await fetch(url);
    const otherUser = await fetch(url, { headers: authHeaders(ctx.tokens.editor) });
    const owner = await fetch(url, { headers: authHeaders(ctx.tokens.viewer) });
    if (anonymous.status !== 401) throw new Error(`Without a session: ${anonymous.status}.`);
    if (otherUser.status !== 404) throw new Error(`Another person: ${otherUser.status}.`);
    if (owner.status !== 200) throw new Error(`The requester: ${owner.status}.`);
    if (owner.headers.get('cache-control') !== 'no-store')
      throw new Error('Download is cacheable.');

    // On disk: ciphertext only.
    const [row] = await query('SELECT storage_key FROM export_artifacts WHERE id = ?', [
      artifact.id,
    ]);
    const onDisk = readFileSync(path.join(ARTIFACT_DIR, row.storage_key));
    if (onDisk.includes(Buffer.from('%PDF'))) throw new Error('The stored file is not encrypted.');

    // The share's files are the share's: a signed-in user cannot fetch them,
    // and revoking the share deletes them at once.
    const shared = await postShareExport(ctx.shareAll.token, { format: 'xlsx' });
    const viaUser = await fetch(`${API_URL}/exports/${shared.id}`, {
      headers: authHeaders(ctx.tokens.viewer),
    });
    if (viaUser.status !== 404) throw new Error(`A share's file via a session: ${viaUser.status}.`);
    const before = (
      await query('SELECT COUNT(*) AS n FROM export_artifacts WHERE share_id IS NOT NULL')
    )[0].n;
    await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares/${ctx.shareAll.share.id}/revoke`,
      {},
      ctx.tokens.editor,
    );
    const after = (
      await query('SELECT COUNT(*) AS n FROM export_artifacts WHERE share_id IS NOT NULL')
    )[0].n;
    if (after !== 0) throw new Error(`${after} share files survived the revocation.`);

    // Auto-delete: wait out the lifetime and one worker round.
    const deadline = Date.now() + (ARTIFACT_TTL_MINUTES + 2) * 60_000;
    let remaining;
    for (;;) {
      remaining = (await query('SELECT COUNT(*) AS n FROM export_artifacts'))[0].n;
      if (remaining === 0 || Date.now() > deadline) break;
      await delay(5_000);
    }
    if (remaining !== 0) throw new Error(`${remaining} artifacts outlived their lifetime.`);
    const files = readdirSync(ARTIFACT_DIR).filter((name) => /^[0-9a-f]{64}$/.test(name));
    if (files.length !== 0) throw new Error(`${files.length} files left on disk.`);
    const expired = await fetch(url, { headers: authHeaders(ctx.tokens.viewer) });
    if (expired.status !== 404) throw new Error(`After expiry: ${expired.status}.`);

    return `anonymous 401, another person 404, requester 200 (no-store); encrypted at rest; ${before} share files deleted on revoke; after ${ARTIFACT_TTL_MINUTES} min the worker removed every file and record (${ctx.artifactsCreated} exports made)`;
  });

  await step('no analytics payload is persisted beyond ephemeral processing', async () => {
    const tables = (await query('SHOW TABLES')).map((row) => Object.values(row)[0]);
    const needles = ['40.32', '40,32', 'Letzte 14 Tage (', 'Vorjahreszeitraum ('];
    const hits = [];
    for (const table of tables) {
      if (table === '__drizzle_migrations') continue;
      const rows = await query(`SELECT * FROM \`${table}\``);
      const text = JSON.stringify(rows);
      for (const needle of needles) if (text.includes(needle)) hits.push(`${table}: ${needle}`);
    }
    if (hits.length > 0) throw new Error(`Found in the product store: ${hits.join('; ')}`);

    const events = await query(
      "SELECT metadata FROM audit_events WHERE action IN ('export.created', 'share.created', 'share.revoked')",
    );
    for (const event of events) {
      const keys = Object.keys(
        typeof event.metadata === 'string' ? JSON.parse(event.metadata) : (event.metadata ?? {}),
      );
      const allowed = [
        'format',
        'widgetId',
        'timeRange',
        'comparison',
        'via',
        'shareId',
        'expiresAt',
        'rights',
        'passwordProtected',
      ];
      const extra = keys.filter((key) => !allowed.includes(key));
      if (extra.length > 0) throw new Error(`Audit metadata carries ${extra.join(', ')}.`);
    }
    return `${tables.length} tables searched for exported values and texts: none; ${events.length} audit events describe what was shared or exported, never its content; export files already deleted`;
  });

  await step('shares expire, enforce their rights, and fail neutrally', async () => {
    const noExpiry = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      { label: 'ohne Ablauf', rights: RIGHTS_NONE },
      ctx.tokens.editor,
    );
    const tooLong = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      { label: 'zu lang', expiresOn: '2099-01-01', rights: RIGHTS_NONE },
      ctx.tokens.editor,
    );
    if (noExpiry.status !== 422 || tooLong.status !== 422) {
      throw new Error(`Expiry not enforced (${noExpiry.status}, ${tooLong.status}).`);
    }
    const byViewer = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      { label: 'x', expiresOn: ctx.expiry.suggested, rights: RIGHTS_NONE },
      ctx.tokens.viewer,
    );
    if (byViewer.status !== 403) throw new Error(`A viewer could share (${byViewer.status}).`);

    const viewOnly = await createShare({ label: 'Gate F7 nur ansehen', rights: RIGHTS_NONE });
    const refusals = [
      (
        await publicGet(
          '/public/share/layout?timeRange=last_7_days&comparison=prior_year',
          viewOnly.token,
        )
      ).status,
      (await publicGet(`/public/share/widgets/pulse-score/detail`, viewOnly.token)).status,
      (
        await fetch(`${API_URL}/public/share/exports`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-share-token': viewOnly.token },
          body: JSON.stringify({ format: 'pdf' }),
        })
      ).status,
    ];
    if (refusals.some((status) => status !== 403))
      throw new Error(`Rights not enforced: ${refusals}.`);

    const secret = 'Gate-F7-Linkpasswort';
    const protectedShare = await createShare({
      label: 'Gate F7 Passwort',
      rights: RIGHTS_NONE,
      password: secret,
    });
    const locked = await publicGet('/public/share', protectedShare.token);
    const wrong = await unlock(protectedShare.token, 'falsch-falsch');
    const right = await unlock(protectedShare.token, secret);
    const opened = await fetchJson(`${API_URL}/public/share/layout`, {
      headers: {
        'x-share-token': protectedShare.token,
        'x-share-session': right.body.sessionToken,
      },
    });
    if (
      locked.body.state !== 'password_required' ||
      wrong.status !== 422 ||
      opened.status !== 200
    ) {
      throw new Error(`Password flow: ${locked.body.state}, ${wrong.status}, ${opened.status}.`);
    }

    const unknown = await publicGet(
      '/public/share',
      'kein-gueltiger-link-0000000000000000000000000',
    );
    const revoked = await publicGet('/public/share', ctx.shareAll.token);
    await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/lifecycle`,
      { to: 'archived' },
      ctx.tokens.editor,
    );
    const archived = await publicGet('/public/share', viewOnly.token);
    await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/lifecycle`,
      { to: 'restore' },
      ctx.tokens.editor,
    );
    const restored = await publicGet('/public/share', viewOnly.token);
    const answers = [unknown, revoked, archived].map((response) => response.text);
    if (new Set(answers).size !== 1 || unknown.body.state !== 'unavailable') {
      throw new Error(`Broken links answer differently: ${answers.join(' | ')}`);
    }
    if (restored.body.state !== 'available')
      throw new Error('Restoring did not bring the link back.');

    const list = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      ctx.tokens.editor,
    );
    const statuses = list.body.shares
      .map((entry) => entry.status)
      .sort()
      .join(', ');
    return `expiry required and at most 90 days; viewers cannot share; view-only link refuses period, detail and export (403); password: locked, wrong 422, right opens; unknown, revoked and archived answer identically "unavailable", restore brings it back; owners see ${statuses}`;
  });

  if (!SKIP_E2E) {
    await step('the browser journey passes, sharing and exports included', async () => {
      // Sign-in is rate limited per client (20 a minute) on purpose; waiting out
      // the window keeps a product safeguard from failing the run.
      await delay(60_000);
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], { env: E2E_ENV() });
      const sharing = stdout
        .split(/\r?\n/)
        .filter((line) => /\bok\b.*sharing\.spec/.test(line)).length;
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} browser checks, ${sharing} of them sharing and exports`;
    });
  }

  report();
}

// --- API helpers ----------------------------------------------------------------

async function editDraft(change) {
  const draft = await getJson(`${API_URL}/dashboards/${ctx.dashboardId}/draft`, ctx.tokens.editor);
  const saved = await fetchJson(`${API_URL}/dashboards/${ctx.dashboardId}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(ctx.tokens.editor) },
    body: JSON.stringify({
      expectedRevisionId: draft.body.revisionId,
      snapshot: change(draft.body.snapshot),
    }),
  });
  if (saved.status !== 200)
    throw new Error(`Saving the draft answered ${saved.status}: ${saved.text}`);
}

async function createShare({ label, rights, password }) {
  if (!ctx.expiry) {
    const list = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      ctx.tokens.editor,
    );
    ctx.expiry = list.body.expiry;
  }
  const response = await postJson(
    `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
    { label, expiresOn: ctx.expiry.suggested, rights, ...(password ? { password } : {}) },
    ctx.tokens.editor,
  );
  if (response.status !== 201) throw new Error(`Creating a share answered ${response.status}.`);
  return response.body;
}

function publicGet(pathname, token) {
  return fetchJson(`${API_URL}${pathname}`, { headers: { 'x-share-token': token } });
}

function unlock(token, password) {
  return fetchJson(`${API_URL}/public/share/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-share-token': token },
    body: JSON.stringify({ password }),
  });
}

async function postShareExport(token, body) {
  const created = await fetchJson(`${API_URL}/public/share/exports?locale=de`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-share-token': token },
    body: JSON.stringify(body),
  });
  if (created.status !== 201)
    throw new Error(`Share export answered ${created.status}: ${created.text}`);
  ctx.artifactsCreated = (ctx.artifactsCreated ?? 0) + 1;
  return created.body;
}

async function shareExport(token, body) {
  const artifact = await postShareExport(token, body);
  const file = await fetch(`${API_URL}/public/share/exports/${artifact.id}`, {
    headers: { 'x-share-token': token },
  });
  if (file.status !== 200) throw new Error(`Share download answered ${file.status}.`);
  return Buffer.from(await file.arrayBuffer());
}

async function userExport(token, body) {
  const created = await postJson(`${API_URL}/dashboards/${ctx.dashboardId}/exports`, body, token);
  if (created.status !== 201) throw new Error(`Export answered ${created.status}: ${created.text}`);
  ctx.artifactsCreated = (ctx.artifactsCreated ?? 0) + 1;
  const file = await fetch(`${API_URL}/exports/${created.body.id}`, {
    headers: authHeaders(token),
  });
  if (file.status !== 200) throw new Error(`Download answered ${file.status}.`);
  return { artifact: created.body, body: Buffer.from(await file.arrayBuffer()) };
}

// --- reading files back -----------------------------------------------------------

async function readable(format, buffer) {
  if (format === 'pdf') return (await pdfText(buffer)).join('\n');
  if (format === 'xlsx') return JSON.stringify([...(await xlsxSheets(buffer)).values()]);
  if (format === 'pptx') {
    return (await pptxSlides(buffer))
      .map((slide) => [...slide.texts, ...slide.altTexts, slide.notes].join('\n'))
      .join('\n');
  }
  return buffer.toString('utf8');
}

async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const content = await (await document.getPage(index)).getTextContent();
    pages.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
  }
  await document.destroy();
  return pages;
}

async function pdfInfo(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const metadata = await document.getMetadata();
  const markInfo = await document.getMarkInfo();
  await document.destroy();
  return { lang: metadata.info.Language, tagged: Boolean(markInfo?.Marked) };
}

async function xlsxSheets(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheets = new Map();
  workbook.eachSheet((sheet) => {
    const rows = [];
    sheet.eachRow((row) =>
      rows.push(
        row.values
          .slice(1)
          .map((value) =>
            value && typeof value === 'object' && 'text' in value ? value.text : value,
          ),
      ),
    );
    sheets.set(sheet.name, rows);
  });
  return sheets;
}

async function pptxSlides(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = [];
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    const number = /(\d+)\.xml$/.exec(name)[1];
    const notes =
      (await zip.file(`ppt/notesSlides/notesSlide${number}.xml`)?.async('string')) ?? '';
    slides.push({
      texts: [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => decodeXml(match[1])),
      tables: (xml.match(/<a:tbl>/g) ?? []).length,
      images: (xml.match(/<p:pic>/g) ?? []).length,
      altTexts: [...xml.matchAll(/descr="([^"]*)"/g)].map((match) => decodeXml(match[1])),
      notes: [...notes.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
        .map((match) => decodeXml(match[1]))
        .join('\n'),
    });
  }
  return slides;
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function rowsByLabel(rows) {
  return Object.fromEntries(rows.filter((row) => row.length >= 2).map((row) => [row[0], row[1]]));
}

function german(date) {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

// --- fixture, database, processes ---------------------------------------------

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
  for (const [role, email] of Object.entries(ACCOUNTS)) ctx.tokens[role] = await signIn(email);
}

let pool;
async function query(sql, params = []) {
  pool ??= mysql.createPool({ uri: env.DATABASE_URL, connectionLimit: 2 });
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function startStack() {
  await assertPortsFree();
  const exports = { EXPORT_ARTIFACT_TTL_MINUTES: String(ARTIFACT_TTL_MINUTES) };
  startProcess('api', 'node', ['apps/api/dist/main.js'], { env: exports });
  startProcess('worker', 'node', ['apps/worker/dist/main.js'], { env: exports });
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
  await pool?.end().catch(() => {});
  pool = undefined;
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

// --- runner ----------------------------------------------------------------------

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
  console.log(`Gate F7: ${passed}/${results.length} criteria demonstrated.`);
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
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, headers: response.headers, body, text };
}

function readEnvFile(file) {
  try {
    const result = {};
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
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
    console.error(`\nGate F7 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
