import path from 'node:path';

/**
 * Shared end-to-end fixture parameters.
 *
 * A plain module rather than a spec: Playwright refuses to let one test file
 * import another, and both the setup project and the viewer specs need these.
 */

/** Where `auth.setup.ts` stores the signed-in session. */
export const VIEWER_STATE = path.join('tests', 'e2e', '.auth', 'viewer.json');

export const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL ?? process.env.E2E_ADMIN_EMAIL;

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
