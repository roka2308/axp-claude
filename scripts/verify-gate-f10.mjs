#!/usr/bin/env node
/**
 * Gate F10 demonstration - MVP hardening and acceptance.
 *
 * "All MVP acceptance criteria pass. Remaining items are explicitly classified
 * as MVP+, Performance Gate, Production Readiness or On Hold."
 *
 * Runs the workstreams of Phase 10 against a real stack:
 *
 *   - static checks, the unit and integration suites (tenant isolation sweep,
 *     log content review, performance and robustness, export reliability,
 *     package attacks, account mail and rate limits are integration suites)
 *   - the production dependency audit
 *   - an upgrade rehearsal: the previous release creates its schema and the
 *     canonical fixture with its own code, this release upgrades it
 *   - mailed invitation, password recovery and verified address change, read
 *     from a real SMTP conversation
 *   - rate limits that count each visitor, not the web server
 *   - the logs of the running stack, reviewed for secrets and people
 *   - cold and warm timings of real dashboards
 *   - a backup/restore rehearsal of the product state
 *   - the browser journey across Chromium, Firefox, WebKit and mobile Safari,
 *     with the automated accessibility audit
 *   - the acceptance matrix: every checklist item has evidence or a class
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f10.mjs [--skip-e2e] [--local-mysql]
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_E2E = process.argv.includes('--skip-e2e');
const LOCAL_MYSQL = process.argv.includes('--local-mysql');

const env = readEnvFile(path.join(ROOT, '.env'));
const API_URL = env.API_PUBLIC_URL ?? 'http://localhost:4000';
const WEB_PORT = process.env.WEB_PORT ?? env.WEB_PORT ?? '3000';
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_HEALTH_URL = `http://127.0.0.1:${Number(env.API_PORT ?? 4000) + 1}`;
const SMTP_PORT = 2527;
const PREVIOUS_RELEASE = 'v0.9-themes-entitlements-diagnostics';
const UPGRADE_DIR = path.join(ROOT, '.local', 'upgrade-from-v0.9');
const LOG_DIR = path.join(ROOT, '.local', 'gate-f10');
const DATABASE = new URL(env.DATABASE_URL ?? 'mysql://x@localhost/axp').pathname.slice(1);

const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const NEW_PASSWORD = 'neues-pferd-batterie-heftklammer';
const DEMO_MATOMO_TOKEN = 'demo-token-not-a-real-credential';
const ACCOUNTS = {
  viewer: 'viewer.demo@example.invalid',
  editor: 'editor.demo@example.invalid',
  semantic: 'semantic.demo@example.invalid',
  tenantAdmin: 'tenantadmin.demo@example.invalid',
  platform: 'platformadmin.demo@example.invalid',
};
/** Advisories in code the product never runs; see docs/acceptance/mvp-acceptance.md. */
const KNOWN_UNREACHABLE_ADVISORIES = ['image-size', 'uuid', 'pptxgenjs', 'exceljs'];

const results = [];
const children = [];
const ctx = { tokens: {}, secrets: new Map() };
const sink = startSmtpSink(SMTP_PORT);

const E2E_ENV = () => ({
  ...process.env,
  WEB_PORT,
  E2E_BASE_URL: WEB_URL,
  E2E_ADMIN_EMAIL: ACCOUNTS.platform,
  E2E_ADMIN_PASSWORD: PASSWORD,
  E2E_VIEWER_EMAIL: ACCOUNTS.viewer,
  E2E_VIEWER_PASSWORD: PASSWORD,
});

