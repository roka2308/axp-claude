#!/usr/bin/env node
/**
 * Gate F9 demonstration.
 *
 * Runs against a real stack and the canonical fixture, from an empty database:
 *
 *   - invalid contrast cannot silently publish
 *   - no arbitrary customer CSS/JS
 *   - entitlement loss does not delete configuration
 *   - the diagnostics bundle contains no secrets or analytics payloads
 *
 * and shows the build list working: Platform -> Tenant -> Project inheritance,
 * Draft/Validate/Publish/Rollback, the Telekom Default and neutral customer
 * fixtures, release and schema metadata, and the automatic deletion of an
 * expired diagnostic bundle.
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f9.mjs [--skip-e2e] [--local-mysql] [--quick]
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_E2E = process.argv.includes('--skip-e2e');
const LOCAL_MYSQL = process.argv.includes('--local-mysql');
// Debugging aid only: skips the suites and the build. A gate run never uses it.
const QUICK = process.argv.includes('--quick');

const env = readEnvFile(path.join(ROOT, '.env'));
const API_URL = env.API_PUBLIC_URL ?? 'http://localhost:4000';
const WEB_PORT = process.env.WEB_PORT ?? env.WEB_PORT ?? '3000';
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKER_HEALTH_URL = `http://127.0.0.1:${Number(env.API_PORT ?? 4000) + 1}`;
const EXPORT_DIR = path.join(ROOT, '.local', 'exports');

const ADMIN_EMAIL = 'gate.f9@example.invalid';
const PASSWORD = 'korrekt-pferd-batterie-heftklammer';
const VIEWER_EMAIL = 'viewer.demo@example.invalid';
const DEMO_MATOMO_TOKEN = 'demo-token-not-a-real-credential';
const ACCOUNTS = {
  viewer: VIEWER_EMAIL,
  editor: 'editor.demo@example.invalid',
  semantic: 'semantic.demo@example.invalid',
  tenantAdmin: 'tenantadmin.demo@example.invalid',
};
const TENANT_ACCENT = '#0f6e6e';
const PLATFORM_ACCENT = '#e20074';

const results = [];
const children = [];
const ctx = { tokens: {}, users: {} };

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

  if (!QUICK)
    await step('unit suite passes', async () => {
      const { stdout } = await runOrThrow('npm', ['run', 'test']);
      return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests`;
    });

  if (!QUICK)
    await step('integration suite passes', async () => {
      const { stdout } = await runOrThrow('npm', ['run', 'test:integration']);
      return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} tests`;
    });

  if (!QUICK)
    await step('the theme, entitlement and diagnostics suite passes', async () => {
      const { stdout } = await runOrThrow('npx', [
        'vitest',
        'run',
        '--project',
        'integration',
        'tests/integration/productization.test.ts',
      ]);
      return `${/Tests\s+(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} theme, entitlement and diagnostics tests`;
    });

  await step('database reset for the fixture', async () => {
    await runOrThrow('npm', ['run', 'db:reset']);
    await runOrThrow('npm', ['run', 'db:migrate']);
    return 'empty schema';
  });

  if (!QUICK)
    await step('build artifacts exist', async () => {
      await runOrThrow('npm', ['run', 'build']);
      return 'web + api + worker built';
    });

  await step('api, worker and web start', async () => {
    await startStack();
    const ready = await fetchJson(`${API_URL}/readyz`);
    if (ready.body.status !== 'ready') throw new Error('API readiness reported not_ready.');
    return `all three processes live, web on ${WEB_PORT}`;
  });

  await step('platform bootstrapped and fixture seeded', async () => {
    await seedFixture();
    const library = await getJson(`${API_URL}/dashboards`, ctx.tokens.viewer);
    const executive = library.body.dashboards.find(
      (entry) => entry.name === 'Executive Health Overview',
    );
    ctx.dashboardId = executive.id;
    ctx.projectId = executive.projectId;
    return `${Object.keys(ctx.tokens).length} accounts signed in`;
  });

  await step('release, schema and compatibility metadata are visible to operators', async () => {
    const system = await getJson(`${API_URL}/admin/platform/system`, ctx.tokens.platform);
    if (system.status !== 200) throw new Error(`System answered ${system.status}.`);
    const { release, compatibility } = system.body;
    const migrations = (await query('SELECT COUNT(*) AS n FROM __drizzle_migrations'))[0].n;
    if (release.appliedMigrations !== Number(migrations))
      throw new Error(`${release.appliedMigrations} migrations shown, ${migrations} applied.`);
    const tenantAdmin = await getJson(`${API_URL}/admin/platform/system`, ctx.tokens.tenantAdmin);
    if (tenantAdmin.status !== 403)
      throw new Error(`A tenant admin got ${tenantAdmin.status} for the system page.`);
    return `product ${release.productVersion}, schema ${release.schemaVersion}, ${release.appliedMigrations} migrations, support "${release.supportStatus}", profile ${release.deploymentProfile}; ${compatibility.matomoConnections.length} Matomo connection(s) rated (${compatibility.matomoConnections.map((entry) => entry.compatibility).join(', ')}), solution package schema ${compatibility.solutionPackageSchemas.join(', ')}; a tenant admin is refused (403)`;
  });

  await step('the fixture themes inherit Platform -> Tenant -> Project', async () => {
    const platform = await getJson(`${API_URL}/themes/platform`, ctx.tokens.platform);
    const tenant = await getJson(
      `${API_URL}/themes/tenants/${ctx.tenantId}`,
      ctx.tokens.tenantAdmin,
    );
    if (platform.body.published?.version !== 1 || tenant.body.published?.version !== 1)
      throw new Error('The fixture themes are not published.');
    const before = await effectiveCss(ctx.tokens.viewer);
    if (!before.includes(`--accent-default:${TENANT_ACCENT}`))
      throw new Error('The tenant accent does not reach its people.');
    if (before.includes(`--accent-default:${PLATFORM_ACCENT}`))
      throw new Error('The platform accent overrides the tenant accent.');
    const anonymous = (await getJson(`${API_URL}/theme/platform`)).body.css;
    if (!anonymous.includes(`--accent-default:${PLATFORM_ACCENT}`))
      throw new Error('The sign-in page does not get the platform theme.');

    // A project theme on top: one token, everything else inherited.
    const projectPath = `${API_URL}/themes/projects/${ctx.projectId}`;
    const saved = await putJson(
      `${projectPath}/draft`,
      { name: 'Gate F9 Projekt', tokens: { '--chart-series-1': '#7a3e9d' } },
      ctx.tokens.tenantAdmin,
    );
    if (saved.status !== 200) throw new Error(`Project draft answered ${saved.status}.`);
    const published = await postJson(`${projectPath}/publish`, {}, ctx.tokens.tenantAdmin);
    if (published.status !== 200) throw new Error(`Project publish answered ${published.status}.`);
    const onProject = await effectiveCss(ctx.tokens.viewer, `projectId=${ctx.projectId}`);
    if (
      !onProject.includes('--chart-series-1:#7a3e9d') ||
      !onProject.includes(`--accent-default:${TENANT_ACCENT}`)
    )
      throw new Error('The project page does not combine project and tenant tokens.');
    const offProject = await effectiveCss(ctx.tokens.viewer);
    if (offProject.includes('#7a3e9d'))
      throw new Error('The project theme leaks outside the project.');

    // Rollback: version 1 again as a new version, the history kept.
    await putJson(
      `${projectPath}/draft`,
      { name: 'Gate F9 Projekt', tokens: { '--chart-series-1': '#1f6f3a' } },
      ctx.tokens.tenantAdmin,
    );
    await postJson(`${projectPath}/publish`, {}, ctx.tokens.tenantAdmin);
    const rolled = await postJson(
      `${projectPath}/rollback`,
      { version: 1 },
      ctx.tokens.tenantAdmin,
    );
    if (rolled.status !== 200) throw new Error(`Rollback answered ${rolled.status}.`);
    const history = (await getJson(projectPath, ctx.tokens.tenantAdmin)).body;
    const current = history.versions.find((entry) => entry.isCurrent);
    if (current.version !== 3 || current.rolledBackFromVersion !== 1)
      throw new Error(
        `After rollback: version ${current.version} from ${current.rolledBackFromVersion}.`,
      );
    if (!(await effectiveCss(ctx.tokens.viewer, `projectId=${ctx.projectId}`)).includes('#7a3e9d'))
      throw new Error('The rollback did not take effect.');
    return `platform "${platform.body.name}" v1 (${PLATFORM_ACCENT}) for the sign-in page; tenant "${tenant.body.name}" v1 (${TENANT_ACCENT}) for its people; a project theme adds one chart colour on its own pages only; published v2, rolled back to v1 as v3 (history: ${history.versions.map((entry) => entry.version).join(', ')})`;
  });

  // --- Gate F9 criteria ----------------------------------------------------

  await step('invalid contrast cannot silently publish', async () => {
    const tenantPath = `${API_URL}/themes/tenants/${ctx.tenantId}`;
    const versionsBefore = await count('theme_versions');
    const auditBefore = await count('audit_events', "action = 'theme.published'");

    // 1. The theme itself fails: white button labels on yellow.
    await putJson(
      `${tenantPath}/draft`,
      { name: 'Neutral Kunde', tokens: { '--accent-default': '#ffff00' } },
      ctx.tokens.tenantAdmin,
    );
    const validation = (await postJson(`${tenantPath}/validate`, {}, ctx.tokens.tenantAdmin)).body;
    const failing = validation.contrast.filter((check) => !check.pass);
    if (validation.publishable || failing.length === 0)
      throw new Error('A yellow accent under white labels validated.');
    const refused = await postJson(`${tenantPath}/publish`, {}, ctx.tokens.tenantAdmin);
    if (refused.status !== 422 || refused.body.error.messageKey !== 'theme.contrast_failed')
      throw new Error(`Publishing answered ${refused.status} ${refused.body.error?.code}.`);
    const still = (await getJson(tenantPath, ctx.tokens.tenantAdmin)).body;
    if (still.published.version !== 1 || !still.draft)
      throw new Error('The refusal changed the published version or dropped the draft.');
    if ((await effectiveCss(ctx.tokens.viewer)).includes('#ffff00'))
      throw new Error('The failing accent reached the page.');
    await deleteJson(`${tenantPath}/draft`, ctx.tokens.tenantAdmin);

    // 2. The platform theme passes on its own but would break the tenant's.
    const platformDraft = {
      name: 'Telekom Default',
      tokens: {
        '--accent-default': PLATFORM_ACCENT,
        '--accent-contrast': '#ffffff',
        '--surface-page': '#0b5a5a',
        '--surface-card': '#0b5a5a',
        '--text-primary': '#ffffff',
        '--text-secondary': '#f0f0f0',
        '--text-muted': '#e0e0e0',
        '--text-link': '#ffd6ec',
        '--focus-ring-color': '#ffffff',
        '--border-default': '#c0c0c0',
      },
    };
    await putJson(`${API_URL}/themes/platform/draft`, platformDraft, ctx.tokens.platform);
    const platformCheck = (
      await postJson(`${API_URL}/themes/platform/validate`, {}, ctx.tokens.platform)
    ).body;
    const ownFailing = platformCheck.contrast.filter((check) => !check.pass).length;
    const platformRefused = await postJson(
      `${API_URL}/themes/platform/publish`,
      {},
      ctx.tokens.platform,
    );
    await deleteJson(`${API_URL}/themes/platform/draft`, ctx.tokens.platform);
    if (ownFailing !== 0) throw new Error(`The platform draft fails ${ownFailing} own checks.`);
    if (platformCheck.publishable || platformCheck.dependents.length === 0)
      throw new Error('The dependent tenant theme was not considered.');
    if (
      platformRefused.status !== 422 ||
      platformRefused.body.error.messageKey !== 'theme.dependents_fail'
    )
      throw new Error(`Platform publish answered ${platformRefused.status}.`);

    if ((await count('theme_versions')) !== versionsBefore)
      throw new Error('A refused publish created a version.');
    if ((await count('audit_events', "action = 'theme.published'")) !== auditBefore)
      throw new Error('A refused publish was audited as published.');
    const dependents = platformCheck.dependents
      .map((entry) => `${entry.scope} "${entry.name}" (${entry.failing} failing)`)
      .join(', ');
    return `tenant draft with a yellow accent: ${failing.length} check(s) fail (${failing.map((check) => `${check.reason} ${check.ratio?.toFixed(2)}:1 < ${check.minimumRatio}:1`).join('; ')}), publish refused 422 "${refused.body.error.messageKey}", the draft kept, v1 still served; a platform draft passing all its own ${platformCheck.contrast.length} checks is refused because it breaks ${dependents}; no version and no "published" audit entry came of either`;
  });

  await step('no arbitrary customer CSS/JS', async () => {
    const tenantPath = `${API_URL}/themes/tenants/${ctx.tenantId}/draft`;
    const attempts = {
      'closing the style element': {
        '--accent-default': '#fff;}</style><script>alert(1)</script>',
      },
      'a second declaration': {
        '--accent-default': '#fff; background: url(https://evil.example/x)',
      },
      'an external url': { '--surface-card': 'url(https://evil.example/x.png)' },
      'a legacy expression': { '--surface-card': 'expression(alert(1))' },
      'an import': { '--font-family-base': '@import "https://evil.example/x.css"' },
      'a CSS property instead of a token': { 'background-image': '#ffffff' },
      'an unknown custom property': { '--my-own-hack': '#ffffff' },
      'an escaped character': { '--accent-default': '\\3c script' },
    };
    const outcomes = [];
    for (const [label, tokens] of Object.entries(attempts)) {
      const response = await putJson(
        tenantPath,
        { name: 'Versuch', tokens },
        ctx.tokens.tenantAdmin,
      );
      if (response.status !== 422) throw new Error(`${label}: answered ${response.status}.`);
      outcomes.push(response.body.error.code);
    }
    const extraField = await putJson(
      tenantPath,
      { name: 'Versuch', tokens: {}, css: 'body{display:none}', script: 'alert(1)' },
      ctx.tokens.tenantAdmin,
    );
    if (extraField.status !== 422) throw new Error(`Free CSS/script fields: ${extraField.status}.`);
    const overview = (
      await getJson(`${API_URL}/themes/tenants/${ctx.tenantId}`, ctx.tokens.tenantAdmin)
    ).body;
    if (overview.draft) throw new Error('A refused draft was stored.');

    // What is stored is token values only, and what is served is declarations only.
    const columns = (
      await query(
        "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('themes','theme_versions')",
      )
    ).map((row) => `${row.t}.${row.c}`);
    if (columns.some((column) => /css|script|html|style/i.test(column)))
      throw new Error(
        `Stored column ${columns.find((column) => /css|script|html|style/i.test(column))}.`,
      );
    const stored = await query('SELECT tokens, dark_tokens FROM theme_versions');
    const values = stored.flatMap((row) =>
      [row.tokens, row.dark_tokens].flatMap((value) =>
        Object.values(typeof value === 'string' ? JSON.parse(value) : (value ?? {})),
      ),
    );
    if (values.some((value) => /[;{}<>\\@]|url\(|expression/i.test(value)))
      throw new Error('A stored token value carries CSS syntax.');
    const css = await effectiveCss(ctx.tokens.viewer, `projectId=${ctx.projectId}`);
    const stripped = css
      .replace(/@media \(prefers-color-scheme: (light|dark)\)\{/g, '')
      .replace(
        /:root(:where\(:not\(\[data-theme='(light|dark)'\]\)\)|\[data-theme='(light|dark)'\])\{/g,
        '',
      )
      .replace(/--[a-z0-9-]+:[^;{}<>]+;/g, '')
      .replace(/\}/g, '')
      .trim();
    if (stripped !== '')
      throw new Error(`The stylesheet holds more than declarations: ${stripped.slice(0, 80)}`);
    const html = await (
      await fetch(`${WEB_URL}/login`, { signal: AbortSignal.timeout(30_000) })
    ).text();
    const inline = [...html.matchAll(/<style data-axp-theme="">([\s\S]*?)<\/style>/g)].map(
      (m) => m[1],
    );
    if (inline.length === 0) throw new Error('No theme style element on the sign-in page.');
    if (inline.some((block) => block.includes('<')))
      throw new Error('The inline theme carries markup.');
    return `${Object.keys(attempts).length} injection attempts refused with 422 (${[...new Set(outcomes)].join(', ')}): ${Object.keys(attempts).join(', ')}; free "css"/"script" fields refused by the strict schema; nothing stored; the theme tables have no CSS column and ${values.length} stored values carry no CSS syntax; the served stylesheet is custom-property declarations in mode blocks and nothing else`;
  });

  await step('entitlement loss does not delete configuration', async () => {
    const share = await postJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      {
        label: 'Gate F9',
        expiresOn: (
          await getJson(`${API_URL}/dashboards/${ctx.dashboardId}/shares`, ctx.tokens.editor)
        ).body.expiry.suggested,
        rights: { timeRange: false, comparison: false, detail: false, export: false },
      },
      ctx.tokens.editor,
    );
    if (share.status !== 201) throw new Error(`Share answered ${share.status}.`);
    const schedule = await postJson(
      `${API_URL}/projects/${ctx.projectId}/reports`,
      scheduleBody({ name: 'Gate F9 Wochenbericht' }),
      ctx.tokens.editor,
    );
    if (schedule.status !== 201) throw new Error(`Schedule answered ${schedule.status}.`);
    const tables = [
      'dashboard_shares',
      'report_schedules',
      'themes',
      'theme_versions',
      'solution_installations',
    ];
    const snapshot = async () => {
      const counts = {};
      for (const table of tables) counts[table] = await count(table);
      return JSON.stringify(counts);
    };
    const before = await snapshot();
    const shareState = async () =>
      (
        await fetchJson(`${API_URL}/public/share`, {
          headers: { 'x-share-token': share.body.token },
        })
      ).body.state;

    for (const entitlement of [
      'reporting.scheduled',
      'sharing.external',
      'theming.custom',
      'solutions.packages',
    ])
      await setEntitlement(entitlement, false);

    const createReport = await postJson(
      `${API_URL}/projects/${ctx.projectId}/reports`,
      scheduleBody({ name: 'Gate F9 verweigert' }),
      ctx.tokens.editor,
    );
    const viewerReport = await postJson(
      `${API_URL}/projects/${ctx.projectId}/reports`,
      scheduleBody({ name: 'Gate F9 Viewer' }),
      ctx.tokens.viewer,
    );
    const listed = await getJson(
      `${API_URL}/dashboards/${ctx.dashboardId}/shares`,
      ctx.tokens.editor,
    );
    const during = {
      share: await shareState(),
      css: await effectiveCss(ctx.tokens.viewer),
      themeDraft: await putJson(
        `${API_URL}/themes/tenants/${ctx.tenantId}/draft`,
        { name: 'Neu', tokens: {} },
        ctx.tokens.tenantAdmin,
      ),
    };
    const duringCounts = await snapshot();

    for (const entitlement of [
      'reporting.scheduled',
      'sharing.external',
      'theming.custom',
      'solutions.packages',
    ])
      await setEntitlement(entitlement, true);
    const after = {
      share: await shareState(),
      css: await effectiveCss(ctx.tokens.viewer),
      reports: (await getJson(`${API_URL}/projects/${ctx.projectId}/reports`, ctx.tokens.editor))
        .body,
    };
    const audited = await count('audit_events', "action = 'entitlement.changed'");

    const problems = [];
    if (createReport.status !== 403 || createReport.body.error.category !== 'entitlement_required')
      problems.push(`report create ${createReport.status}/${createReport.body.error?.category}`);
    if (viewerReport.body.error?.category === 'entitlement_required')
      problems.push('a viewer was told about the contract instead of the missing permission');
    if (listed.status !== 200 || listed.body.entitled !== false || listed.body.shares.length === 0)
      problems.push('the share list hid the existing links');
    if (during.share !== 'unavailable') problems.push(`share during: ${during.share}`);
    if (during.css.includes(TENANT_ACCENT)) problems.push('the tenant theme still applied');
    if (during.themeDraft.status !== 403) problems.push(`theme draft ${during.themeDraft.status}`);
    if (duringCounts !== before) problems.push(`rows changed: ${before} -> ${duringCounts}`);
    if (after.share !== 'available' && after.share !== 'password_required')
      problems.push(`share after: ${after.share}`);
    if (!after.css.includes(`--accent-default:${TENANT_ACCENT}`)) problems.push('theme not back');
    const reportsAfter = after.reports.schedules;
    if (!JSON.stringify(reportsAfter).includes(schedule.body.id)) problems.push('schedule gone');
    if (audited < 8) problems.push(`${audited} entitlement audit entries`);
    if (problems.length > 0) throw new Error(problems.join('; '));
    return `with all four modules off: a new schedule is refused as "${createReport.body.error.category}" (${createReport.body.error.messageKey}) while a viewer still gets "${viewerReport.body.error?.category}"; the existing link answers "${during.share}" but is still listed; the tenant theme yields to the platform theme; row counts unchanged (${before}); switched back on, the same link, schedule and theme work again; ${audited} changes audited`;
  });

  await step('the diagnostics bundle contains no secrets or analytics payloads', async () => {
    // Generating a bundle needs a fresh sign-in.
    ctx.tokens.platform = await signIn(ADMIN_EMAIL);
    const denied = await postJson(
      `${API_URL}/admin/platform/diagnostics`,
      {},
      ctx.tokens.tenantAdmin,
    );
    if (denied.status !== 403) throw new Error(`A tenant admin got ${denied.status}.`);
    const created = await postJson(
      `${API_URL}/admin/platform/diagnostics`,
      {},
      ctx.tokens.platform,
    );
    if (created.status !== 201) throw new Error(`Generating answered ${created.status}.`);
    const bundleUrl = `${API_URL}/admin/platform/diagnostics/${created.body.id}`;
    const download = await fetch(bundleUrl, { headers: authHeaders(ctx.tokens.platform) });
    const text = await download.text();
    const bundle = JSON.parse(text);

    const secrets = {
      'the session secret': env.SESSION_SECRET,
      'the credential encryption key': env.CREDENTIAL_ENCRYPTION_KEY,
      'the database password': env.MYSQL_PASSWORD,
      'the database root password': env.MYSQL_ROOT_PASSWORD,
      'the database URL': env.DATABASE_URL,
      'the Matomo token': DEMO_MATOMO_TOKEN,
      'a user password': PASSWORD,
      'a session token': ctx.tokens.platform,
    };
    const leaked = Object.entries(secrets).filter(([, value]) => value && text.includes(value));
    if (leaked.length > 0)
      throw new Error(`The bundle contains ${leaked.map(([key]) => key).join(', ')}.`);
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text))
      throw new Error('The bundle contains an e-mail address.');
    if (/https?:\/\//.test(text)) throw new Error('The bundle contains a URL.');

    const keys = new Set();
    const walk = (value) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object')
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
    };
    walk(bundle);
    const analytic = [
      'rows',
      'series',
      'values',
      'value',
      'nb_visits',
      'nb_actions',
      'metrics',
      'result',
      'payload',
      'response',
    ];
    const found = analytic.filter((key) => keys.has(key));
    if (found.length > 0)
      throw new Error(`The bundle has analytics-shaped keys: ${found.join(', ')}.`);

    const otherReader = await fetch(bundleUrl, { headers: authHeaders(ctx.tokens.tenantAdmin) });
    if (otherReader.status !== 403) throw new Error(`Another reader got ${otherReader.status}.`);
    const row = (
      await query('SELECT storage_key FROM diagnostic_artifacts WHERE id = ?', [created.body.id])
    )[0];
    const onDisk = readFileSync(path.join(EXPORT_DIR, row.storage_key));
    if (onDisk.includes('axp-diagnostic-bundle'))
      throw new Error('The bundle is stored in clear text.');
    const audited = await count('audit_events', "action = 'diagnostics.bundle_generated'");
    if (audited !== 1) throw new Error(`${audited} audit entries.`);

    // Auto-cleanup: expire it, the worker deletes row and file within a minute.
    await query(
      'UPDATE diagnostic_artifacts SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?',
      [created.body.id],
    );
    const deadline = Date.now() + 120_000;
    for (;;) {
      const left = await query('SELECT id FROM diagnostic_artifacts WHERE id = ?', [
        created.body.id,
      ]);
      if (left.length === 0 && !existsSync(path.join(EXPORT_DIR, row.storage_key))) break;
      if (Date.now() > deadline) throw new Error('The expired bundle was not deleted.');
      await delay(3000);
    }
    const gone = await fetch(bundleUrl, { headers: authHeaders(ctx.tokens.platform) });
    if (gone.status !== 404) throw new Error(`After expiry: ${gone.status}.`);
    return `${Math.round(text.length / 1024)} KB, sections ${Object.keys(bundle).join(', ')}; none of ${Object.keys(secrets).length} known secrets, no e-mail address, no URL, no analytics-shaped key; creator-only (another reader 403), encrypted on disk, audited; expired, the worker deleted file and row and the link answers 404`;
  });

  if (!SKIP_E2E) {
    await step('the browser journey passes, themes and administration included', async () => {
      await delay(60_000);
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], { env: E2E_ENV() });
      const productization = stdout
        .split(/\r?\n/)
        .filter((line) => /\bok\b.*productization\.spec/.test(line)).length;
      return `${/(\d+)\s+passed/.exec(stdout)?.[1] ?? '?'} browser checks, ${productization} of them themes, entitlements and system`;
    });
  }

  report();
}

// --- API helpers ------------------------------------------------------------------

function scheduleBody(patch = {}) {
  return {
    dashboardId: ctx.dashboardId,
    name: 'Gate F9',
    format: 'pdf',
    period: 'last_7_days',
    comparison: 'previous_period',
    rhythm: { frequency: 'weekly', weekday: 1, time: '07:00' },
    timezone: 'Europe/Berlin',
    deliveryMode: 'attachment',
    recipientUserIds: [ctx.users.viewer, ctx.users.editor],
    ...patch,
  };
}

async function effectiveCss(token, search = '') {
  const response = await getJson(`${API_URL}/theme/effective${search ? `?${search}` : ''}`, token);
  if (response.status !== 200) throw new Error(`Effective theme answered ${response.status}.`);
  return response.body.css;
}

async function setEntitlement(entitlement, enabled) {
  const response = await fetchJson(
    `${API_URL}/admin/platform/tenants/${ctx.tenantId}/entitlements/${entitlement}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(ctx.tokens.platform) },
      body: JSON.stringify({ enabled }),
    },
  );
  if (response.status !== 200)
    throw new Error(`Setting ${entitlement} answered ${response.status}: ${response.text}`);
}

async function count(table, where) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM \`${table}\`${where ? ` WHERE ${where}` : ''}`,
  );
  return Number(rows[0].n);
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
  for (const [role, email] of Object.entries(ACCOUNTS)) ctx.tokens[role] = await signIn(email);
  ctx.tokens.platform = await signIn(ADMIN_EMAIL);
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

function putJson(url, payload, token) {
  return fetchJson(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
}

function deleteJson(url, token) {
  return fetchJson(url, { method: 'DELETE', headers: authHeaders(token) });
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
  console.log(`Gate F9: ${passed}/${results.length} criteria demonstrated.`);
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
    console.error(`\nGate F9 run aborted: ${error.message}`);
    await shutdownStack();
    process.exit(1);
  });
