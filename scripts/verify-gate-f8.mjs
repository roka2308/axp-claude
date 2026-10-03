#!/usr/bin/env node
/**
 * Gate F8 demonstration.
 *
 * Runs against a real stack and the canonical fixture, from an empty database:
 *
 *   - schedules use the Published Runtime
 *   - a suspended or offboarding tenant stops reports, shares and customer jobs
 *   - repeated failure is grouped
 *   - operational attention items are not analytics recommendation alerts
 *
 * and shows the build list working: the job queue retrying with backoff, a
 * relative period resolved in the schedule's time zone at the moment it was
 * due, recipient permissions checked, in-app first with one selective mail.
 *
 * Mail goes to a small SMTP sink inside this script, so the gate reads what was
 * really sent - the attachment, the subject, who received it.
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f8.mjs [--skip-e2e] [--local-mysql]
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_E2E = process.argv.includes('--skip-e2e');
const LOCAL_MYSQL = process.argv.includes('--local-mysql');

const env = readEnvFile(path.join(ROOT, '.env'));
const API_URL = env.API_PUBLIC_URL ?? 'http://localhost:4000';
const WEB_PORT = process.env.WEB_PORT ?? env.WEB_PORT ?? '3000';
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_HEALTH_URL = `http://127.0.0.1:${Number(env.API_PORT ?? 4000) + 1}`;
const SMTP_PORT = 2526;

const ADMIN_EMAIL = 'gate.f8@example.invalid';
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const VIEWER_EMAIL = 'viewer.demo@example.invalid';
const ACCOUNTS = {
  viewer: VIEWER_EMAIL,
  editor: 'editor.demo@example.invalid',
  semantic: 'semantic.demo@example.invalid',
  tenantAdmin: 'tenantadmin.demo@example.invalid',
};
const OPERATIONAL_KINDS = [
  'report_failed',
  'report_recipient_without_access',
  'share_expiring',
  'mapping_review',
  'inactivity_review',
];
const DRAFT_MARKER = 'GATE-F8-ENTWURF';

const results = [];
const children = [];
const ctx = { tokens: {}, users: {} };
const sink = startSmtpSink(SMTP_PORT);

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

  await step('the reporting and attention suite passes', async () => {
    const { stdout } = await runOrThrow('npx', [
      'vitest',
      'run',
      '--project',
      'integration',
      'tests/integration/reporting.test.ts',
    ]);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} queue, report and attention tests`;
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

  await step('api, worker and web start, mail goes to the gate’s SMTP sink', async () => {
    await startStack();
    const ready = await fetchJson(`${API_URL}/readyz`);
    if (ready.body.status !== 'ready') throw new Error('API readiness reported not_ready.');
    return `all three processes live, web on ${WEB_PORT}, SMTP sink on ${SMTP_PORT}`;
  });

  await step('platform bootstrapped and fixture seeded', async () => {
    await seedFixture();
    const library = await getJson(`${API_URL}/dashboards`, ctx.tokens.viewer);
    const executive = library.body.dashboards.find(
      (entry) => entry.name === 'Executive Health Overview',
    );
    ctx.dashboardId = executive.id;
    ctx.projectId = executive.projectId;
    const versions = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/versions`,
      ctx.tokens.viewer,
    );
    ctx.publishedVersion = versions.body.versions.find((entry) => entry.isCurrent).version;
    return `${Object.keys(ctx.tokens).length} demo accounts signed in; "Executive Health Overview" is at version ${ctx.publishedVersion}`;
  });

  await step(
    'a schedule names a published dashboard, a relative period and an explicit time zone',
    async () => {
      const refused = {
        noAccess: await createSchedule({ recipientUserIds: [ctx.users.tenantAdmin] }),
        pptx: await createSchedule({ format: 'pptx' }),
        zone: await createSchedule({ timezone: 'Mars/Olympus' }),
      };
      for (const [why, response] of Object.entries(refused)) {
        if (response.status !== 422) throw new Error(`${why}: ${response.status}`);
      }
      const viewerTry = await postJson(
        `${API_URL}/projects/${ctx.projectId}/reports`,
        scheduleBody(),
        ctx.tokens.viewer,
      );
      if (viewerTry.status !== 403)
        throw new Error(`A viewer could schedule (${viewerTry.status}).`);

      const created = await createSchedule({ name: 'Gate F8 Wochenbericht' });
      if (created.status !== 201)
        throw new Error(`Creating answered ${created.status}: ${created.text}`);
      ctx.scheduleId = created.body.id;
      return `refused: a recipient without access (the tenant admin has no data grant), PPTX before its stability gate, an unknown zone, a viewer as author; created "Gate F8 Wochenbericht", next run ${created.body.nextRunAt} (07:00 Europe/Berlin)`;
    },
  );

  // --- Gate F8 criteria ----------------------------------------------------

  await step('schedules use the Published Runtime', async () => {
    await editDraft((snapshot) => ({ ...snapshot, name: DRAFT_MARKER }));
    const run = await runNow(ctx.scheduleId);
    const finished = await waitForRun(run.id, ['delivered', 'partially_delivered']);
    await editDraft((snapshot) => ({ ...snapshot, name: 'Executive Health Overview' }));

    const sent = sink.messages.filter((message) =>
      message.subject.startsWith('Gate F8 Wochenbericht'),
    );
    if (sent.length !== 2) throw new Error(`${sent.length} report mails, expected 2.`);
    const pdf = attachmentOf(sent[0], 'application/pdf');
    const text = (await pdfText(pdf)).join('\n');
    if (text.includes(DRAFT_MARKER)) throw new Error('The report shows the draft.');
    if (!text.includes(`Veröffentlichte Version ${ctx.publishedVersion}`)) {
      throw new Error('The report does not name the published version.');
    }
    if (finished.publishedVersion !== ctx.publishedVersion) {
      throw new Error(`The run read version ${finished.publishedVersion}.`);
    }
    const recipients = sent.map((message) => message.to.join(',')).sort();
    return `draft renamed to "${DRAFT_MARKER}" before the run; the PDF mailed to ${recipients.join(' and ')} (one mail each) shows "Executive Health Overview", version ${finished.publishedVersion}, period ${finished.periodFrom} – ${finished.periodTo}`;
  });

  await step(
    'a scheduled occurrence runs at its local time and covers the period relative to it',
    async () => {
      const at = berlinClock(2);
      const created = await createSchedule({
        name: 'Gate F8 Tagesbericht',
        rhythm: { frequency: 'daily', time: at.time },
        recipientUserIds: [ctx.users.viewer],
      });
      if (created.status !== 201) throw new Error(`Creating answered ${created.status}.`);
      const run = await waitForScheduledRun(created.body.id, 5 * 60_000);
      const finished = await waitForRun(run.id, ['delivered']);

      const plannedLocal = berlinParts(new Date(finished.plannedFor));
      const yesterday = addDays(plannedLocal.date, -1);
      if (plannedLocal.time !== at.time)
        throw new Error(`Ran at ${plannedLocal.time}, not ${at.time}.`);
      if (finished.periodTo !== yesterday || finished.periodFrom !== addDays(yesterday, -6)) {
        throw new Error(
          `Period ${finished.periodFrom} – ${finished.periodTo} for ${plannedLocal.date}.`,
        );
      }
      ctx.dailyScheduleId = created.body.id;
      return `due ${at.time} Europe/Berlin, run by the worker on its own (trigger "schedule"); last 7 days relative to ${plannedLocal.date}: ${finished.periodFrom} – ${finished.periodTo}`;
    },
  );

  await step('the job queue retries a failed delivery with backoff', async () => {
    sink.rejectNext = 1;
    const run = await runNow(ctx.dailyScheduleId);
    const first = await waitForRunState(
      run.id,
      (state) => state.attempts >= 1 && state.status === 'queued',
    );
    const job = (
      await query('SELECT status, attempts, run_after, last_error_code FROM jobs WHERE id = ?', [
        first.jobId,
      ])
    )[0];
    const backoffSeconds = Math.round((new Date(job.run_after).getTime() - Date.now()) / 1000);
    const finished = await waitForRun(run.id, ['delivered'], 3 * 60_000);
    const payloads = await query('SELECT payload FROM jobs');
    const keys = new Set(
      payloads.flatMap((row) =>
        Object.keys(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload),
      ),
    );
    if ([...keys].some((key) => key !== 'runId'))
      throw new Error(`Job payloads carry ${[...keys].join(', ')}.`);
    return `attempt 1 refused by the mail server (${job.last_error_code}), retried after about ${Math.max(0, backoffSeconds)} s, attempt ${finished.attempts} delivered; ${payloads.length} job payloads hold nothing but a run id`;
  });

  await step('repeated failure is grouped', async () => {
    const notices = () =>
      sink.messages.filter(
        (message) =>
          message.to.includes('editor.demo@example.invalid') && /Hinweis/.test(message.subject),
      ).length;
    const before = notices();
    await setLifecycle('archived');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = await runNow(ctx.dailyScheduleId);
      await waitForRun(run.id, ['failed']);
    }
    const items = (await getJson(`${API_URL}/attention`, ctx.tokens.editor)).body.items.filter(
      (item) => item.kind === 'report_failed',
    );
    if (items.length !== 1) throw new Error(`${items.length} items for one problem.`);
    if (items[0].occurrences !== 3) throw new Error(`Occurrences: ${items[0].occurrences}.`);
    if (notices() - before !== 1) throw new Error(`${notices() - before} notice mails.`);
    const viewerSees = (await getJson(`${API_URL}/attention`, ctx.tokens.viewer)).body.items.length;

    await setLifecycle('restore');
    const recovered = await runNow(ctx.dailyScheduleId);
    await waitForRun(recovered.id, ['delivered']);
    const after = (await getJson(`${API_URL}/attention`, ctx.tokens.editor)).body.items.filter(
      (item) => item.kind === 'report_failed',
    );
    if (after.length !== 0) throw new Error('The item stayed after the problem went away.');
    return `three failed runs ("${items[0].severity}") are one item counted 3×, one notice mail to the owner, nothing for the viewer (${viewerSees} items); after the dashboard was restored the next run delivered and the item resolved itself`;
  });

  await step('a suspended tenant stops reports, shares and customer jobs', async () => {
    const share = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      {
        label: 'Gate F8',
        expiresOn: (await shareExpiry()).suggested,
        rights: { timeRange: false, comparison: false, detail: false, export: false },
      },
      ctx.tokens.editor,
    );
    const token = share.body.token;
    const at = berlinClock(2);
    const created = await createSchedule({
      name: 'Gate F8 gesperrt',
      rhythm: { frequency: 'daily', time: at.time },
      recipientUserIds: [ctx.users.viewer],
    });
    const mailsBefore = sink.messages.length;

    await changeTenant('suspended');
    const run = await waitForScheduledRun(created.body.id, 5 * 60_000);
    const finished = await waitForRun(run.id, ['skipped']);
    const shareState = (
      await fetchJson(`${API_URL}/public/share`, { headers: { 'x-share-token': token } })
    ).body.state;
    const manual = await postJson(
      `${API_URL}/projects/${ctx.projectId}/reports/${created.body.id}/run`,
      {},
      ctx.tokens.editor,
    );
    const mailsDuring = sink.messages.length - mailsBefore;

    await changeTenant('active');
    // Suspending ended every session of the tenant's people; they sign in again.
    for (const [role, email] of Object.entries(ACCOUNTS)) ctx.tokens[role] = await signIn(email);
    const resumed = (
      await fetchJson(`${API_URL}/public/share`, { headers: { 'x-share-token': token } })
    ).body.state;
    if (
      finished.errorKey !== 'report.tenant_inactive' ||
      shareState !== 'unavailable' ||
      ![401, 403].includes(manual.status) ||
      mailsDuring !== 0 ||
      resumed !== 'available'
    ) {
      throw new Error(
        `run ${finished.status}/${finished.errorKey}, share ${shareState}, manual ${manual.status}, mails ${mailsDuring}, after ${resumed}`,
      );
    }
    return `while suspended: the due run was recorded as skipped (${finished.errorKey}) and no job ran, the shared link answered "unavailable", "send now" was refused (${manual.status === 401 ? '401 - suspending also ended the tenant sessions' : '403'}), no mail left; reactivated, the link works again (a job queued before a suspension is cancelled - reporting.test.ts)`;
  });

  await step('operational attention items are not analytics recommendation alerts', async () => {
    const columnType = (
      await query(
        "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attention_items' AND COLUMN_NAME = 'kind'",
      )
    )[0].t;
    const kinds = [...columnType.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    if (kinds.join() !== OPERATIONAL_KINDS.join()) throw new Error(`Kinds: ${kinds.join(', ')}`);
    const columns = (
      await query(
        "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attention_items'",
      )
    ).map((row) => row.c);
    for (const forbidden of ['metric', 'value', 'threshold', 'semantic_version_id', 'widget_id']) {
      if (columns.some((column) => column.includes(forbidden)))
        throw new Error(`Column like ${forbidden}.`);
    }
    const create = await postJson(
      `${API_URL}/attention`,
      { kind: 'metric_drop' },
      ctx.tokens.editor,
    );
    if (create.status !== 404) throw new Error(`Creating an item answered ${create.status}.`);
    const seen = new Set();
    for (const token of Object.values(ctx.tokens)) {
      for (const item of (await getJson(`${API_URL}/attention`, token)).body.items)
        seen.add(item.kind);
    }
    if ([...seen].some((kind) => !OPERATIONAL_KINDS.includes(kind)))
      throw new Error(`Saw ${[...seen].join(', ')}.`);
    return `the store knows exactly five kinds (${kinds.join(', ')}), has no metric, value or threshold column and no route to create an item; every item any demo account sees is operational`;
  });

  if (!SKIP_E2E) {
    await step('the browser journey passes, reports and attention included', async () => {
      await delay(60_000);
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], { env: E2E_ENV() });
      const reporting = stdout
        .split(/\r?\n/)
        .filter((line) => /\bok\b.*reporting\.spec/.test(line)).length;
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} browser checks, ${reporting} of them reports and attention`;
    });
  }

  report();
}

// --- API helpers ------------------------------------------------------------------

function scheduleBody(patch = {}) {
  return {
    dashboardId: ctx.dashboardId,
    name: 'Gate F8',
    format: 'pdf',
    period: 'last_7_days',
    comparison: 'previous_period',
    rhythm: { frequency: 'daily', time: '07:00' },
    timezone: 'Europe/Berlin',
    deliveryMode: 'attachment',
    recipientUserIds: [ctx.users.viewer, ctx.users.editor],
    ...patch,
  };
}

function createSchedule(patch) {
  return postJson(
    `${API_URL}/projects/${ctx.projectId}/reports`,
    scheduleBody(patch),
    ctx.tokens.editor,
  );
}

async function runNow(scheduleId) {
  const response = await postJson(
    `${API_URL}/projects/${ctx.projectId}/reports/${scheduleId}/run`,
    {},
    ctx.tokens.editor,
  );
  if (response.status !== 202)
    throw new Error(`Send now answered ${response.status}: ${response.text}`);
  return response.body;
}

async function runRow(runId) {
  const [row] = await query('SELECT * FROM report_runs WHERE id = ?', [runId]);
  return (
    row && {
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      errorKey: row.error_key,
      jobId: row.job_id,
      publishedVersion: row.published_version,
      periodFrom: row.period_from,
      periodTo: row.period_to,
      plannedFor: row.planned_for,
    }
  );
}

async function waitForRunState(runId, done, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await runRow(runId);
    if (state && done(state)) return state;
    if (Date.now() > deadline)
      throw new Error(`Run ${runId} stayed ${state?.status} (${state?.errorKey}).`);
    await delay(1000);
  }
}

function waitForRun(runId, statuses, timeoutMs = 60_000) {
  return waitForRunState(runId, (state) => statuses.includes(state.status), timeoutMs);
}

async function waitForScheduledRun(scheduleId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await query(
      "SELECT id FROM report_runs WHERE schedule_id = ? AND `trigger` = 'schedule'",
      [scheduleId],
    );
    if (row) return row;
    if (Date.now() > deadline) throw new Error('The scheduled occurrence did not come.');
    await delay(2000);
  }
}

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
  if (saved.status !== 200) throw new Error(`Saving the draft answered ${saved.status}.`);
}

async function setLifecycle(to) {
  const response = await postJson(
    `${API_URL}/dashboards/${ctx.dashboardId}/lifecycle`,
    { to },
    ctx.tokens.editor,
  );
  if (response.status !== 200) throw new Error(`Lifecycle ${to} answered ${response.status}.`);
}

async function shareExpiry() {
  return (await getJson(`${API_URL}/dashboards/${ctx.dashboardId}/shares`, ctx.tokens.editor)).body
    .expiry;
}

async function changeTenant(to) {
  ctx.tokens.platform = await signIn(ADMIN_EMAIL);
  const impact = await getJson(
    `${API_URL}/admin/platform/tenants/${ctx.tenantId}/lifecycle-impact?to=${to}`,
    ctx.tokens.platform,
  );
  const response = await postJson(
    `${API_URL}/admin/platform/tenants/${ctx.tenantId}/lifecycle`,
    { to, confirmation: impact.body.confirmationPhrase },
    ctx.tokens.platform,
  );
  if (response.status !== 200)
    throw new Error(`Tenant → ${to} answered ${response.status}: ${response.text}`);
  delete ctx.tokens.platform;
}

/** Berlin wall-clock time some minutes from now, and the date it falls on. */
function berlinClock(minutesAhead) {
  return berlinParts(new Date(Date.now() + minutesAhead * 60_000));
}