async function main() {
  if ((env.APP_ENV ?? 'development') !== 'development') {
    throw new Error(`Refusing to run: APP_ENV is "${env.APP_ENV}", expected "development".`);
  }
  mkdirSync(LOG_DIR, { recursive: true });

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

  await step('static checks pass: types, lint, formatting', async () => {
    await runOrThrow('npm', ['run', 'typecheck']);
    await runOrThrow('npm', ['run', 'lint']);
    await runOrThrow('npm', ['run', 'format:check']);
    return 'typecheck, eslint (boundaries, no new Date(), design tokens) and prettier clean';
  });

  await step('unit suite passes', async () => {
    const { stdout } = await runOrThrow('npm', ['run', 'test']);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests`;
  });

  await step('integration suite passes', async () => {
    const { stdout } = await runOrThrow('npm', ['run', 'test:integration']);
    return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests against MySQL`;
  });

  await step('tenant isolation regression: every route, every tenant role', async () => {
    const report = path.join(LOG_DIR, 'isolation.json');
    await runOrThrow(
      'npx',
      ['vitest', 'run', '--project', 'integration', 'tests/integration/isolation.test.ts'],
      { env: { ...process.env, ISOLATION_REPORT: report } },
    );
    const { calls, statuses, validationFirst } = JSON.parse(readFileSync(report, 'utf8'));
    if (validationFirst.length > 0) throw new Error(`${validationFirst.length} routes unprobed.`);
    return `${calls} calls with another tenant's ids by tenant admin, editor, viewer and catalog manager: ${Object.entries(
      statuses,
    )
      .map(([status, n]) => `${n}× ${status}`)
      .join(
        ', ',
      )} - none succeeded, none failed with a server error; a control sweep with their own ids does succeed; the platform administrator gets no customer analytics; ids inside bodies and queries (grants, roles, groups, schedules, projects, theme, search, lists) refused`;
  });

  await step('production dependencies have no reachable advisory', async () => {
    const { stdout } = await run('npm', ['audit', '--omit=dev', '--json']);
    const audit = JSON.parse(stdout);
    const entries = Object.values(audit.vulnerabilities ?? {});
    const critical = entries.filter((entry) => entry.severity === 'critical');
    const unexpected = entries.filter(
      (entry) => !KNOWN_UNREACHABLE_ADVISORIES.includes(entry.name),
    );
    if (critical.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Advisories: ${entries.map((entry) => `${entry.name} (${entry.severity})`).join(', ')}`,
      );
    }
    return `0 critical; ${entries.length} advisories, all in code the product never runs (${entries
      .map((entry) => `${entry.name} ${entry.severity}`)
      .join(', ')}) - classified Production Readiness`;
  });

  await step('build artifacts exist', async () => {
    await runOrThrow('npm', ['run', 'build']);
    return 'web + api + worker built';
  });

  // --- upgrade rehearsal --------------------------------------------------------

  let before;
  await step(
    `the previous release (${PREVIOUS_RELEASE}) creates its own schema and fixture`,
    async () => {
      if (!existsSync(path.join(UPGRADE_DIR, 'package.json'))) {
        await runOrThrow('git', ['worktree', 'add', '--detach', UPGRADE_DIR, PREVIOUS_RELEASE]);
      }
      if (!existsSync(path.join(UPGRADE_DIR, 'node_modules'))) {
        await runOrThrow('npm', ['ci', '--no-audit', '--no-fund'], { cwd: UPGRADE_DIR });
      }
      copyFileSync(path.join(ROOT, '.env'), path.join(UPGRADE_DIR, '.env'));
      await runOrThrow('npm', ['run', 'db:reset'], { cwd: UPGRADE_DIR });
      await runOrThrow('npm', ['run', 'db:migrate'], { cwd: UPGRADE_DIR });
      await runOrThrow('npm', ['run', 'seed:demo', '--', '--password', PASSWORD, '--json'], {
        cwd: UPGRADE_DIR,
      });
      before = await tableCounts();
      const migrations = before.__drizzle_migrations;
      return `${migrations} migrations and the canonical fixture written by the old code: ${Object.keys(before).length - 1} tables, ${Object.values(before).reduce((sum, n) => sum + n, 0)} rows`;
    },
  );

  await step('this release upgrades that database and keeps every row', async () => {
    await runOrThrow('npm', ['run', 'db:migrate']);
    const after = await tableCounts();
    const changed = Object.keys(before).filter(
      (table) => table !== '__drizzle_migrations' && after[table] !== before[table],
    );
    if (changed.length > 0) throw new Error(`Row counts changed in ${changed.join(', ')}.`);
    const added = Object.keys(after).filter((table) => !(table in before));
    await runOrThrow('npm', ['run', 'db:migrate']);
    const again = await tableCounts();
    if (again.__drizzle_migrations !== after.__drizzle_migrations)
      throw new Error('A second migrate changed the migration history.');
    return `${after.__drizzle_migrations - before.__drizzle_migrations} new migration(s) applied once (now ${after.__drizzle_migrations}); every one of ${Object.keys(before).length - 1} existing tables kept its row count; new: ${added.join(', ') || 'none'}; a second migrate is a no-op`;
  });

  await step(
    'api, worker and web start on the upgraded database, mail to the gate’s SMTP sink',
    async () => {
      await startStack();
      const ready = await fetchJson(`${API_URL}/readyz`);
      if (ready.body.status !== 'ready') throw new Error('API readiness reported not_ready.');
      return `all three processes live, web on ${WEB_PORT}, SMTP sink on ${SMTP_PORT}, logs in .local/gate-f10`;
    },
  );

  await step(
    'the old release’s people, dashboards and catalog work under the new code',
    async () => {
      for (const [role, email] of Object.entries(ACCOUNTS)) ctx.tokens[role] = await signIn(email);
      for (const token of Object.values(ctx.tokens))
        ctx.secrets.set(`session ${token.slice(0, 6)}`, token);
      const system = await getJson(`${API_URL}/admin/platform/system`, ctx.tokens.platform);
      const library = (await getJson(`${API_URL}/dashboards`, ctx.tokens.viewer)).body.dashboards;
      const states = [];
      for (const dashboard of library) {
        const layout = await getJson(
          `${API_URL}/dashboards/${dashboard.id}/layout`,
          ctx.tokens.viewer,
        );
        for (const widget of layout.body.widgets) {
          const tile = await getJson(
            `${API_URL}/dashboards/${dashboard.id}/widgets/${widget.widgetId}`,
            ctx.tokens.viewer,
          );
          states.push(tile.body.state);
        }
      }
      if (states.length === 0 || states.some((state) => state === undefined))
        throw new Error('A widget did not answer.');
      ctx.dashboards = library;
      return `${Object.keys(ACCOUNTS).length} accounts of the old release signed in with their passwords; schema ${system.body.release.schemaVersion} with ${system.body.release.appliedMigrations} migrations; ${library.length} dashboards, ${states.length} widgets answered (${countBy(states)})`;
    },
  );

  // --- account mail -----------------------------------------------------------------

  await step('an invitation arrives by mail and its link works once', async () => {
    const tenantId = (await getJson(`${API_URL}/admin/context`, ctx.tokens.tenantAdmin)).body
      .tenants[0].id;
    ctx.tenantId = tenantId;
    const invited = await postJson(
      `${API_URL}/admin/tenants/${tenantId}/users`,
      { email: 'gate.f10@example.invalid', firstName: 'Greta', lastName: 'Gate' },
      ctx.tokens.tenantAdmin,
    );
    if (invited.status !== 201) throw new Error(`Invite answered ${invited.status}.`);
    const mail = await waitForMail((message) => message.to.includes('gate.f10@example.invalid'));
    const token = linkToken(mail, '/invite');
    ctx.secrets.set('invitation token', token);
    const accepted = await postJson(`${API_URL}/invitations/accept`, { token, password: PASSWORD });
    const again = await postJson(`${API_URL}/invitations/accept`, { token, password: PASSWORD });
    if (accepted.status !== 200 || again.status === 200)
      throw new Error(`Accept ${accepted.status}, again ${again.status}.`);
    await signIn('gate.f10@example.invalid');
    return `"${mail.subject}" to the invited person; the link set the password and then stopped working (${again.status})`;
  });

  await step(
    'password recovery: same answer for everyone, one mail for the real account',
    async () => {
      const mailsBefore = sink.messages.length;
      const answers = [];
      for (const email of ['niemand@example.invalid', 'gate.f10@example.invalid']) {
        const response = await postJson(`${API_URL}/auth/password-reset`, { email });
        answers.push(`${response.status} ${response.text}`);
      }
      if (new Set(answers).size !== 1) throw new Error(`Answers differ: ${answers.join(' / ')}`);
      const mail = await waitForMail(
        (message) =>
          message.to.includes('gate.f10@example.invalid') && /Passwort/.test(message.subject),
      );
      await delay(1500);
      const sent = sink.messages.slice(mailsBefore).map((message) => message.to.join(','));
      if (sent.length !== 1) throw new Error(`${sent.length} mails: ${sent.join(' ')}`);
      const token = linkToken(mail, '/reset-password');
      ctx.secrets.set('reset token', token);
      const session = await signIn('gate.f10@example.invalid');
      const reset = await postJson(`${API_URL}/auth/password-reset/complete`, {
        token,
        newPassword: NEW_PASSWORD,
      });
      if (reset.status !== 200) throw new Error(`Reset answered ${reset.status}.`);
      const oldSession = await getJson(`${API_URL}/auth/me`, session);
      const oldPassword = await postJson(`${API_URL}/auth/login`, {
        email: 'gate.f10@example.invalid',
        password: PASSWORD,
      });
      const newPassword = await postJson(`${API_URL}/auth/login`, {
        email: 'gate.f10@example.invalid',
        password: NEW_PASSWORD,
      });
      if (oldSession.status !== 401 || oldPassword.status !== 401 || newPassword.status !== 200)
        throw new Error(
          `session ${oldSession.status}, old ${oldPassword.status}, new ${newPassword.status}`,
        );
      ctx.gateSession = newPassword.body.token;
      return `identical answer (${answers[0].split(' ')[0]}) for an unknown and a real address, one mail ("${mail.subject}"); the new password works, the old one and every old session do not`;
    },
  );

  await step(
    'a changed address is verified by the new mailbox and announced to the old one',
    async () => {
      const mailsBefore = sink.messages.length;
      const requested = await postJson(
        `${API_URL}/me/email`,
        { newEmail: 'greta.neu@example.invalid', currentPassword: NEW_PASSWORD },
        ctx.gateSession,
      );
      if (requested.status !== 200) throw new Error(`Request answered ${requested.status}.`);
      const verification = await waitForMail((message) =>
        message.to.includes('greta.neu@example.invalid'),
      );
      await waitForMail(
        (message) =>
          message.to.includes('gate.f10@example.invalid') &&
          sink.messages.indexOf(message) >= mailsBefore,
      );
      const notice = sink.messages
        .slice(mailsBefore)
        .find((message) => message.to.includes('gate.f10@example.invalid'));
      if (bodyOf(notice).includes('token=')) throw new Error('The notice carries the link.');
      const token = linkToken(verification, '/profile/email/confirm');
      ctx.secrets.set('confirmation token', token);
      const before = await postJson(`${API_URL}/auth/login`, {
        email: 'greta.neu@example.invalid',
        password: NEW_PASSWORD,
      });
      const confirmed = await postJson(`${API_URL}/auth/email-change/confirm`, { token });
      const after = await postJson(`${API_URL}/auth/login`, {
        email: 'greta.neu@example.invalid',
        password: NEW_PASSWORD,
      });
      const old = await postJson(`${API_URL}/auth/login`, {
        email: 'gate.f10@example.invalid',
        password: NEW_PASSWORD,
      });
      if (
        before.status !== 401 ||
        confirmed.status !== 200 ||
        after.status !== 200 ||
        old.status !== 401
      )
        throw new Error(
          `before ${before.status}, confirm ${confirmed.status}, after ${after.status}, old ${old.status}`,
        );
      return `current password required; "${verification.subject}" to the new address, "${notice.subject}" (without link) to the old; sign-in moves to the new address only once it is confirmed`;
    },
  );

  await step('rate limits count each visitor, not the web server in front of them', async () => {
    const attempt = (address, password) =>
      fetchJson(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-axp-client-address': address },
        body: JSON.stringify({ email: 'niemand@example.invalid', password }),
      });
    const statuses = [];
    for (let index = 0; index < 21; index += 1)
      statuses.push((await attempt('203.0.113.50', 'falsch-falsch-falsch')).status);
    const other = await fetchJson(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-axp-client-address': '198.51.100.20' },
      body: JSON.stringify({ email: ACCOUNTS.viewer, password: PASSWORD }),
    });
    if (statuses[20] !== 429 || other.status !== 200)
      throw new Error(`visitor A last ${statuses[20]}, visitor B ${other.status}`);
    ctx.secrets.set('visitor B session', other.body.token);
    return `visitor A is stopped after 20 attempts (429) while visitor B behind the same web server signs in (200); the guessed account is locked, the web server's address is not; signed-in requests count per session`;
  });

  // --- performance --------------------------------------------------------------------

  await step('cold and warm timings of real dashboards are measured', async () => {
    const presets = ['last_7_days', 'last_14_days', 'last_30_days', 'previous_month'];
    const cold = [];
    const warm = [];
    const layouts = [];
    for (const dashboard of ctx.dashboards) {
      for (const preset of presets) {
        const view = `timeRange=${preset}&comparison=previous_period&breakpoint=desktop`;
        const started = Date.now();
        const layout = await getJson(
          `${API_URL}/dashboards/${dashboard.id}/layout?${view}`,
          ctx.tokens.viewer,
        );
        layouts.push(Date.now() - started);
        const all = async () => {
          const begin = Date.now();
          await Promise.all(
            layout.body.widgets.map((widget) =>
              getJson(
                `${API_URL}/dashboards/${dashboard.id}/widgets/${widget.widgetId}?${view}`,
                ctx.tokens.viewer,
              ),
            ),
          );
          return Date.now() - begin;
        };
        cold.push(await all());
        warm.push(await all());
      }
    }
    const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
    ctx.performance = { layouts, cold, warm };
    if (median(warm) > median(cold)) throw new Error('Warm is slower than cold.');
    if (p95(cold) > 5_000) throw new Error(`Cold p95 ${p95(cold)} ms.`);
    return `${ctx.dashboards.length} dashboards × ${presets.length} periods with the mock adapter: layout median ${median(layouts)} ms; all widgets cold median ${median(cold)} ms (p95 ${p95(cold)} ms), warm median ${median(warm)} ms (p95 ${p95(warm)} ms) - product overhead only; real-Matomo timings belong to the Performance Gate`;
  });

  // --- logs ---------------------------------------------------------------------------

  await step('the running stack logged no secret, token, password or person', async () => {
    await delay(1500);
    const logs = ['api', 'worker', 'web']
      .map((name) => readFileSync(path.join(LOG_DIR, `${name}.log`), 'utf8'))
      .join('\n');
    const secrets = new Map([
      ...ctx.secrets,
      ['the demo password', PASSWORD],
      ['the new password', NEW_PASSWORD],
      ['the Matomo token', DEMO_MATOMO_TOKEN],
      ['the session secret', env.SESSION_SECRET],
      ['the credential key', env.CREDENTIAL_ENCRYPTION_KEY],
      ['the database password', env.MYSQL_PASSWORD],
    ]);
    const leaked = [...secrets]
      .filter(([, value]) => value && logs.includes(value))
      .map(([name]) => name);
    const people = logs.match(/[\w.+-]+@example\.invalid/g) ?? [];
    if (leaked.length > 0 || people.length > 0)
      throw new Error(`Leaked: ${[...leaked, ...new Set(people)].join(', ')}`);
    const lines = logs.split('\n').filter((line) => line.startsWith('{')).length;
    return `${lines} structured log lines from api, worker and web: none of ${secrets.size} secrets (passwords, sessions, invitation/reset/confirmation tokens, Matomo token, keys), no e-mail address; requests are logged as method, path without query, status, correlation id`;
  });

  // --- backup and restore -------------------------------------------------------------

  await step('backup and restore: the product state comes back identical and usable', async () => {
    const fingerprintBefore = await fingerprint();
    const sampleBefore = await sampleValues();
    // A path without spaces: the mysql client's `source` reads it verbatim.
    const dump = path.join(tmpdir(), 'axp-gate-f10-backup.sql');
    await runOrThrow(
      mysqlBinary('mysqldump'),
      [
        ...mysqlArgs(),
        '--single-transaction',
        '--routines',
        '--triggers',
        '--no-tablespaces',
        '--set-gtid-purged=OFF',
        '--default-character-set=utf8mb4',
        `--result-file=${dump}`,
        DATABASE,
      ],
      { env: mysqlEnv(), shell: false },
    );
    await shutdownProcesses();
    await query(`DROP DATABASE \`${DATABASE}\``);
    await query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await pool.end();
    pool = undefined;
    const lost = await tableCounts();
    await runOrThrow(
      mysqlBinary('mysql'),
      [...mysqlArgs(), DATABASE, '-e', `source ${dump.replace(/\\/g, '/')}`],
      { env: mysqlEnv(), shell: false },
    );
    await runOrThrow('npm', ['run', 'db:migrate']);
    await startStack();
    const fingerprintAfter = await fingerprint();
    const differing = Object.keys(fingerprintBefore).filter(
      (table) => fingerprintBefore[table] !== fingerprintAfter[table],
    );
    if (differing.length > 0) throw new Error(`Tables differ: ${differing.join(', ')}`);
    const sampleAfter = await sampleValues();
    if (JSON.stringify(sampleAfter) !== JSON.stringify(sampleBefore))
      throw new Error('Values differ after restore.');
    await signIn(ACCOUNTS.editor);
    const audit = await query('SELECT COUNT(*) AS n FROM audit_events');
    return `dump of ${Object.keys(fingerprintBefore).length} tables (${Math.round(readFileSync(dump).length / 1024)} KB); database dropped (${Object.keys(lost).length} tables left); restored: every table's row count and checksum identical, people sign in, the dashboard shows the same values through the restored encrypted Matomo credential, ${audit[0].n} audit entries intact`;
  });

  if (!SKIP_E2E) {
    await step(
      'the browser journey passes in Chromium, desktop WebKit and mobile Safari, with the accessibility audit',
      async () => {
        await delay(60_000);
        const { stdout } = await runOrThrow('npx', ['playwright', 'test'], { env: E2E_ENV() });
        const passed = /(\d+)\s+passed/.exec(stdout)?.[1] ?? '?';
        const byProject = {};
        for (const line of stdout.split(/\r?\n/)) {
          const match = /\bok\b.*\[([a-z-]+)\]/.exec(line);
          if (match) byProject[match[1]] = (byProject[match[1]] ?? 0) + 1;
        }
        const audit = stdout
          .split(/\r?\n/)
          .filter((line) => /\bok\b.*accessibility\.spec/.test(line)).length;
        return `${passed} browser checks (${Object.entries(byProject)
          .map(([project, n]) => `${project} ${n}`)
          .join(', ')}), ${audit} of them WCAG 2.1 AA scans and the reduced-motion check`;
      },
    );
  }

  await step('every acceptance checklist item has evidence or a class', async () => {
    const matrix = readFileSync(path.join(ROOT, 'docs', 'acceptance', 'mvp-acceptance.md'), 'utf8');
    const rows = matrix
      .split(/\r?\n/)
      .filter((line) => /^\|\s*[A-I]\d+\s*\|/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()));
    const statuses = rows.map((cells) => cells[3]);
    const failing = rows.filter(
      (cells) => !['Pass', 'Mocked', 'N/A', 'Partial'].includes(cells[3]),
    );
    if (rows.length < 100) throw new Error(`Only ${rows.length} checklist rows.`);
    if (failing.length > 0)
      throw new Error(`Not accepted: ${failing.map((cells) => cells[1]).join(', ')}`);
    const partial = rows.filter(
      (cells) =>
        ['Partial', 'Mocked'].includes(cells[3]) &&
        !/MVP\+|Performance Gate|Production Readiness|On Hold/.test(cells[5] ?? ''),
    );
    if (partial.length > 0)
      throw new Error(`Partial without a class: ${partial.map((cells) => cells[1]).join(', ')}`);
    return `${rows.length} checklist items: ${countBy(statuses)}; every Partial and Mocked item names its class`;
  });

  report();
}

