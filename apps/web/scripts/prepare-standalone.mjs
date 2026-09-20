import { cp, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Completes the standalone build.
 *
 * `output: "standalone"` emits a self-contained server plus a trimmed
 * node_modules, but deliberately leaves out the static assets so a deployment
 * can serve them from a CDN. We serve them from the same process, so they are
 * copied into place here - and this is also exactly what a container image
 * would do.
 */
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STANDALONE = path.join(WEB_DIR, '.next', 'standalone', 'apps', 'web');

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

await cp(path.join(WEB_DIR, '.next', 'static'), path.join(STANDALONE, '.next', 'static'), {
  recursive: true,
});

if (await exists(path.join(WEB_DIR, 'public'))) {
  await cp(path.join(WEB_DIR, 'public'), path.join(STANDALONE, 'public'), { recursive: true });
}

console.log('Standalone server prepared at .next/standalone/apps/web/server.js');
