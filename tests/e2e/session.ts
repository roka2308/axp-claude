import path from 'node:path';

/**
 * Shared end-to-end fixture parameters.
 *
 * A plain module rather than a spec: Playwright refuses to let one test file
 * import another, and both the setup project and the specs need these.
 */

const AUTH_DIR = path.join('tests', 'e2e', '.auth');

/** Demo accounts, by the role each one is used to exercise. */
export const DEMO_ACCOUNTS = {
  viewer: {
    email: process.env.E2E_VIEWER_EMAIL ?? process.env.E2E_ADMIN_EMAIL,
    state: path.join(AUTH_DIR, 'viewer.json'),
  },
  editor: {
    email: process.env.E2E_EDITOR_EMAIL ?? 'editor.demo@example.invalid',
    state: path.join(AUTH_DIR, 'editor.json'),
  },
  tenantAdmin: {
    email: process.env.E2E_TENANT_ADMIN_EMAIL ?? 'tenantadmin.demo@example.invalid',
    state: path.join(AUTH_DIR, 'tenant-admin.json'),
  },
  semanticManager: {
    email: process.env.E2E_SEMANTIC_EMAIL ?? 'semantic.demo@example.invalid',
    state: path.join(AUTH_DIR, 'semantic.json'),
  },
} as const;

/** Where `auth.setup.ts` stores the signed-in viewer session. */
export const VIEWER_STATE = DEMO_ACCOUNTS.viewer.state;
export const EDITOR_STATE = DEMO_ACCOUNTS.editor.state;
export const TENANT_ADMIN_STATE = DEMO_ACCOUNTS.tenantAdmin.state;
export const SEMANTIC_STATE = DEMO_ACCOUNTS.semanticManager.state;

export const VIEWER_EMAIL = DEMO_ACCOUNTS.viewer.email;

export const VIEWER_PASSWORD =
  process.env.E2E_VIEWER_PASSWORD ??
  process.env.E2E_ADMIN_PASSWORD ??
  'korrekt-pferd-batterie-heftklammer';

export const PROJECT_NAME = process.env.E2E_PROJECT_NAME ?? 'Employee Portal';
export const DASHBOARD_NAME = process.env.E2E_DASHBOARD_NAME ?? 'Portal Overview';

/** The token `seedReferenceDashboard` stores for the demo mock connection. */
export const DEMO_MATOMO_TOKEN =
  process.env.E2E_DEMO_MATOMO_TOKEN ?? 'demo-token-not-a-real-credential';

export const FIXTURE_SKIP_REASON =
  'Set E2E_VIEWER_EMAIL/E2E_VIEWER_PASSWORD from `npm run seed:demo -- --json`.';

/**
 * A name nothing else in the database will collide with.
 *
 * The setup journey writes real rows into the demo fixture, and connection
 * names are unique per tenant - a suite that could only run once would not be
 * a suite.
 */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}