// --- product state ------------------------------------------------------------------

async function tableNames() {
  return (
    await query(
      "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    )
  ).map((row) => row.t);
}

async function tableCounts() {
  const counts = {};
  for (const table of await tableNames()) {
    counts[table] = Number((await query(`SELECT COUNT(*) AS n FROM \`${table}\``))[0].n);
  }
  return counts;
}

/** Row count and content checksum of every table. */
async function fingerprint() {
  const result = {};
  for (const table of await tableNames()) {
    const [row] = await query(`CHECKSUM TABLE \`${table}\``);
    const count = Number((await query(`SELECT COUNT(*) AS n FROM \`${table}\``))[0].n);
    result[table] = `${count}:${row.Checksum}`;
  }
  return result;
}

/** What a viewer sees on the first dashboard, as numbers. */
async function sampleValues() {
  const dashboard = ctx.dashboards[0];
  const view = 'timeRange=last_30_days&comparison=previous_period&breakpoint=desktop';
  const layout = await getJson(
    `${API_URL}/dashboards/${dashboard.id}/layout?${view}`,
    ctx.tokens.viewer,
  );
  if (layout.status !== 200) throw new Error(`Layout answered ${layout.status}.`);
  const values = [];
  for (const widget of layout.body.widgets) {
    const tile = await getJson(
      `${API_URL}/dashboards/${dashboard.id}/widgets/${widget.widgetId}?${view}`,
      ctx.tokens.viewer,
    );
    values.push([widget.widgetId, tile.body.state, JSON.stringify(tile.body.content ?? null)]);
  }
  return values;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.entries(counts)
    .map(([value, n]) => `${n}× ${value}`)
    .join(', ');
}

// --- mysql tools ----------------------------------------------------------------------

function mysqlBinary(name) {
  if (!LOCAL_MYSQL) throw new Error('The backup rehearsal runs with --local-mysql.');
  const dist = path.join(ROOT, '.local', 'mysql', 'dist');
  const version = readdirSync(dist).find((entry) => entry.startsWith('mysql-'));
  return path.join(dist, version, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
}

function mysqlArgs() {
  const url = new URL(env.DATABASE_URL);
  return [
    `--host=${url.hostname === 'localhost' ? '127.0.0.1' : url.hostname}`,
    `--port=${url.port || '3306'}`,
    `--user=${decodeURIComponent(url.username)}`,
  ];
}

function mysqlEnv() {
  return { ...process.env, MYSQL_PWD: decodeURIComponent(new URL(env.DATABASE_URL).password) };
}

// --- mail -----------------------------------------------------------------------------

async function waitForMail(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = sink.messages.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('The expected mail did not arrive.');
    await delay(500);
  }
}

/** The text body, decoded from its transfer encoding. */
function bodyOf(message) {
  const [headers, ...rest] = message.raw.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return Buffer.from(
      body
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
      'latin1',
    ).toString('utf8');
  }
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  return body;
}

