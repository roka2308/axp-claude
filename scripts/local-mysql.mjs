#!/usr/bin/env node
/**
 * Portable MySQL for local development, without Docker.
 *
 * Runs MySQL from the official Oracle ZIP distribution as an ordinary user
 * process: no installer, no Windows service, no administrator rights, nothing
 * written outside `.local/` in this repository.
 *
 * `docker compose` remains the documented default (the specification asks for a
 * containerised, hosting-neutral product). This exists because Docker Desktop
 * needs WSL 2, which is not always available on a developer machine — and the
 * milestone gates need a real MySQL either way. Server settings are kept
 * identical to `docker-compose.yml` so behaviour does not differ between them.
 *
 * Usage:
 *   node scripts/local-mysql.mjs setup [--zip <path>]   extract, initialise, create databases
 *   node scripts/local-mysql.mjs start
 *   node scripts/local-mysql.mjs stop
 *   node scripts/local-mysql.mjs status
 *   node scripts/local-mysql.mjs remove                 delete the whole .local/mysql tree
 */

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  openSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = path.join(ROOT, '.local', 'mysql');
const DIST = path.join(BASE, 'dist');
const DATA = path.join(BASE, 'data');
const CONFIG = path.join(BASE, 'my.cnf');
const LOG = path.join(BASE, 'mysqld.log');

const env = readEnvFile(path.join(ROOT, '.env'));
const PORT = Number(env.MYSQL_PORT ?? 3307);
const DB = env.MYSQL_DATABASE ?? 'axp';
const TEST_DB = `${DB}_test`;
const USER = env.MYSQL_USER ?? 'axp';
const PASSWORD = env.MYSQL_PASSWORD ?? 'axp_dev';
const ROOT_PASSWORD = env.MYSQL_ROOT_PASSWORD ?? 'axp_root_dev';

const command = process.argv[2] ?? 'status';

const commands = { setup, start, stop, status, remove };

if (!commands[command]) {
  console.error(`Unknown command "${command}". Use setup | start | stop | status | remove.`);
  process.exit(2);
}

await commands[command]();

// --- commands --------------------------------------------------------------

async function setup() {
  if (!existsSync(binDir())) {
    const zip = resolveZipPath();
    console.log(`Extracting ${path.basename(zip)} …`);
    mkdirSync(DIST, { recursive: true });
    extractZip(zip, DIST);
  }

  const mysqld = binary('mysqld');
  if (!existsSync(mysqld)) throw new Error(`mysqld not found at ${mysqld}`);
  console.log(`Server: ${runCapture(mysqld, ['--version']).trim()}`);

  writeConfig();

  if (!existsSync(path.join(DATA, 'mysql'))) {
    console.log('Initialising the data directory …');
    mkdirSync(DATA, { recursive: true });
    // `--initialize-insecure` creates root without a password; a real password
    // is set below, before anything else can connect.
    const init = runCapture(mysqld, [`--defaults-file=${CONFIG}`, '--initialize-insecure'], {
      allowFailure: true,
    });
    if (!existsSync(path.join(DATA, 'mysql'))) {
      throw new Error(`Initialisation failed.\n${init}\n${tailLog()}`);
    }
  }

  await start();

  console.log('Creating databases and the application account …');
  await sql(
    [
      `CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
      `CREATE DATABASE IF NOT EXISTS \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
      `CREATE USER IF NOT EXISTS '${USER}'@'%' IDENTIFIED BY '${PASSWORD}';`,
      `ALTER USER '${USER}'@'%' IDENTIFIED BY '${PASSWORD}';`,
      `GRANT ALL PRIVILEGES ON \`${DB}\`.* TO '${USER}'@'%';`,
      `GRANT ALL PRIVILEGES ON \`${TEST_DB}\`.* TO '${USER}'@'%';`,
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${ROOT_PASSWORD}';`,
      'FLUSH PRIVILEGES;',
    ].join('\n'),
    { rootWithoutPassword: true },
  );

  console.log('');
  console.log(`  MySQL ready on 127.0.0.1:${PORT}`);
  console.log(`  Databases: ${DB} (development), ${TEST_DB} (integration tests)`);
  console.log(`  Matches DATABASE_URL in .env — no configuration change needed.`);
  console.log('');
}

