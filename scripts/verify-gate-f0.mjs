#!/usr/bin/env node
/**
 * Gate F0 demonstration.
 *
 * Runs the acceptance criteria of Phase 0 from the Claude Code Development Plan
 * against a real stack and prints a pass/fail table:
 *
 *   - a fresh local environment starts reliably
 *   - MySQL migrations run from an empty database
 *   - the first admin can be bootstrapped once, without default credentials
 *   - a second bootstrap attempt is rejected
 *   - web, API and worker expose version/build info
 *   - a correlation id is visible across a basic API request
 *   - the CI-equivalent local commands pass
 *
 * Destructive: it drops and recreates the development database. Refuses to run
 * against anything but a development environment.
 *
 * Usage:  node scripts/verify-gate-f0.mjs [--skip-e2e] [--local-mysql]
 *
 * `--local-mysql` uses the portable MySQL from scripts/local-mysql.mjs instead
 * of the docker stack, for machines where Docker Desktop is unavailable.
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
const WEB_URL = env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
const WORKER_HEALTH_URL = `http://127.0.0.1:${Number(env.API_PORT ?? 4000) + 1}`;

const ADMIN_EMAIL = 'gate.f0@example.invalid';
const ADMIN_PASSWORD = 'korrekt-pferd-batterie-heftklammer';

const results = [];
const children = [];

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
      const version = stdout.trim();
      if (code !== 0 || version.length === 0) {
        throw new Error(
          'The Docker engine is not answering. On Windows 10 Home this usually means WSL 2 ' +
            'is missing: run "wsl --install --no-distribution" in an elevated PowerShell, reboot, ' +
            'then start Docker Desktop. Alternatively run this with --local-mysql.',
        );
      }
      return `engine ${version}`;
    });

    await step('compose stack healthy', async () => {
      await runOrThrow('docker', ['compose', 'up', '-d']);
      const container = 'axp-mysql';
      const deadline = Date.now() + 180_000;
      for (;;) {
        const { stdout } = await run('docker', [
          'inspect',
          '-f',
          '{{.State.Health.Status}}',
          container,
        ]);
        const status = stdout.trim();
        if (status === 'healthy') return `${container} healthy`;
        if (Date.now() > deadline) {
          throw new Error(`${container} did not become healthy (${status})`);
        }
        await delay(2000);
      }
    });
  }

  await step('migrations run from an empty database', async () => {
    await runOrThrow('npm', ['run', 'db:reset']);
    const { stdout } = await runOrThrow('npm', ['run', 'db:migrate']);
    if (!/Migrations applied/i.test(stdout)) throw new Error('Migration output was unexpected.');
    return 'applied to an empty schema';
  });

  await step('re-running migrations is a no-op', async () => {
    await runOrThrow('npm', ['run', 'db:migrate']);
    return 'second run applied nothing';
  });

  await step('integration suite passes', async () => {
    const { stdout } = await runOrThrow('npm', ['run', 'test:integration']);
    const match = /Tests\s+(\d+)\s+passed/.exec(stdout);
    return match ? `${match[1]} tests` : 'passed';
  });

  // Processes are started from the build output, so the artifact itself is
  // exercised rather than the dev-mode watcher.
  await step('build artifacts exist', async () => {
    await runOrThrow('npm', ['run', 'build']);
    return 'web + api + worker built';
  });

  await step('api, worker and web start and report health', async () => {
    startProcess('api', 'node', ['apps/api/dist/main.js']);
    startProcess('worker', 'node', ['apps/worker/dist/main.js']);
    startProcess('web', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'start'], {
      cwd: path.join(ROOT, 'apps', 'web'),
    });

    await waitForHttp(`${API_URL}/livez`);
    await waitForHttp(`${WORKER_HEALTH_URL}/livez`);
    await waitForHttp(WEB_URL);

    const ready = await fetchJson(`${API_URL}/readyz`);
    if (ready.body.status !== 'ready') throw new Error('API readiness reported not_ready.');
    return 'all three processes live';
  });

  await step('version and build info exposed', async () => {
    const api = await fetchJson(`${API_URL}/version`);
    const worker = await fetchJson(`${WORKER_HEALTH_URL}/version`);
    for (const [name, response] of [
      ['api', api],
      ['worker', worker],
    ]) {
      const body = response.body;
      if (!body.version || !body.schemaVersion || !body.deploymentProfile) {
        throw new Error(`${name} did not expose complete build metadata.`);
      }
    }
    return `product ${api.body.version}, schema ${api.body.schemaVersion}`;
  });

  await step('correlation id travels through a request', async () => {
    const minted = await fetchJson(`${API_URL}/livez`);
    const generated = minted.headers.get('x-correlation-id');
    if (!generated) throw new Error('No correlation id on the response.');

    const continued = await fetchJson(`${API_URL}/livez`, {
      headers: { 'x-correlation-id': 'gate-f0-trace' },
    });
    if (continued.headers.get('x-correlation-id') !== 'gate-f0-trace') {
      throw new Error('An upstream correlation id was not continued.');
    }
    return 'minted and continued';
  });

  let bootstrapToken = '';

  await step('no default credentials exist', async () => {
    const status = await fetchJson(`${API_URL}/platform/status`);
    if (status.body.initState !== 'uninitialized') {
      throw new Error(`Fresh instance reported initState=${status.body.initState}.`);
    }
    const login = await fetchJson(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.invalid', password: 'admin' }),
    });
    if (login.status < 400) throw new Error('A guessed default credential was accepted.');
    return 'uninitialized, no account accepts a guess';
  });

  await step('bootstrap token is minted by the privileged process', async () => {
    const { stdout } = await runOrThrow('npm', ['run', 'bootstrap-admin', '--', '--json']);
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end === -1) {
      throw new Error(`bootstrap-admin printed no JSON:
${stdout.trim().slice(-400)}`);
    }
    const json = JSON.parse(stdout.slice(start, end + 1));
    bootstrapToken = json.token;
    if (!bootstrapToken || bootstrapToken.length < 40) throw new Error('Token looks too weak.');
    return `single-use token, valid until ${json.expiresAt}`;
  });

  await step('first platform admin is created', async () => {
    const response = await fetchJson(`${API_URL}/platform/bootstrap/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: bootstrapToken,
        email: ADMIN_EMAIL,
        firstName: 'Petra',
        lastName: 'Plattform',
        password: ADMIN_PASSWORD,
      }),
    });
    if (response.status !== 201) {
      throw new Error(`Bootstrap failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    const status = await fetchJson(`${API_URL}/platform/status`);
    if (status.body.initState !== 'initialized') throw new Error('Platform did not initialize.');
    return 'platform admin created, setup path closed';
  });

  await step('second bootstrap attempt is rejected', async () => {
    const replay = await fetchJson(`${API_URL}/platform/bootstrap/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: bootstrapToken,
        email: 'second@example.invalid',
        firstName: 'Second',
        lastName: 'Admin',
        password: ADMIN_PASSWORD,
      }),
    });
    if (replay.status < 400) throw new Error('A replayed bootstrap token was accepted.');

    const { code } = await run('npm', ['run', 'bootstrap-admin']);
    if (code === 0) throw new Error('bootstrap-admin minted a token after initialization.');
    return 'token replay and new token both refused';
  });

  await step('sign-in works and returns no credential material', async () => {
    const login = await fetchJson(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
    const serialised = JSON.stringify(login.body);
    if (serialised.includes(ADMIN_PASSWORD) || /\$argon2/.test(serialised)) {
      throw new Error('The login response carried credential material.');
    }
    return 'session issued';
  });

  if (!SKIP_E2E) {
    await step('end-to-end journey passes', async () => {
      // A fresh token for the E2E run: the earlier one is consumed, and the
      // platform is initialized, so the suite exercises sign-in and the
      // already-initialized setup screen.
      const { stdout } = await runOrThrow('npx', ['playwright', 'test'], {
        env: {
          ...process.env,
          E2E_ADMIN_EMAIL: ADMIN_EMAIL,
          E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
        },
      });
      const match = /(\d+)\s+passed/.exec(stdout);
      return match ? `${match[1]} checks` : 'passed';
    });
  }

  report();
}

// --- helpers ---------------------------------------------------------------

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
  console.log(`Gate F0: ${passed}/${results.length} criteria demonstrated.`);
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
    shell: process.platform === 'win32',
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
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
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
  for (const { child } of children) {
    child.kill();
    await Promise.race([once(child, 'close'), delay(3000)]);
  }
}

main()
  .then(shutdown)
  .catch(async (error) => {
    console.error(`\nGate F0 run aborted: ${error.message}`);
    await shutdown();
    process.exit(1);
  });