function linkToken(message, pathname) {
  const match = /(https?:\/\/\S+)/.exec(bodyOf(message));
  if (!match) throw new Error(`No link in "${message.subject}".`);
  const url = new URL(match[1]);
  if (url.pathname !== pathname) throw new Error(`The link points to ${url.pathname}.`);
  return url.searchParams.get('token');
}

// --- SMTP sink (as in Gate F8) ------------------------------------------------------------

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
  return (
    subject
      // RFC 2047: whitespace between adjacent encoded words is not part of the text.
      .replace(/(\?=)\s+(=\?)/g, '$1$2')
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
      .replace(/\?=\s+=\?/g, '')
  );
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
    // Structured records, as in production, for the log review.
    LOG_FORMAT: 'json',
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

/** Stops api, worker and web; the database pool and the SMTP sink stay. */
async function shutdownProcesses() {
  const running = children.splice(0, children.length);
  for (const { child } of running) await stopProcess(child);
  await delay(1500);
}

async function shutdownStack() {
  await shutdownProcesses();
  await pool?.end().catch(() => {});
  pool = undefined;
  await sink.close?.();
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
  console.log(`Gate F10: ${passed}/${results.length} criteria demonstrated.`);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      // Without a shell for programs given by path: a space in the path would split it.
      shell: options.shell ?? process.platform === 'win32',
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

/** Starts a process whose output goes to .local/gate-f10/<name>.log, for the log review. */
function startProcess(name, command, args, options = {}) {
  const log = createWriteStream(path.join(LOG_DIR, `${name}.log`), { flags: 'a' });
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
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
    console.error(`\nGate F10 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