async function start() {
  if (await isListening()) {
    console.log(`MySQL already listening on port ${PORT}.`);
    return;
  }
  if (!existsSync(binary('mysqld'))) throw new Error('Not set up yet — run: setup');

  writeConfig();
  mkdirSync(BASE, { recursive: true });

  const out = openSync(LOG, 'a');
  const child = spawn(binary('mysqld'), [`--defaults-file=${CONFIG}`], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 90_000;
  while (!(await isListening())) {
    if (Date.now() > deadline) throw new Error(`mysqld did not start.\n${tailLog()}`);
    await delay(500);
  }
  console.log(`MySQL listening on 127.0.0.1:${PORT} (pid ${child.pid}).`);
}

async function stop() {
  if (!(await isListening())) {
    console.log('MySQL is not running.');
    return;
  }
  runCapture(
    binary('mysqladmin'),
    [
      '--protocol=TCP',
      '-h',
      '127.0.0.1',
      '-P',
      String(PORT),
      '-u',
      'root',
      `-p${ROOT_PASSWORD}`,
      'shutdown',
    ],
    { allowFailure: true },
  );

  const deadline = Date.now() + 30_000;
  while (await isListening()) {
    if (Date.now() > deadline) throw new Error('MySQL did not shut down.');
    await delay(500);
  }
  console.log('MySQL stopped.');
}

async function status() {
  const running = await isListening();
  console.log(
    running
      ? `MySQL is listening on 127.0.0.1:${PORT}.`
      : existsSync(binary('mysqld'))
        ? 'MySQL is set up but not running. Start it with: npm run db:local:start'
        : 'MySQL is not set up. Run: npm run db:local:setup',
  );
  process.exitCode = running ? 0 : 1;
}

async function remove() {
  if (await isListening()) await stop();
  rmSync(BASE, { recursive: true, force: true });
  console.log(`Removed ${BASE}.`);
}

// --- helpers ---------------------------------------------------------------

/**
 * Server settings mirror docker-compose.yml exactly. A difference here would
 * make behaviour depend on which backend a developer happens to run.
 */
function writeConfig() {
  mkdirSync(BASE, { recursive: true });
  writeFileSync(
    CONFIG,
    [
      '[mysqld]',
      `basedir=${toIni(distRoot())}`,
      `datadir=${toIni(DATA)}`,
      `port=${PORT}`,
      'bind-address=127.0.0.1',
      // Name resolution stays on: MySQL creates root@localhost, and a TCP
      // connection from 127.0.0.1 only matches that account once the address
      // resolves. docker-compose does not disable it either.
      'character-set-server=utf8mb4',
      'collation-server=utf8mb4_0900_ai_ci',
      'default-time-zone=+00:00',
      'sql-mode=STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
      `log-error=${toIni(LOG)}`,
      // A development footprint, not a production tuning profile.
      'innodb-buffer-pool-size=256M',
      'max-connections=151',
      '',
      '[client]',
      `port=${PORT}`,
      'protocol=TCP',
      '',
    ].join('\n'),
    'utf8',
  );
}

function distRoot() {
  // The archive unpacks into a single versioned directory.
  const entries = existsSync(DIST)
    ? readdirSync(DIST, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  const versioned = entries.find((entry) => entry.name.startsWith('mysql-'));
  return versioned ? path.join(DIST, versioned.name) : DIST;
}

function binDir() {
  return path.join(distRoot(), 'bin');
}

function binary(name) {
  return path.join(binDir(), process.platform === 'win32' ? `${name}.exe` : name);
}

function toIni(value) {
  return value.replace(/\\/g, '/');
}

function resolveZipPath() {
  const flagIndex = process.argv.indexOf('--zip');
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];

  const scratch = process.env.CLAUDE_SCRATCHPAD ?? path.join(ROOT, '.local');
  const candidates = [scratch, path.join(ROOT, '.local')]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => /^mysql-.*winx64\.zip$/.test(file))
        .map((file) => path.join(dir, file)),
    );

  if (candidates.length === 0) {
    throw new Error(
      'No MySQL ZIP found. Download mysql-8.4.x-winx64.zip from dev.mysql.com and pass it with --zip <path>.',
    );
  }
  return candidates[0];
}

function extractZip(zip, destination) {
  if (process.platform === 'win32') {
    // bsdtar would read a "C:/..." argument as host:path, so use PowerShell.
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${zip}' -DestinationPath '${destination}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    if (ps.status !== 0) throw new Error('Could not extract the MySQL archive.');
    return;
  }

  const tar = spawnSync('tar', ['-xf', zip, '-C', destination], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Could not extract the MySQL archive.');
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input: options.input });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${path.basename(command)} exited ${result.status}\n${output}`);
  }
  return output;
}

async function sql(statements, options = {}) {
  const args = [
    '--protocol=TCP',
    '-h',
    '127.0.0.1',
    '-P',
    String(PORT),
    '-u',
    'root',
    ...(options.rootWithoutPassword ? [] : [`-p${ROOT_PASSWORD}`]),
  ];
  return runCapture(binary('mysql'), args, { input: statements });
}

function isListening() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

function tailLog() {
  try {
    return readFileSync(LOG, 'utf8').split('\n').slice(-25).join('\n');
  } catch {
    return '(no log output)';
  }
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