function berlinParts(instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// --- the SMTP sink -------------------------------------------------------------------

/**
 * Just enough SMTP to receive what the worker sends: no TLS, no auth, one
 * message per DATA. `rejectNext` answers the next messages with a temporary
 * failure, which is how the gate makes the queue retry.
 */
function startSmtpSink(port) {
  const state = { messages: [], rejectNext: 0 };
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = { to: [], raw: '' };
    socket.setEncoding('utf8');
    socket.write('220 gate-sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.raw = buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
          buffer = buffer.slice(end + 5);
          inData = false;
          if (state.rejectNext > 0) {
            state.rejectNext -= 1;
            socket.write('451 4.3.0 Try again later\r\n');
          } else {
            state.messages.push({
              to: current.to,
              subject: subjectOf(current.raw),
              raw: current.raw,
            });
            socket.write('250 2.0.0 Ok\r\n');
          }
          current = { to: [], raw: '' };
          continue;
        }
        const index = buffer.indexOf('\r\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO') socket.write('250-gate-sink\r\n250 8BITMIME\r\n');
        else if (command === 'HELO') socket.write('250 gate-sink\r\n');
        else if (command === 'MAIL') socket.write('250 Ok\r\n');
        else if (command === 'RCPT') {
          current.to.push(/<([^>]+)>/.exec(line)?.[1] ?? line);
          socket.write('250 Ok\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else socket.write('250 Ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  server.listen(port, '127.0.0.1');
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}

function subjectOf(raw) {
  const headers = raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
  const subject = /^Subject: (.*)$/im.exec(headers)?.[1] ?? '';
  return subject
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, encoding, text) =>
      encoding.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(
            text
              .replace(/_/g, ' ')
              .replace(/=([0-9A-F]{2})/gi, (__, hex) => String.fromCharCode(parseInt(hex, 16))),
            'latin1',
          ).toString('utf8'),
    )
    .replace(/\?=\s+=\?/g, '');
}

function attachmentOf(message, contentType) {
  const parts = message.raw.split(/\r\n--[^\r\n]+\r\n/);
  const part = parts.find((entry) => entry.toLowerCase().includes(`content-type: ${contentType}`));
  if (!part) throw new Error(`No ${contentType} attachment.`);
  const body = part
    .split('\r\n\r\n')
    .slice(1)
    .join('\r\n\r\n')
    .replace(/\r\n--[^\r\n]*--\s*$/, '');
  return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
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

// --- fixture, database, processes ---------------------------------------------------

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
  for (const [role, email] of Object.entries(ACCOUNTS)) ctx.tokens[role] = await signIn(email);
  const people = await query('SELECT id, email FROM users');
  for (const [role, email] of Object.entries(ACCOUNTS)) {
    ctx.users[role] = people.find((person) => person.email === email).id;
  }
}

let pool;
async function query(sql, params = []) {
  pool ??= mysql.createPool({ uri: env.DATABASE_URL, connectionLimit: 2, timezone: 'Z' });
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function startStack() {
  await assertPortsFree();
  const mail = {
    MAIL_TRANSPORT: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(SMTP_PORT),
    SMTP_SECURE: 'false',
    WORKER_JOB_POLL_MS: '1000',
  };
  startProcess('api', 'node', ['apps/api/dist/main.js'], { env: mail });
  startProcess('worker', 'node', ['apps/worker/dist/main.js'], { env: mail });
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
  await sink.close?.();
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

// --- runner ------------------------------------------------------------------------

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
  console.log(`Gate F8: ${passed}/${results.length} criteria demonstrated.`);
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
    console.error(`\nGate F8 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
